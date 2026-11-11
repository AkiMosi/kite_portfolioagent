import type { Report, ScreenResult } from "./types";

// Exit planner: when to sell, and how much. Pure and deterministic (no network, no fs) so it runs
// in the browser and on the server. Every threshold comes from the "exit" block in screen-rules.json;
// these defaults apply only when a key is missing. Set a number to null to switch that rule off.
export const DEFAULT_EXIT = {
  min_profit_pct_for_trim: 5, // profit-taking trims only apply when at least this far above cost
  overbought_rsi: 75,
  overbought_trim_pct: 25,
  extended_pct_above_sma50: 15,
  extended_trim_pct: 20,
  fundamentals_fail_trim_pct: 25, // signal FAILS RULES while in profit
  concentration_cap_pct: 10, // trim back down to this portfolio weight
  downtrend_sell_pct: 50,
  deep_loss_pct: -20, // downtrend AND this far below cost: cut an extra deep_loss_extra_pct
  deep_loss_extra_pct: 25,
  market_caution_trim_pct: 10, // extra trim for non-uptrend holdings when NIFTY caution is on
  min_stop_distance_pct: 3, // stop must sit at least this far below price (avoids whipsaw)
  max_stop_distance_pct: 12, // stop is never further than this below price (caps the downside)
  stop_buffer_pct: 1, // stop sits this far under the chosen support level
  profit_target_pcts: [10, 20] as number[], // price targets above current price
  ladder_sell_pcts: [25, 25] as number[], // % of the remaining shares sold at each target
};
export type ExitRules = typeof DEFAULT_EXIT;

export function exitRules(rules: Record<string, unknown>): ExitRules {
  const e = (rules.exit ?? {}) as Partial<ExitRules>;
  return { ...DEFAULT_EXIT, ...e };
}

