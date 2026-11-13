import fs from "node:fs";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { dataDir } from "./data";
import { dailyCandles, instrumentToken } from "./kite";
import type { Candle } from "./technicals";
import { yahooCandles } from "./yahoo";

// Local candle cache (data/cache/candles, gitignored). After the first backfill each run only asks for the
// days since the last cached close, which keeps refreshes fast and polite to the data source.
const dir = () => path.join(dataDir(), "data", "cache", "candles");
const fileOf = (id: string) => path.join(dir(), id.replace(/[^A-Za-z0-9]+/g, "_") + ".json");

// Candles are dated by the Indian trading day, so "today" must be the IST date, not the UTC one.
const istToday = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);

function readCache(id: string): Candle[] {
  try { return JSON.parse(fs.readFileSync(fileOf(id), "utf8")).candles ?? []; } catch { return []; }
}

function merge(a: Candle[], b: Candle[]): Candle[] {
  const byDate = new Map<string, Candle>();
  for (const c of [...a, ...b]) if (Number.isFinite(c.close) && c.close > 0) byDate.set(c.date, c);
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

/**
 * Yahoo is the default source because Kite's historical candles need the paid Connect plan. If Yahoo fails and
 * a Kite client is available (a Connect subscriber), fall back to Kite's historical tool.
 */
async function fetchRange(id: string, from: Date, to: Date, kite?: Client): Promise<Candle[]> {
  try {
    return await yahooCandles(id, from, to);
  } catch (yahooError) {
    if (!kite) throw yahooError;
    const token = await instrumentToken(kite, id);
    if (!token) throw yahooError;
    return dailyCandles(kite, token, from, to);
  }
}

/** Daily candles covering at least `years` back up to today, served from cache and topped up from the source. */
export async function getCandles(id: string, years = 2, kite?: Client): Promise<Candle[]> {
  const today = istToday();
  const wantFrom = new Date(Date.now() - years * 365.25 * 864e5);
  let cached = readCache(id);

  if (!cached.length || cached[0].date > wantFrom.toISOString().slice(0, 10)) {
    const until = cached.length ? new Date(new Date(cached[0].date).getTime() - 864e5) : new Date();
    cached = merge(await fetchRange(id, wantFrom, until, kite), cached);
  }
  const last = cached.at(-1)?.date;
  const fresh = last && last < today ? await fetchRange(id, new Date(new Date(last).getTime() + 864e5), new Date(), kite) : [];
  const all = merge(cached, fresh);

  // Today's candle is still forming during market hours; keep it for this run but never persist it,
  // or the cache would freeze an intraday price as the day's close.
  const settled = all.filter((c) => c.date < today);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(fileOf(id), JSON.stringify({ id, candles: settled }));
  return all;
}
