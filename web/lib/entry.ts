import type { Report, ScreenResult } from "./types";

// Entry planner: at which price to start buying, in how many steps, with what stop and targets.
// Mirror image of exit.ts. Pure and deterministic (no network, no fs) so it runs in the browser and
// on the server. Thresholds come from the "entry_plan" block (and the existing "entry" block) in
// screen-rules.json; these defaults apply only when a key is missing. Set a number to null to switch a rule off.
export const DEFAULT_ENTRY_PLAN = {
  large_cap_min_cr: 100000, // market cap (₹ crore) at or above this = large cap
  mid_cap_min_cr: 30000, // at or above this (and below large) = mid cap
  picks_per_tier: 5,
  min_pullback_pct: 2, // a support level must sit at least this far below price to be a pullback anchor
  max_pullback_pct: 10, // ...and no further than this, or it is too far away to wait for
  tranche_pcts: [40, 35, 25] as number[], // % of the intended position bought at zone top, anchor, zone bottom
  stop_buffer_pct: 1, // stop sits this far under the chosen support
  min_stop_distance_pct: 3,
  max_stop_distance_pct: 12,
  profit_target_pcts: [10, 20] as number[], // targets above the average entry
  min_reward_risk: 1.5, // warn when first target / stop gives less than this
  avoid_downtrend: true,
  signal_points: { "ENTRY ZONE": 20, "WAIT FOR ENTRY": 10, "TECHNICAL ONLY": -10, "FAILS RULES": -30, "NO FUNDAMENTALS": -40, "INSUFFICIENT DATA": -60 } as Record<string, number>,
};
export type EntryPlanRules = typeof DEFAULT_ENTRY_PLAN;

// Defaults for the screening "entry" block, used when it is missing.
const DEFAULT_SCREEN_ENTRY = { allowed_trends: ["Uptrend", "Recovering"] as string[], pullback_band_pct: 3, rsi_min: 35 as number | null, rsi_max: 60 as number | null, max_pct_above_sma50: 5 as number | null };
const DEFAULT_POINTS = { trend: { Uptrend: 30, Recovering: 10, Weakening: -15, Downtrend: -30 } as Record<string, number>, verdict: { pass: 10, mixed: 0, fail: -10 } as Record<string, number> };

export type EntryCfg = { plan: EntryPlanRules; screen: typeof DEFAULT_SCREEN_ENTRY; trendPts: Record<string, number>; verdictPts: Record<string, number> };

export function entryCfg(rules: Record<string, unknown>): EntryCfg {
  const p = (rules.entry_plan ?? {}) as Partial<EntryPlanRules>;
  const sc = (rules.scoring ?? {}) as { trend_points?: Record<string, number>; verdict_points?: Record<string, number> };
  return {
    plan: { ...DEFAULT_ENTRY_PLAN, ...p, signal_points: { ...DEFAULT_ENTRY_PLAN.signal_points, ...p.signal_points } },
    screen: { ...DEFAULT_SCREEN_ENTRY, ...((rules.entry ?? {}) as Partial<typeof DEFAULT_SCREEN_ENTRY>) },
    trendPts: { ...DEFAULT_POINTS.trend, ...sc.trend_points },
    verdictPts: { ...DEFAULT_POINTS.verdict, ...sc.verdict_points },
  };
}