export type Rung = { price: number; gain_pct: number; sell_pct: number; shares: number; proceeds: number; why: string };
export type ExitPlan = {
  id: string;
  action: "Exit" | "Trim" | "Hold with stop" | "No data";
  weight_pct: number;
  now: { pct: number; shares: number; proceeds: number; realised_pnl: number; reasons: { pct: number; text: string }[] };
  stop: { price: number; distance_pct: number; basis: string; downside: number; vs_cost_pct: number } | null;
  targets: Rung[];
  remaining_after_now: number;
  notes: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const on = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

type Holding = Report["holdings_by_value"][number];

export function planExit(r: ScreenResult, h: Holding, total: number, marketCaution: boolean, cfg: ExitRules): ExitPlan {
  const t = r.technicals;
  const price = h.ltp;
  const w = total ? (h.value / total) * 100 : 0;
  const profitPct = ((h.ltp - h.avg) / h.avg) * 100;
  const inProfit = on(cfg.min_profit_pct_for_trim) ? profitPct >= cfg.min_profit_pct_for_trim : profitPct > 0;
  const reasons: { pct: number; text: string }[] = [];
  const notes: string[] = [];

  // 1. Sell-now triggers, each adds a % of the position. The total is capped at 100.
  if (t) {
    if (t.trend === "Downtrend" && on(cfg.downtrend_sell_pct)) {
      reasons.push({ pct: cfg.downtrend_sell_pct, text: `Downtrend: price ${price} below SMA50 ${t.sma50} and SMA200 ${t.sma200}.` });
      if (on(cfg.deep_loss_pct) && profitPct <= cfg.deep_loss_pct && on(cfg.deep_loss_extra_pct))
        reasons.push({ pct: cfg.deep_loss_extra_pct, text: `Also ${profitPct.toFixed(1)}% below your cost (limit ${cfg.deep_loss_pct}%).` });
    }
    if (on(cfg.overbought_rsi) && on(cfg.overbought_trim_pct) && t.rsi14 > cfg.overbought_rsi && inProfit)
      reasons.push({ pct: cfg.overbought_trim_pct, text: `RSI ${t.rsi14} is above ${cfg.overbought_rsi} with a ${profitPct.toFixed(1)}% gain to protect.` });
    if (on(cfg.extended_pct_above_sma50) && on(cfg.extended_trim_pct) && t.pct_vs_sma50 > cfg.extended_pct_above_sma50 && inProfit)
      reasons.push({ pct: cfg.extended_trim_pct, text: `Price is ${t.pct_vs_sma50}% above SMA50 (limit ${cfg.extended_pct_above_sma50}%); stretched.` });
    if (marketCaution && t.trend !== "Uptrend" && on(cfg.market_caution_trim_pct))
      reasons.push({ pct: cfg.market_caution_trim_pct, text: `NIFTY caution is on and this holding is ${t.trend}.` });
  } else {
    notes.push("No candles: trend, stop and RSI triggers are unavailable.");
  }
  if (r.signal === "FAILS RULES" && inProfit && on(cfg.fundamentals_fail_trim_pct))
    reasons.push({ pct: cfg.fundamentals_fail_trim_pct, text: `Fails your valuation, quality or growth rules while ${profitPct.toFixed(1)}% in profit.` });
  // Concentration is measured on the weight left after the trims above, so the same shares are never counted twice.
  const otherPct = Math.min(100, reasons.reduce((a, x) => a + x.pct, 0));
  const wAfter = w * (1 - otherPct / 100);
  if (on(cfg.concentration_cap_pct) && wAfter > cfg.concentration_cap_pct)
    reasons.push({ pct: r2(((wAfter - cfg.concentration_cap_pct) / w) * 100), text: `Weight ${w.toFixed(1)}%${otherPct ? ` (${wAfter.toFixed(1)}% after the trims above)` : ""} exceeds your ${cfg.concentration_cap_pct}% cap; trim back to the cap.` });

  const nowPct = Math.min(100, r2(reasons.reduce((a, x) => a + x.pct, 0)));
  const nowShares = nowPct >= 100 ? h.qty : Math.floor((h.qty * nowPct) / 100);
  const remaining = h.qty - nowShares;
  const now = { pct: nowPct, shares: nowShares, proceeds: Math.round(nowShares * price), realised_pnl: Math.round(nowShares * (price - h.avg)), reasons };

  // 2. Protective stop: nearest support below price, kept between min and max distance.
  let stop: ExitPlan["stop"] = null;
  if (t && remaining > 0) {
    const buf = 1 - (cfg.stop_buffer_pct ?? 0) / 100;
    const minGap = 1 - (cfg.min_stop_distance_pct ?? 0) / 100;
    const floor = price * (1 - (cfg.max_stop_distance_pct ?? 100) / 100);
    const levels = [
      { v: t.swing_low_3m, basis: "3-month swing low" },
      { v: t.sma200, basis: "SMA200" },
      { v: t.sma50, basis: "SMA50" },
    ].filter((x) => on(x.v) && x.v * buf <= price * minGap).sort((a, b) => b.v - a.v);
    let level = levels[0] ? { v: levels[0].v * buf, basis: `${levels[0].basis} (-${cfg.stop_buffer_pct}%)` } : null;
    if (!level || level.v < floor) level = { v: floor, basis: `max-loss cap (${cfg.max_stop_distance_pct}% below price)` };
    stop = {
      price: r2(level.v), distance_pct: r2(((price - level.v) / price) * 100), basis: level.basis,
      downside: Math.round((price - level.v) * remaining), vs_cost_pct: r2(((level.v - h.avg) / h.avg) * 100),
    };
  }

  // 3. Profit ladder: sell a slice of the remaining shares at each target. 52w high replaces the first target if it is nearer.
  const targets: Rung[] = [];
  if (remaining > 0) {
    let left = remaining;
    cfg.profit_target_pcts.forEach((p, i) => {
      let tp = price * (1 + p / 100), why = `+${p}% from here`;
      if (i === 0 && t && t.high_52w > price * 1.02 && t.high_52w < tp) { tp = t.high_52w; why = "52-week high (resistance)"; }
      const sellPct = cfg.ladder_sell_pcts[i] ?? 0;
      const shares = Math.min(left, Math.floor((remaining * sellPct) / 100));
      if (!shares) return;
      left -= shares;
      targets.push({ price: r2(tp), gain_pct: r2(((tp - price) / price) * 100), sell_pct: sellPct, shares, proceeds: Math.round(shares * tp), why });
    });
  }

  const action: ExitPlan["action"] = !t && !reasons.length ? "No data" : nowPct >= 100 ? "Exit" : nowPct > 0 ? "Trim" : "Hold with stop";
  if (t && r.signal === "ENTRY ZONE") notes.push("Screen still shows ENTRY ZONE; exit triggers here are risk controls only.");
  return { id: r.id, action, weight_pct: r2(w), now, stop, targets, remaining_after_now: remaining, notes };
}

export function planAll(report: Report, rules: Record<string, unknown>): ExitPlan[] {
  const cfg = exitRules(rules);
  const val = new Map(report.holdings_by_value.map((h) => [h.id, h]));
  return report.results
    .filter((r) => val.has(r.id))
    .map((r) => planExit(r, val.get(r.id)!, report.holdings_total_value, report.market.caution, cfg))
    .sort((a, b) => b.now.proceeds - a.now.proceeds || b.weight_pct - a.weight_pct);
}
