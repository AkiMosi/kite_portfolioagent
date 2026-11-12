import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { dataDir } from "./data";
import type { Report } from "./types";

const MCP_URL = process.env.KITE_MCP_URL || "https://mcp.kite.trade/mcp";
const REDIRECT = process.env.KITE_OAUTH_REDIRECT || "http://localhost:3000/api/kite/callback";
const STORE = path.resolve(process.cwd(), ".kite-oauth.json"); // holds OAuth tokens: gitignored

type Store = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
const read = (): Store => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } };
const write = (s: Store) => fs.writeFileSync(STORE, JSON.stringify(s, null, 2));

class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Portfolio Agent (local)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return read().client; }
  saveClientInformation(c: OAuthClientInformationMixed) { write({ ...read(), client: c }); }
  tokens() { return read().tokens; }
  saveTokens(t: OAuthTokens) { write({ ...read(), tokens: t }); }
  saveCodeVerifier(v: string) { write({ ...read(), verifier: v }); }
  codeVerifier() { return read().verifier ?? ""; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
}

// Survive Next dev hot reloads: keep the live client/transport on globalThis.
const g = globalThis as unknown as { __kite?: { client: Client; provider: Provider } | null; __kitePending?: { transport: StreamableHTTPClientTransport; provider: Provider } | null };

export type Connect = { client: Client } | { authUrl: string };

export async function connect(): Promise<Connect> {
  if (g.__kite) return { client: g.__kite.client };
  const provider = new Provider();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: "portfolio-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError && provider.authUrl) {
      g.__kitePending = { transport, provider };
      return { authUrl: provider.authUrl.toString() };
    }
    throw e;
  }
  g.__kite = { client, provider };
  return { client };
}

/** Called by the OAuth redirect: exchange the code, then the next connect() succeeds. */
export async function finishAuth(code: string) {
  const p = g.__kitePending;
  if (!p) throw new Error("No pending Kite login. Click Run agents again.");
  await p.transport.finishAuth(code);
  g.__kitePending = null;
}

export function disconnect() {
  g.__kite?.client.close().catch(() => {});
  g.__kite = null;
}

type Raw = Record<string, unknown>;
function textOf(res: unknown): string {
  const c = (res as { content?: { type: string; text?: string }[] }).content ?? [];
  return c.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

type Tool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
const toolCache = new WeakMap<Client, Tool[]>();
async function toolsOf(client: Client): Promise<Tool[]> {
  const hit = toolCache.get(client);
  if (hit) return hit;
  const tools = (await client.listTools()).tools;
  toolCache.set(client, tools);
  return tools;
}

/** Call a tool and return its rows, following {data, pagination} pages when the server uses them. */
async function callRows(client: Client, name: string, args: Record<string, unknown>): Promise<Raw[]> {
  const all: Raw[] = [];
  for (let from = 0, guard = 0; guard < 50; guard++) {
    const res = await client.callTool({ name, arguments: from ? { ...args, from } : args });
    const text = textOf(res);
    if ((res as { isError?: boolean }).isError) throw new Error(text || `${name} returned an error`);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error(text.slice(0, 300) || `${name} returned non-JSON`); }
    const data = Array.isArray(json) ? json : (json as { data?: unknown }).data;
    const rows = Array.isArray(data) ? data : data && typeof data === "object" ? [data as Raw] : [];
    all.push(...(rows as Raw[]));
    const pg = (json as { pagination?: { has_more?: boolean; returned?: number } }).pagination;
    if (!pg?.has_more) break;
    from += pg.returned ?? rows.length;
  }
  return all;
}

/** Map our intent onto whatever argument names the server's schema uses. */
function argsFor(tool: Tool, wanted: [RegExp, unknown][]): Record<string, unknown> {
  const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  const out: Record<string, unknown> = {};
  for (const [re, v] of wanted) { const p = props.find((x) => re.test(x)); if (p) out[p] = v; }
  return out;
}

// NIFTY 50's index token is fixed by the exchange; instrument search for indices is unreliable across servers.
const KNOWN_TOKENS: Record<string, number> = { "NSE:NIFTY 50": 256265 };
const TOKENS_FILE = () => path.join(dataDir(), "data", "cache", "instruments.json");

/** Resolve "NSE:ITC" to Kite's instrument_token, caching the mapping on disk. */
export async function instrumentToken(client: Client, id: string): Promise<number | null> {
  if (KNOWN_TOKENS[id]) return KNOWN_TOKENS[id];
  let cache: Record<string, number> = {};
  try { cache = JSON.parse(fs.readFileSync(TOKENS_FILE(), "utf8")); } catch { /* first run */ }
  if (cache[id]) return cache[id];
  const tools = await toolsOf(client);
  const direct = tools.find((t) => /search_instruments|instruments/i.test(t.name));
  const market = tools.find((t) => t.name === "market");
  if (!direct && !market) throw new Error(`Kite MCP has no instrument search tool. Server offers: ${tools.map((t) => t.name).join(", ")}`);
  const [exchange, symbol] = id.split(":");
  // The hosted server folds search into its consolidated "market" tool (mode "search", exact lookup by id).
  const rows = direct
    ? await callRows(client, direct.name, argsFor(direct, [[/^query$/i, id], [/^filter_on$/i, "id"], [/^limit$/i, 5]]))
    : await callRows(client, market!.name, { mode: "search", search_mode: "get_by_id", id });
  const hit = rows.find((r) => r.exchange === exchange && r.tradingsymbol === symbol) ?? rows.find((r) => r.id === id);
  const token = hit ? Number(hit.instrument_token) : null;
  if (token) {
    cache[id] = token;
    fs.mkdirSync(path.dirname(TOKENS_FILE()), { recursive: true });
    fs.writeFileSync(TOKENS_FILE(), JSON.stringify(cache, null, 2));
  }
  return token;
}

