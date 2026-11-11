import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Analysis } from "./types";

const MCP_URL = process.env.GMAIL_MCP_URL || "";
const REDIRECT = process.env.GMAIL_OAUTH_REDIRECT || "http://localhost:3000/api/gmail/callback";
const STORE = path.resolve(process.cwd(), ".gmail-oauth.json"); // OAuth tokens: gitignored

type Store = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
const read = (): Store => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } };
const write = (s: Store) => fs.writeFileSync(STORE, JSON.stringify(s, null, 2));

class Provider implements OAuthClientProvider {
  authUrl: URL | null = null;
  get redirectUrl() { return REDIRECT; }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Portfolio Agent (local, Gmail)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() { return read().client; }
  saveClientInformation(c: OAuthClientInformationMixed) { write({ ...read(), client: c }); }
  tokens() { return read().tokens; }
  saveTokens(t: OAuthTokens) { write({ ...read(), tokens: t }); }
  saveCodeVerifier(v: string) { write({ ...read(), verifier: v }); }
  codeVerifier() { return read().verifier ?? ""; }
  redirectToAuthorization(u: URL) { this.authUrl = u; }
}

const g = globalThis as unknown as { __gmail?: Client | null; __gmailPending?: { transport: StreamableHTTPClientTransport; provider: Provider } | null };

async function connect(): Promise<{ client: Client } | { authUrl: string }> {
  if (g.__gmail) return { client: g.__gmail };
  const provider = new Provider();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: provider });
  const client = new Client({ name: "portfolio-agent", version: "0.1.0" });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError && provider.authUrl) {
      g.__gmailPending = { transport, provider };
      return { authUrl: provider.authUrl.toString() };
    }
    throw e;
  }
  g.__gmail = client;
  return { client };
}

export async function finishGmailAuth(code: string) {
  const p = g.__gmailPending;
  if (!p) throw new Error("No pending Gmail login. Click Run agents again.");
  await p.transport.finishAuth(code);
  g.__gmailPending = null;
}

export function buildReport(analyses: Analysis[], brief: string | null) {
  const day = new Date().toISOString().slice(0, 10);
  const rows = [...analyses].sort((a, b) => b.combined - a.combined);
  const body = [
    `Portfolio agent report, ${day}`,
    "This is a rule-based screen plus news sentiment, not investment advice.",
    "",
    brief ? `Brief\n${brief}\n` : "",
    "Per-holding results",
    ...rows.map((a) => `- ${a.symbol}: ${a.stance} | quant ${a.quantScore}, news ${a.newsScore}, combined ${a.combined}${a.reviewNotes.length ? `\n    Flags: ${a.reviewNotes.join(" ")}` : ""}`),
    "",
    "Conflicts (quant vs news): " + (rows.filter((a) => a.stance === "Conflicting: review").map((a) => a.symbol).join(", ") || "none"),
  ].join("\n");
  return { subject: `Portfolio agent report ${day}`, body };
}

export type DraftResult = { status: "auth"; authUrl: string } | { status: "drafted"; subject: string } | { status: "unconfigured" };

/** Create a Gmail draft (no recipient) through the Gmail MCP server. Never sends. */
export async function createDraft(analyses: Analysis[], brief: string | null): Promise<DraftResult> {
  if (!MCP_URL) return { status: "unconfigured" };
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  const { subject, body } = buildReport(analyses, brief);
  try {
    const tools = (await c.client.listTools()).tools;
    const tool = tools.find((t) => /create.*draft|draft.*create/i.test(t.name)) ?? tools.find((t) => /draft/i.test(t.name) && !/(delete|get|list|update|send)/i.test(t.name));
    if (!tool) throw new Error(`No draft tool found. Server offers: ${tools.map((t) => t.name).join(", ")}`);
    const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const pick = (re: RegExp) => props.find((p) => re.test(p));
    const args: Record<string, unknown> = {};
    args[pick(/^subject$/i) ?? "subject"] = subject;
    args[pick(/^(body|content|text|message)$/i) ?? "body"] = body;
    const res = await c.client.callTool({ name: tool.name, arguments: args });
    if ((res as { isError?: boolean }).isError) {
      const t = ((res as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? "").join("");
      throw new Error(t || "Gmail returned an error");
    }
    return { status: "drafted", subject };
  } catch (e) {
    g.__gmail?.close().catch(() => {});
    g.__gmail = null;
    throw e;
  }
}
