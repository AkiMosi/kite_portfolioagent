import type { Candle } from "./technicals";

// Daily candles from Yahoo Finance's public chart endpoint. No key, no login.
// Why not Kite: historical candles are part of Kite's paid Connect plan (₹500/month); the free Personal plan
// behind the hosted MCP answers holdings, search and today's OHLC but returns "Insufficient permission" for
// historical data, so Kite cannot supply the 200+ days the screen needs without a paid add-on.
// Caveat: this endpoint is unofficial and for personal use under Yahoo's terms; keep it out of any client-facing product.
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";

// Yahoo names NSE indices differently from Kite; extend this map when another index is screened.
const INDEX_SYMBOLS: Record<string, string> = { "NSE:NIFTY 50": "^NSEI", "NSE:NIFTY BANK": "^NSEBANK" };

/**
 * Yahoo tickers to try for a Kite id, best first. The NSE listing comes first even for BSE holdings: it is the
 * same company and price, and Yahoo's BSE history is often short (HDFCBANK.BO had under 200 days). BSE is the
 * fallback because Yahoo is missing some recent NSE listings (e.g. NSDL) that it carries on BSE.
 */
export function yahooSymbols(id: string): string[] {
  if (INDEX_SYMBOLS[id]) return [INDEX_SYMBOLS[id]];
  const symbol = id.split(":")[1];
  return [`${symbol}.NS`, `${symbol}.BO`];
}

type ChartResult = {
  meta: { gmtoffset?: number };
  timestamp?: number[];
  indicators: { quote: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] };
};

async function fetchChart(ticker: string, from: Date, to: Date): Promise<Candle[]> {
  const url = `${CHART}${encodeURIComponent(ticker)}?period1=${Math.floor(from.getTime() / 1000)}&period2=${Math.floor(to.getTime() / 1000)}&interval=1d`;
  // Yahoo rejects requests without a browser-like user agent.
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (portfolio-screen)" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo ${ticker}: HTTP ${res.status}`);
  const json = (await res.json()) as { chart?: { result?: ChartResult[] | null; error?: { description?: string } | null } };
  const r = json.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo ${ticker}: ${json.chart?.error?.description ?? "no data"}`);
  const q = r.indicators.quote[0];
  // Timestamps are the session open in UTC; shifting by the exchange offset gives the IST trading date.
  const offset = (r.meta.gmtoffset ?? 19800) * 1000;
  const out: Candle[] = [];
  (r.timestamp ?? []).forEach((ts, i) => {
    const close = q.close[i];
    if (close == null || !Number.isFinite(close)) return; // Yahoo leaves null rows on holidays and halts
    out.push({
      date: new Date(ts * 1000 + offset).toISOString().slice(0, 10),
      open: q.open[i] ?? close, high: q.high[i] ?? close, low: q.low[i] ?? close, close, volume: q.volume[i] ?? 0,
    });
  });
  return out;
}

/** Daily candles for a Kite id ("NSE:ITC", "NSE:NIFTY 50") between two dates, trying each Yahoo ticker in turn. */
export async function yahooCandles(id: string, from: Date, to: Date): Promise<Candle[]> {
  let lastError: Error | null = null;
  for (const ticker of yahooSymbols(id)) {
    try {
      const candles = await fetchChart(ticker, from, to);
      if (candles.length) return candles;
    } catch (e) { lastError = e as Error; }
  }
  throw lastError ?? new Error(`Yahoo has no candles for ${id}`);
}
