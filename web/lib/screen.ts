import type { Check, Fundamentals, Report, ScreenResult, Technicals, Verdict } from "./types";

// The screen: measures one stock's fundamentals and technicals against screen-rules.json and labels it.
// Pure (no network, no fs) so the live build and the backtester share it. null in the rules switches a check off.
export type FundamentalsRow = Fundamentals & { median_pe_5y?: number | null };

type Rules = Record<string, Record<string, unknown> | unknown>;
const sect = (rules: Rules, k: string) => ((rules[k] ?? {}) as Record<string, unknown>);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function check(label: string, value: number | null, op: "<=" | ">=", limit: unknown): Check | null {
  const lim = num(limit);
  if (lim == null || value == null) return null; // rule off, or the data point is missing
  return { label, value, op, limit: lim, pass: op === "<=" ? value <= lim : value >= lim };
}

function verdictOf(checks: (Check | null)[]): Verdict {
  const live = checks.filter((c): c is Check => c != null);
  if (!live.length) return { verdict: "n/a", checks: [] };
  const passed = live.filter((c) => c.pass).length;
  return { verdict: passed === live.length ? "pass" : passed === 0 ? "fail" : "mixed", checks: live };
}

export function fundamentalChecks(f: FundamentalsRow | undefined, rules: Rules) {
  if (!f) return { valuation: verdictOf([]), quality: verdictOf([]), growth: verdictOf([]) };
  const v = sect(rules, "valuation"), q = sect(rules, "quality"), g = sect(rules, "growth");
  const peVsMedian = f.pe != null && num(f.median_pe_5y) ? Math.round((f.pe / f.median_pe_5y!) * 100) / 100 : null;
  // PEG only makes sense on positive earnings growth; a negative-growth PEG reads as "cheap" and misleads.
  const peg = f.pe != null && f.profit_growth_3y != null && f.profit_growth_3y > 0 ? Math.round((f.pe / f.profit_growth_3y) * 100) / 100 : null;
  return {
    valuation: verdictOf([
      check("P/E", f.pe, "<=", v.max_pe),
      check("P/E vs 5y median", peVsMedian, "<=", v.max_pe_vs_5y_median),
      check("PEG", peg, "<=", v.max_peg),
      check("P/B", f.pb, "<=", v.max_pb),
    ]),
    quality: verdictOf([
      check("ROE %", f.roe, ">=", q.min_roe),
      // Banks and NBFCs run on leverage by design; ROCE and debt/equity do not measure their quality.
      f.is_financial ? null : check("ROCE %", f.roce, ">=", q.min_roce),
      f.is_financial ? null : check("Debt / equity", f.debt_to_equity, "<=", q.max_debt_to_equity),
    ]),
    growth: verdictOf([
      check("Sales growth 3y %", f.sales_growth_3y, ">=", g.min_sales_growth_3y),
      check("Profit growth 3y %", f.profit_growth_3y, ">=", g.min_profit_growth_3y),
    ]),
  };
}

export function entryChecks(t: Technicals | null, rules: Rules): Verdict {
  if (!t) return verdictOf([]);
  const e = sect(rules, "entry");
  const allowed = Array.isArray(e.allowed_trends) ? (e.allowed_trends as string[]) : null;
  const band = num(e.pullback_band_pct);
  // A pullback entry means price sits close to a rising average (SMA20 or SMA50), not far above it.
  const nearest = Math.min(Math.abs(t.price / t.sma20 - 1), Math.abs(t.price / t.sma50 - 1)) * 100;
  const checks: (Check | null)[] = [
    allowed ? { label: "Trend", value: t.trend, op: "in", limit: allowed, pass: allowed.includes(t.trend) } : null,
    check("RSI-14", t.rsi14, ">=", e.rsi_min),
    check("RSI-14", t.rsi14, "<=", e.rsi_max),
    check("% above SMA50", t.pct_vs_sma50, "<=", e.max_pct_above_sma50),
    band != null ? { label: "% from SMA20/50", value: Math.round(nearest * 10) / 10, op: "<=", limit: band, pass: nearest <= band } : null,
    e.require_above_sma200 === true ? { label: "Above SMA200", value: t.pct_vs_sma200, op: ">=", limit: 0, pass: t.pct_vs_sma200 >= 0 } : null,
  ];
  return verdictOf(checks);
}

export function signalOf(t: Technicals | null, f: FundamentalsRow | undefined, checks: ScreenResult["checks"]): string {
  if (!t) return "INSUFFICIENT DATA";
  if (!f) return "NO FUNDAMENTALS";
  const fundFail = (["valuation", "quality", "growth"] as const).some((k) => checks[k].verdict === "fail");
  const entryPass = checks.entry.verdict === "pass";
  if (fundFail) return entryPass ? "TECHNICAL ONLY" : "FAILS RULES";
  return entryPass ? "ENTRY ZONE" : "WAIT FOR ENTRY";
}

export function screenStock(
  input: { id: string; sources: string[]; ltp: number; technicals: Technicals | null; fundamentals?: FundamentalsRow; holding?: ScreenResult["holding"] },
  rules: Rules,
): ScreenResult {
  const { technicals: t, fundamentals: f } = input;
  const checks = { entry: entryChecks(t, rules), ...fundamentalChecks(f, rules) };
  const all = Object.values(checks).flatMap((v) => v.checks);
  const score = all.length ? Math.round((all.filter((c) => c.pass).length / all.length) * 100) : 0;
  return {
    id: input.id, sources: input.sources, signal: signalOf(t, f, checks), score, ltp: input.ltp, checks,
    ...(input.holding ? { holding: input.holding } : {}),
    ...(t ? { technicals: t } : {}),
    ...(f ? { fundamentals: f as Fundamentals } : {}),
  };
}

export function marketCaution(nifty: Technicals, rules: Rules): boolean {
  return sect(rules, "market").caution_when_nifty_downtrend === true && nifty.trend === "Downtrend";
}

export type HoldingRow = Report["holdings_by_value"][number];

export function assembleReport(market: Technicals, holdings: HoldingRow[], results: ScreenResult[], rules: Rules, at = new Date()): Report {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const hs = [...holdings].sort((a, b) => b.value - a.value);
  return {
    generated_at: at.toISOString(),
    market: { id: "NSE:NIFTY 50", technicals: market, caution: marketCaution(market, rules) },
    holdings_by_value: hs,
    holdings_total_value: r2(hs.reduce((a, b) => a + b.value, 0)),
    holdings_total_cost: r2(hs.reduce((a, b) => a + b.cost, 0)),
    results,
  };
}
