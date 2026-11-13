// Daily screen for a Claude routine.
//
// The routine has the Kite connector but not the web app's own Kite OAuth login, so Claude fetches holdings
// through the connector, saves the raw rows to a JSON file, and runs:
//
//   npm run daily -- <holdings.json>
//
// This builds the same screen as the web app (Yahoo candles + rules + entry/exit planners), fetches recent
// headlines per holding, writes reports/daily-<date>.json, and prints a compact JSON digest on stdout for
// Claude to read, score news sentiment on and summarise. Everything numeric is decided here, in code, so the
// figures are the same on every run; Claude only reads headlines and writes the brief.
//
// The digest uses percentages and public prices only, never quantities or rupee values, because routine logs
// are kept with the run.
import fs from "node:fs";
import path from "node:path";
import { buildFromHoldings, type RawHolding } from "../lib/build";
import { dataDir, loadRules, symbolOf } from "../lib/data";
import { pickEntries, planHoldingBuys } from "../lib/entry";
import { planAll } from "../lib/exit";
import { fetchNews } from "../lib/news";
import { quantScore } from "../lib/quant";

const HEADLINES_PER_HOLDING = 8;
const r1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npm run daily -- <holdings.json>  (Kite portfolio rows, mode=holdings type=full)");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  const raw: RawHolding[] = Array.isArray(parsed) ? parsed : parsed.data;
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${file} has no holding rows.`);
  const missingFields = ["exchange", "tradingsymbol", "quantity", "average_price"].filter((k) => !(k in raw[0]));
  if (missingFields.length) throw new Error(`Holding rows lack ${missingFields.join(", ")}; fetch them with type=full, not compact.`);

  const rules = loadRules();
  const built = await buildFromHoldings(raw);
  const { report } = built;
  const held = new Set(report.holdings_by_value.map((h) => h.id));
  const holdingResults = report.results.filter((r) => held.has(r.id));
  const candidates = report.results.filter((r) => !held.has(r.id));
  const exits = new Map(planAll(report, rules).map((p) => [p.id, p]));
  const buys = new Map(planHoldingBuys(report, report.market.caution, rules).map((p) => [p.id, p]));
  const picks = pickEntries(candidates, held, report.market.caution, rules);
  const total = report.holdings_total_value;

  const holdings = [];
  for (const h of report.holdings_by_value) {
    const r = holdingResults.find((x) => x.id === h.id)!;
    const q = quantScore(r);
    const exit = exits.get(h.id), buy = buys.get(h.id);
    let headlines: { title: string; source: string; date: string }[] = [];
    let newsError: string | undefined;
    try {
      headlines = (await fetchNews(symbolOf(h.id), HEADLINES_PER_HOLDING)).map((n) => ({ title: n.title, source: n.source, date: n.published.slice(0, 10) }));
    } catch (e) { newsError = (e as Error).message; }
    holdings.push({
      symbol: symbolOf(h.id),
      sector: r.fundamentals?.sector ?? null,
      weight_pct: total ? r1((h.value / total) * 100) : 0,
      pnl_pct: h.cost ? r1(((h.value - h.cost) / h.cost) * 100) : 0,
      price: h.ltp,
      signal: r.signal,
      technicals: r.technicals ? { trend: r.technicals.trend, rsi14: r.technicals.rsi14, pct_vs_sma50: r.technicals.pct_vs_sma50, pct_vs_sma200: r.technicals.pct_vs_sma200, pct_from_52w_high: r.technicals.pct_from_52w_high } : null,
      checks: Object.fromEntries((["valuation", "quality", "growth", "entry"] as const).map((k) => [k, r.checks[k].verdict])),
      quant: { score: q.score, parts: q.parts.map((p) => `${p.pts >= 0 ? "+" : ""}${p.pts} ${p.label}`) },
      exit: exit ? { action: exit.action, sell_now_pct: exit.now.pct, reasons: exit.now.reasons.map((x) => `${x.pct}%: ${x.text}`), stop: exit.stop ? { price: exit.stop.price, distance_pct: exit.stop.distance_pct, basis: exit.stop.basis } : null, targets: exit.targets.map((t) => ({ price: t.price, sell_pct: t.sell_pct, why: t.why })), notes: exit.notes } : null,
      add_on: buy ? { status: buy.status, zone: buy.zone, reasons: buy.reasons, warnings: buy.warnings } : null,
      headlines,
      ...(newsError ? { news_error: newsError } : {}),
    });
  }

  const pick = (p: ReturnType<typeof pickEntries>["large"][number]) => ({ symbol: symbolOf(p.id), status: p.status, signal: p.signal, price: p.price, zone: p.zone, stop: p.stop?.price ?? null, targets: p.targets.map((t) => t.price), reward_risk: p.reward_risk, reasons: p.reasons, warnings: p.warnings });
  const m = report.market.technicals;
  const digest = {
    as_of: report.generated_at,
    note: "Rule-based screen against screen-rules.json plus headlines. Not investment advice.",
    market: { index: "NIFTY 50", price: m.price, trend: m.trend, rsi14: m.rsi14, pct_vs_sma200: m.pct_vs_sma200, caution: report.market.caution },
    portfolio: { holdings: report.holdings_by_value.length, pnl_pct: report.holdings_total_cost ? r1(((report.holdings_total_value - report.holdings_total_cost) / report.holdings_total_cost) * 100) : 0 },
    holdings,
    entry_picks: { large: picks.large.map(pick), mid: picks.mid.map(pick), scanned: picks.scanned },
    missing: built.missing,
  };

  const out = path.join(dataDir(), "reports", built.file.replace(/^screen-/, "daily-"));
  fs.writeFileSync(out, JSON.stringify(digest, null, 2));
  process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
  process.stderr.write(`Wrote ${out} and reports/${built.file}\n`);
}

main().catch((e) => { process.stderr.write(`daily-screen failed: ${(e as Error).message}\n`); process.exit(1); });
