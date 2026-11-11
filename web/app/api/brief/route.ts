import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { hasClaude, model } from "../../../lib/sentiment";
import type { Analysis } from "../../../lib/types";

export async function POST(req: Request) {
  if (!hasClaude()) return NextResponse.json({ brief: null, method: "none" });
  const { analyses } = (await req.json()) as { analyses: Analysis[] };
  // Only scores and flags are sent; no quantities, prices or cost basis.
  const lines = analyses.map((a) => `${a.symbol}: stance ${a.stance}, quant ${a.quantScore}, news ${a.newsScore}, flags: ${a.reviewNotes.join(" ") || "none"}`);
  const msg = await new Anthropic().messages.create({
    model: model(),
    max_tokens: 700,
    system: "You write a short portfolio review brief from rule-based screen results and news sentiment. Never say buy, sell or hold; no position sizing; this is a screen, not advice. Max 120 words, bullet points.",
    messages: [{ role: "user", content: `Per-holding results:\n${lines.join("\n")}\n\nHighlight conflicts between quant and news, and the holdings worth reviewing first.` }],
  });
  return NextResponse.json({ brief: msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim(), method: "claude" });
}
