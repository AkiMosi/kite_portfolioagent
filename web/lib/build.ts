import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getCandles } from "./candles";
import { dataDir, loadRules } from "./data";
import { callHoldings, connect, disconnect } from "./kite";
import { assembleReport, screenStock, type FundamentalsRow, type HoldingRow } from "./screen";
import { computeTechnicals } from "./technicals";
import type { Report, ScreenResult } from "./types";

export type Built = { file: string; report: Report; missing: string[]; fetchedAt: string };
export type Build = { status: "auth"; authUrl: string } | ({ status: "ok" } & Built);

/** A holdings row as Kite returns it (portfolio mode=holdings, type=full). */
export type RawHolding = Record<string, unknown>;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function loadFundamentals(): Record<string, FundamentalsRow> {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "data", "fundamentals.json"), "utf8")); } catch { return {}; }
}

export function toHoldingRows(raw: RawHolding[]): HoldingRow[] {
  return raw.flatMap((h) => {
    // T1 shares are bought but not yet delivered; they are still the client's position.
    const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
    if (!qty) return [];
    const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
    return [{ id: `${h.exchange}:${h.tradingsymbol}`, qty, avg: r2(avg), ltp, value: r2(qty * ltp), cost: r2(qty * avg) }];
  });
}

/**
 * Build today's screen from Kite holding rows: daily candles (Yahoo, Kite as optional fallback), fundamentals
 * from data/fundamentals.json, thresholds from screen-rules.json. Universe = holdings plus every stock in
 * fundamentals.json (the watchlist the entry planner picks from). Shared by the web app and the routine CLI,
 * which gets its holdings from the Kite connector instead of the app's own OAuth login.
 */
export async function buildFromHoldings(raw: RawHolding[], kiteFallback?: Client): Promise<Built> {
  const rules = loadRules();
  const fundamentals = loadFundamentals();
  const holdings = toHoldingRows(raw);
  const held = new Map(holdings.map((h) => [h.id, h]));
  const heldSymbols = new Set(holdings.map((h) => h.id.split(":")[1]));
  const watch = Object.keys(fundamentals).filter((s) => !heldSymbols.has(s)).map((s) => `NSE:${s}`);

  const nifty = computeTechnicals(await getCandles("NSE:NIFTY 50", 2, kiteFallback));
  if (!nifty) throw new Error("Not enough NIFTY 50 history to compute the market regime.");

  const missing: string[] = [];
  const results: ScreenResult[] = [];
  for (const id of [...held.keys(), ...watch]) {
    const symbol = id.split(":")[1];
    let technicals = null;
    let lastClose = 0;
    try {
      const candles = await getCandles(id, 2, kiteFallback);
      technicals = computeTechnicals(candles);
      lastClose = candles.at(-1)?.close ?? 0;
      if (!technicals) missing.push(`${symbol} (under 200 days of history)`);
    } catch (e) {
      missing.push(`${symbol} (${(e as Error).message})`);
    }
    const h = held.get(id);
    results.push(screenStock({
      id, sources: h ? ["holding"] : ["watchlist"], ltp: h?.ltp ?? lastClose, technicals, fundamentals: fundamentals[symbol],
      holding: h ? { quantity: h.qty, average_price: h.avg, pnl: r2(h.value - h.cost), pnl_pct: h.cost ? r2(((h.value - h.cost) / h.cost) * 100) : 0 } : undefined,
    }, rules));
  }

  const now = new Date();
  const report = assembleReport(nifty, holdings, results, rules, now);
  // Name the file by the Indian trading day; the routine runs in a UTC sandbox.
  const day = new Date(now.getTime() + 5.5 * 36e5).toISOString().slice(0, 10);
  const file = `screen-${day}.json`;
  const reportsDir = path.join(dataDir(), "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, file), JSON.stringify(report, null, 2));
  return { file, report, missing, fetchedAt: now.toISOString() };
}

/** Web app path: log in to Kite through the app's own MCP OAuth, fetch holdings, build the screen. */
export async function buildScreen(): Promise<Build> {
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  try {
    const raw = await callHoldings(c.client);
    // Kite historical candles need the paid Connect plan; only pass the client as a fallback when the user has it.
    const built = await buildFromHoldings(raw, process.env.KITE_HISTORICAL === "1" ? c.client : undefined);
    return { status: "ok", ...built };
  } catch (e) {
    disconnect();
    throw e;
  }
}
