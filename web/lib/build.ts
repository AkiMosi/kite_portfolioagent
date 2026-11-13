import fs from "node:fs";
import path from "node:path";
import { getCandles } from "./candles";
import { dataDir, loadRules } from "./data";
import { callHoldings, connect, disconnect } from "./kite";
import { assembleReport, screenStock, type FundamentalsRow, type HoldingRow } from "./screen";
import { computeTechnicals } from "./technicals";
import type { Report, ScreenResult } from "./types";

export type Build =
  | { status: "auth"; authUrl: string }
  | { status: "ok"; file: string; report: Report; missing: string[]; fetchedAt: string };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function loadFundamentals(): Record<string, FundamentalsRow> {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "data", "fundamentals.json"), "utf8")); } catch { return {}; }
}

/**
 * Build today's screen from scratch: live holdings + daily candles from Kite, fundamentals from
 * data/fundamentals.json, thresholds from screen-rules.json. Universe = holdings plus every stock in
 * fundamentals.json (the watchlist the entry planner picks from).
 */
export async function buildScreen(): Promise<Build> {
  const c = await connect();
  if ("authUrl" in c) return { status: "auth", authUrl: c.authUrl };
  const client = c.client;
  const rules = loadRules();
  const fundamentals = loadFundamentals();

  try {
    const raw = await callHoldings(client);
    const holdings: HoldingRow[] = raw.flatMap((h) => {
      const qty = Number(h.quantity) + Number(h.t1_quantity ?? 0);
      if (!qty) return [];
      const avg = Number(h.average_price), ltp = Number(h.last_price) || Number(h.close_price);
      return [{ id: `${h.exchange}:${h.tradingsymbol}`, qty, avg: r2(avg), ltp, value: r2(qty * ltp), cost: r2(qty * avg) }];
    });
    const held = new Map(holdings.map((h) => [h.id, h]));
    const heldSymbols = new Set(holdings.map((h) => h.id.split(":")[1]));
    const watch = Object.keys(fundamentals).filter((s) => !heldSymbols.has(s)).map((s) => `NSE:${s}`);

    // Kite historical candles need the paid Connect plan; only pass the client as a fallback when the user has it.
    const kiteFallback = process.env.KITE_HISTORICAL === "1" ? client : undefined;
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
    const day = new Date(now.getTime() - now.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const file = `screen-${day}.json`;
    const reportsDir = path.join(dataDir(), "reports");
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, file), JSON.stringify(report, null, 2));
    return { status: "ok", file, report, missing, fetchedAt: now.toISOString() };
  } catch (e) {
    disconnect();
    throw e;
  }
}