export type Tier = "large" | "mid" | "other";
export type EntryStatus = "Enter now" | "Wait for pullback" | "Avoid for now" | "No data";
export type Tranche = { price: number; pct: number; why: string };
export type EntryPlan = {
  id: string;
  tier: Tier;
  status: EntryStatus;
  signal: string;
  price: number;
  score: number;
  zone: { low: number; high: number; anchor: number; basis: string } | null;
  away_pct: number; // how far price is above the top of the zone (0 when already inside)
  tranches: Tranche[];
  avg_entry: number | null;
  stop: { price: number; distance_pct: number; basis: string } | null;
  targets: { price: number; gain_pct: number; why: string }[];
  reward_risk: number | null;
  reasons: string[]; // why this status
  warnings: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const on = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

export function tierOf(r: ScreenResult, cfg: EntryPlanRules): Tier {
  const mc = r.fundamentals?.market_cap_cr;
  if (!on(mc)) return "other";
  return mc >= cfg.large_cap_min_cr ? "large" : mc >= cfg.mid_cap_min_cr ? "mid" : "other";
}

export function planEntry(r: ScreenResult, marketCaution: boolean, c: EntryCfg): EntryPlan {
  const cfg = c.plan, se = c.screen, t = r.technicals;
  const price = t?.price ?? r.ltp;
  const reasons: string[] = [], warnings: string[] = [];
  const base: EntryPlan = { id: r.id, tier: tierOf(r, cfg), status: "No data", signal: r.signal, price, score: 0, zone: null, away_pct: 0, tranches: [], avg_entry: null, stop: null, targets: [], reward_risk: null, reasons, warnings };

  // Rank score: fundamentals + trend + momentum + how the screen reads today.
  let score = cfg.signal_points[r.signal] ?? 0;
  for (const k of ["valuation", "quality", "growth"] as const) score += c.verdictPts[r.checks?.[k]?.verdict] ?? 0;
  if (t) score += (c.trendPts[t.trend] ?? 0) + (t.pct_vs_sma200 >= 0 ? 10 : -10);
  if (!t) { warnings.push("No candles: trend, zone and stop cannot be computed."); return { ...base, score }; }

  // 1. Blockers: things that make buying now unattractive by your own rules.
  const blockers: string[] = [];
  const downtrend = t.trend === "Downtrend";
  if (downtrend && cfg.avoid_downtrend) blockers.push(`Downtrend: price ${price} is below SMA50 ${t.sma50} and SMA200 ${t.sma200}.`);
  else if (!se.allowed_trends.includes(t.trend)) blockers.push(`Trend is ${t.trend}; your rules allow ${se.allowed_trends.join(" or ")}.`);
  if (on(se.rsi_max) && t.rsi14 > se.rsi_max) blockers.push(`RSI ${t.rsi14} is above ${se.rsi_max}; momentum is stretched.`);
  if (on(se.rsi_min) && t.rsi14 < se.rsi_min) warnings.push(`RSI ${t.rsi14} is below ${se.rsi_min}; momentum is weak.`);
  if (on(se.max_pct_above_sma50) && t.pct_vs_sma50 > se.max_pct_above_sma50) blockers.push(`Price is ${t.pct_vs_sma50}% above SMA50 (limit ${se.max_pct_above_sma50}%); extended.`);
  if (marketCaution) warnings.push("NIFTY caution is on: buy only the lower tranches.");
  if (r.signal === "FAILS RULES" || r.signal === "TECHNICAL ONLY") warnings.push("Fundamentals do not meet your valuation, quality or growth rules.");
  if (r.signal === "NO FUNDAMENTALS") warnings.push("No fundamentals recorded for this stock.");

  // 2. Pullback anchor: nearest support below price, between min and max pullback distance.
  const lo = price * (1 - cfg.max_pullback_pct / 100), hi = price * (1 - cfg.min_pullback_pct / 100);
  const supports = [{ v: t.sma20, b: "SMA20" }, { v: t.sma50, b: "SMA50" }, { v: t.sma200, b: "SMA200" }]
    .filter((x) => on(x.v) && x.v <= hi && x.v >= lo).sort((a, b) => b.v - a.v);
  const anchor = supports[0] ?? { v: price * (1 - Math.max(cfg.min_pullback_pct, se.pullback_band_pct) / 100), b: `${Math.max(cfg.min_pullback_pct, se.pullback_band_pct)}% pullback (no support nearby)` };
  const band = se.pullback_band_pct / 100;
  const zoneHigh = Math.min(price, anchor.v * (1 + band)), zoneLow = anchor.v * (1 - band);

  // 3. Status. "Enter now" only when the screen's own entry checks pass and nothing blocks it.
  const entryPass = r.checks?.entry?.verdict === "pass" && !blockers.length;
  const status: EntryStatus = downtrend && cfg.avoid_downtrend ? "Avoid for now" : entryPass && !marketCaution ? "Enter now" : "Wait for pullback";
  if (status === "Enter now") reasons.push(`Entry checks pass: ${t.trend}, RSI ${t.rsi14}, ${t.pct_vs_sma50}% above SMA50.`);
  reasons.push(...blockers);
  if (status === "Wait for pullback" && !blockers.length) reasons.push(marketCaution ? "NIFTY caution is on; wait for the lower zone." : "Entry checks are not all passing yet.");
  const away = status === "Enter now" ? 0 : Math.max(0, ((price - zoneHigh) / price) * 100);

  // 4. Tranches: spread the buy across the zone. When entering now the first slice is at today's price.
  const pcts = cfg.tranche_pcts;
  const levels = [
    { price: status === "Enter now" ? price : zoneHigh, why: status === "Enter now" ? "At today's price" : "Top of the zone" },
    { price: anchor.v, why: `At ${anchor.b}` },
    { price: zoneLow, why: "Bottom of the zone" },
  ];
  const tranches: Tranche[] = levels.slice(0, pcts.length).map((l, i) => ({ price: r2(l.price), pct: pcts[i], why: l.why }));
  const wsum = tranches.reduce((a, x) => a + x.pct, 0) || 1;
  const avg = tranches.reduce((a, x) => a + x.price * x.pct, 0) / wsum;

  // 5. Stop: nearest support below the bottom of the zone, kept between min and max distance from the average entry.
  const buf = 1 - cfg.stop_buffer_pct / 100, gap = 1 - cfg.min_stop_distance_pct / 100;
  const floor = avg * (1 - cfg.max_stop_distance_pct / 100);
  const stops = [{ v: t.swing_low_3m, b: "3-month swing low" }, { v: t.sma200, b: "SMA200" }, { v: t.sma50, b: "SMA50" }]
    .filter((x) => on(x.v) && x.v * buf <= Math.min(zoneLow, avg * gap)).sort((a, b) => b.v - a.v);
  let stop = stops[0] ? { v: stops[0].v * buf, b: `${stops[0].b} (-${cfg.stop_buffer_pct}%)` } : null;
  if (!stop || stop.v < floor) stop = { v: floor, b: `max-loss cap (${cfg.max_stop_distance_pct}% below entry)` };

  // 6. Targets above the average entry; the 52-week high replaces the first one when it is nearer.
  const targets = cfg.profit_target_pcts.map((p, i) => {
    let tp = avg * (1 + p / 100), why = `+${p}% from entry`;
    if (i === 0 && t.high_52w > avg * 1.02 && t.high_52w < tp) { tp = t.high_52w; why = "52-week high (resistance)"; }
    return { price: r2(tp), gain_pct: r2(((tp - avg) / avg) * 100), why };
  });
  const rr = targets[0] ? r2((targets[0].price - avg) / (avg - stop.v)) : null;
  if (on(rr) && rr < cfg.min_reward_risk) warnings.push(`Reward/risk ${rr} is below your ${cfg.min_reward_risk} minimum.`);

  // Closer to the zone ranks higher; avoided stocks drop out unless the tier is short.
  score += status === "Enter now" ? 15 : -Math.min(15, away);
  if (status === "Avoid for now") score -= 50;

  return {
    ...base, status, score: Math.round(score),
    zone: { low: r2(zoneLow), high: r2(zoneHigh), anchor: r2(anchor.v), basis: anchor.b },
    away_pct: r2(away), tranches, avg_entry: r2(avg),
    stop: { price: r2(stop.v), distance_pct: r2(((avg - stop.v) / avg) * 100), basis: stop.b },
    targets, reward_risk: rr,
  };
}

export type EntryPicks = { large: EntryPlan[]; mid: EntryPlan[]; scanned: { large: number; mid: number; other: number } };

/** Plan every candidate (stocks you do not hold) and keep the top N per tier by score. */
export function pickEntries(candidates: ScreenResult[], held: Set<string>, marketCaution: boolean, rules: Record<string, unknown>): EntryPicks {
  const c = entryCfg(rules);
  const plans = candidates.filter((r) => !held.has(r.id)).map((r) => planEntry(r, marketCaution, c));
  const top = (tier: Tier) => plans.filter((p) => p.tier === tier).sort((a, b) => b.score - a.score).slice(0, c.plan.picks_per_tier);
  const n = (tier: Tier) => plans.filter((p) => p.tier === tier).length;
  return { large: top("large"), mid: top("mid"), scanned: { large: n("large"), mid: n("mid"), other: n("other") } };
}

export type HoldingBuy = EntryPlan & { qty: number; avg_cost: number; pnl_pct: number };

/** Re-price a screen result at a live last price so zones and checks use today's price. Averages and RSI stay as scanned. */
function atLivePrice(r: ScreenResult, ltp: number): ScreenResult {
  const t = r.technicals;
  if (!t || !on(ltp) || ltp <= 0) return r;
  const vs = (ma: number) => (on(ma) && ma > 0 ? Math.round((ltp / ma - 1) * 1000) / 10 : 0);
  return { ...r, ltp, technicals: { ...t, price: ltp, pct_vs_sma50: vs(t.sma50), pct_vs_sma200: vs(t.sma200) } };
}

/** Buy triggers for stocks you already hold (add-on or average-down levels). Same rules as pickEntries; nothing is hard-coded per stock. */
export function planHoldingBuys(report: Report, marketCaution: boolean, rules: Record<string, unknown>): HoldingBuy[] {
  const c = entryCfg(rules);
  const val = new Map(report.holdings_by_value.map((h) => [h.id, h]));
  const rank = (p: EntryPlan) => (p.status === "Enter now" ? 0 : p.status === "Wait for pullback" ? 1 : 2);
  return report.results
    .filter((r) => val.has(r.id))
    .map((r) => {
      const h = val.get(r.id)!;
      const p = planEntry(atLivePrice(r, h.ltp), marketCaution, c);
      return { ...p, qty: h.qty, avg_cost: h.avg, pnl_pct: h.cost ? r2(((h.value - h.cost) / h.cost) * 100) : 0 };
    })
    .sort((a, b) => rank(a) - rank(b) || a.away_pct - b.away_pct);
}
