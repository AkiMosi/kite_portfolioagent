import type { Technicals } from "./types";

// Technicals from daily candles. Pure and deterministic: the live screen and the backtester both call
// computeTechnicals on a slice of candles that ends on the day being evaluated, so no future bar leaks in.
export type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

// SMA200 needs 200 closes; fewer bars and the trend label would be meaningless.
export const MIN_BARS = 200;
const BARS_1M = 21, BARS_3M = 63, BARS_6M = 126, BARS_52W = 252;
// Golden/death cross is reported only when SMA50 crossed SMA200 within this many sessions.
const CROSS_LOOKBACK = 10;

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function sma(closes: number[], n: number, end = closes.length): number {
  let s = 0;
  for (let i = end - n; i < end; i++) s += closes[i];
  return s / n;
}

/** Wilder's RSI, the variant charting platforms show; a simple-average RSI reads noticeably different. */
export function rsi(closes: number[], n = 14): number {
  if (closes.length <= n) return 50;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export function trendOf(price: number, sma50: number, sma200: number): string {
  if (price >= sma50) return sma50 >= sma200 ? "Uptrend" : "Recovering";
  return sma50 >= sma200 ? "Weakening" : "Downtrend";
}

const ret = (closes: number[], bars: number) => {
  const i = closes.length - 1 - bars;
  return i >= 0 && closes[i] > 0 ? r1((closes[closes.length - 1] / closes[i] - 1) * 100) : null;
};

/** Technicals as of the last candle. Returns null when there are not enough bars for SMA200. */
export function computeTechnicals(candles: Candle[]): Technicals | null {
  if (candles.length < MIN_BARS) return null;
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const sma20 = sma(closes, 20), sma50 = sma(closes, 50), sma200 = sma(closes, 200);

  let cross: string | null = null;
  const past = closes.length - CROSS_LOOKBACK;
  if (past >= 200) {
    const wasAbove = sma(closes, 50, past) >= sma(closes, 200, past);
    const isAbove = sma50 >= sma200;
    if (!wasAbove && isAbove) cross = "Golden cross";
    else if (wasAbove && !isAbove) cross = "Death cross";
  }

  const year = candles.slice(-BARS_52W);
  const high52 = Math.max(...year.map((c) => c.high));
  const low52 = Math.min(...year.map((c) => c.low));
  const swingLow = Math.min(...candles.slice(-BARS_3M).map((c) => c.low));

  return {
    price: r2(price), sma20: r2(sma20), sma50: r2(sma50), sma200: r2(sma200),
    pct_vs_sma50: r1((price / sma50 - 1) * 100), pct_vs_sma200: r1((price / sma200 - 1) * 100),
    rsi14: r1(rsi(closes)), trend: trendOf(price, sma50, sma200), cross,
    return_1m: ret(closes, BARS_1M), return_3m: ret(closes, BARS_3M), return_6m: ret(closes, BARS_6M),
    high_52w: r2(high52), low_52w: r2(low52), pct_from_52w_high: r1((price / high52 - 1) * 100),
    swing_low_3m: r2(swingLow), last_candle: candles[candles.length - 1].date.slice(0, 10),
  };
}
