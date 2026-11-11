import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./data";

// Defaults used when screen-rules.json omits a key. The user edits screen-rules.json, not this file.
export const DEFAULT_SCORING = {
  trend_points: { Uptrend: 30, Recovering: 10, Weakening: -15, Downtrend: -30 } as Record<string, number>,
  above_sma200_points: 10,
  below_sma200_points: -10,
  rsi_overbought: 75,
  rsi_overbought_points: -10,
  rsi_oversold: 35,
  rsi_oversold_points: -5,
  rsi_normal_points: 5,
  return_3m_divisor: 2,
  return_3m_cap: 15,
  verdict_points: { pass: 10, mixed: 0, fail: -10 } as Record<string, number>,
  news_weight: 0.4,
  stance_threshold: 0.25,
  conflict_threshold: 0.2,
};

export const DEFAULT_RISK = {
  large_position_pct: 10,
  loss_vs_cost_pct: -20,
  rsi_stretched: 75,
  stale_fundamentals_days: 30,
};

export type Scoring = typeof DEFAULT_SCORING;
export type Risk = typeof DEFAULT_RISK;

const rulesPath = () => path.join(dataDir(), "screen-rules.json");

function readRaw(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(rulesPath(), "utf8")); } catch { return {}; }
}

export function loadScoring(): Scoring {
  const s = (readRaw().scoring ?? {}) as Partial<Scoring>;
  return {
    ...DEFAULT_SCORING, ...s,
    trend_points: { ...DEFAULT_SCORING.trend_points, ...s.trend_points },
    verdict_points: { ...DEFAULT_SCORING.verdict_points, ...s.verdict_points },
  };
}

export function loadRisk(): Risk {
  return { ...DEFAULT_RISK, ...((readRaw().risk ?? {}) as Partial<Risk>) };
}

/** Validate and write screen-rules.json. Throws on invalid JSON or a non-object. */
export function saveRules(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Rules must be a JSON object.");
  fs.writeFileSync(rulesPath(), JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return parsed;
}
