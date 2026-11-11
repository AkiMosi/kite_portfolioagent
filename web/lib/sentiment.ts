import Anthropic from "@anthropic-ai/sdk";
import type { Headline, Sentiment } from "./types";

export const hasClaude = () => !!process.env.ANTHROPIC_API_KEY;
export const model = () => process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";

const POS = ["surge", "rally", "gain", "beat", "record", "profit", "growth", "upgrade", "win", "order", "expansion", "strong", "rise", "jumps", "soars", "approval", "dividend", "outperform", "bullish"];
const NEG = ["fall", "drop", "plunge", "miss", "loss", "downgrade", "probe", "fraud", "penalty", "fine", "weak", "slump", "cut", "decline", "lawsuit", "resign", "concern", "bearish", "tumbles", "crash", "ban", "default"];

function lexiconScore(t: string) {
  const w = t.toLowerCase();
  let s = 0;
  for (const p of POS) if (w.includes(p)) s++;
  for (const n of NEG) if (w.includes(n)) s--;
  return Math.max(-1, Math.min(1, s / 2));
}

function label(score: number): Sentiment["label"] {
  return score > 0.15 ? "Positive" : score < -0.15 ? "Negative" : "Neutral";
}

export async function scoreSentiment(symbol: string, sector: string, items: Headline[]): Promise<Sentiment> {
  if (!items.length)
    return { score: 0, confidence: 0, label: "No news", themes: [], rationale: "No recent headlines found.", method: "none", headlines: [] };

  if (hasClaude()) {
    try {
      const client = new Anthropic();
      const list = items.map((h, i) => `${i}. ${h.title} (${h.source}, ${h.published.slice(0, 10)})`).join("\n");
      const msg = await client.messages.create({
        model: model(),
        max_tokens: 1200,
        system: "You are a financial news sentiment analyst for Indian equities. Judge only what the headlines say about the company's business prospects and stock. Reply with JSON only.",
        messages: [
          {
            role: "user",
            content: `Company symbol: ${symbol} (${sector}).\nHeadlines:\n${list}\n\nReturn JSON: {"scores":[number -1..1 per headline, in order, 0 if irrelevant to this company],"overall":number -1..1,"confidence":number 0..1 (low if few/irrelevant/old headlines),"themes":[up to 4 short strings],"rationale":"max 2 sentences"}`,
          },
        ],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      const overall = Math.max(-1, Math.min(1, Number(j.overall) || 0));
      return {
        score: overall,
        confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0.5)),
        label: label(overall),
        themes: (j.themes ?? []).slice(0, 4),
        rationale: String(j.rationale ?? ""),
        method: "claude",
        headlines: items.map((h, i) => ({ ...h, score: Number(j.scores?.[i]) || 0 })),
      };
    } catch (e) {
      console.error("claude sentiment failed, using lexicon:", e);
    }
  }
  const scored = items.map((h) => ({ ...h, score: lexiconScore(h.title) }));
  const avg = scored.reduce((a, b) => a + b.score, 0) / scored.length;
  return {
    score: avg,
    confidence: Math.min(0.5, scored.length / 24),
    label: label(avg),
    themes: [],
    rationale: "Keyword lexicon over headlines (set ANTHROPIC_API_KEY for model-based sentiment).",
    method: "lexicon",
    headlines: scored,
  };
}