export type RawCandle = { date: string; open: number; high: number; low: number; close: number; volume: number };

// Kite caps one daily-candle request at 2000 days; stay under it.
const MAX_DAYS_PER_CALL = 1900;
const kiteDate = (d: Date) => d.toISOString().slice(0, 10) + " 00:00:00";

/** Daily candles for [from, to] from the Kite MCP historical-data tool, chunked under Kite's per-call cap. */
export async function dailyCandles(client: Client, token: number, from: Date, to: Date): Promise<RawCandle[]> {
  const tools = await toolsOf(client);
  const direct = tools.find((t) => /historical/i.test(t.name));
  const market = tools.find((t) => t.name === "market");
  if (!direct && !market) throw new Error(`Kite MCP has no historical data tool. Server offers: ${tools.map((t) => t.name).join(", ")}`);
  const out: RawCandle[] = [];
  for (let start = new Date(from); start <= to; ) {
    const end = new Date(Math.min(to.getTime(), start.getTime() + MAX_DAYS_PER_CALL * 864e5));
    // The hosted server's consolidated "market" tool takes mode "historical" and plain YYYY-MM-DD dates.
    const rows = direct
      ? await callRows(client, direct.name, argsFor(direct, [
          [/instrument_token|^token$/i, token], [/^from(_date)?$/i, kiteDate(start)], [/^to(_date)?$/i, kiteDate(end)], [/^interval$/i, "day"],
        ]))
      : await callRows(client, market!.name, {
          mode: "historical", instrument_token: token, interval: "day", from_date: kiteDate(start).slice(0, 10), to_date: kiteDate(end).slice(0, 10),
        });
    for (const r of rows as unknown[]) {
      const c = (Array.isArray(r) ? { date: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] } : r) as Raw;
      out.push({ date: String(c.date).slice(0, 10), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume ?? 0) });
    }
    start = new Date(end.getTime() + 864e5);
    // Kite allows ~3 historical requests per second; pace calls so long backfills don't get throttled.
    await new Promise((res) => setTimeout(res, 350));
  }
  return out;
}

export async function callHoldings(client: Client): Promise<Raw[]> {
  const tools = (await client.listTools()).tools;
  const direct = tools.find((t) => /^(get_)?holdings$/.test(t.name));
  const consolidated = tools.find((t) => t.name === "portfolio");
  if (!direct && !consolidated) throw new Error(`No holdings tool found. Server offers: ${tools.map((t) => t.name).join(", ")}`);
  const all: Raw[] = [];
  for (let from = 0, guard = 0; guard < 20; guard++) {
    const res = await client.callTool(direct ? { name: direct.name, arguments: {} } : { name: "portfolio", arguments: { mode: "holdings", from } });
    const text = textOf(res);
    if ((res as { isError?: boolean }).isError) throw new Error(text || "Kite returned an error");
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error(text.slice(0, 300) || "Kite returned non-JSON"); }
    const data = Array.isArray(json) ? json : (json as { data?: Raw[] }).data;
    if (!Array.isArray(data)) throw new Error("Unexpected holdings response shape");
    all.push(...data);
    const pg = (json as { pagination?: { has_more?: boolean; returned?: number } }).pagination;
    if (!pg?.has_more) break;
    from += pg.returned ?? data.length;
  }
  return all;
}

export type Refresh =
  | { status: "auth"; authUrl: string }
  | { status: "ok"; file: string; report: Report; missing: string[]; fetchedAt: string };

/** Fetch live holdings from the Kite MCP server and write them into today's screen report. */
export async function refreshHoldings(latest: { report: Report; file: string }): Promise<Refresh> {
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  let raw: Raw[];
  try { raw = await callHoldings(c.client); } catch (e) { disconnect(); throw e; }

  const known = new Set(latest.report.results.map((r) => r.id));
  const missing: string[] = [];
  const hs = raw.flatMap((h) => {
    const id = `${h.exchange}:${h.tradingsymbol}`;
    const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
    if (!qty) return [];
    if (!known.has(id)) { missing.push(id); return []; }
    const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
    return [{ id, qty, avg: Math.round(avg * 100) / 100, ltp, value: Math.round(qty * ltp * 100) / 100, cost: Math.round(qty * avg * 100) / 100 }];
  }).sort((a, b) => b.value - a.value);
  if (!hs.length) throw new Error("Kite returned no holdings that match the screened stocks.");

  const now = new Date();
  const report: Report = {
    ...latest.report,
    generated_at: now.toISOString(),
    holdings_by_value: hs,
    holdings_total_value: Math.round(hs.reduce((a, b) => a + b.value, 0) * 100) / 100,
    holdings_total_cost: Math.round(hs.reduce((a, b) => a + b.cost, 0) * 100) / 100,
  };
  const day = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const file = `screen-${day}.json`;
  fs.writeFileSync(path.join(dataDir(), "reports", file), JSON.stringify(report, null, 2));
  return { status: "ok", file, report, missing, fetchedAt: now.toISOString() };
}
