import { NextResponse } from "next/server";
import { analyzeStock } from "../../../lib/agents";
import { loadLatestReport } from "../../../lib/data";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const loaded = loadLatestReport();
  if (!loaded) return NextResponse.json({ error: "No screen yet. Click Run agents to build one from Kite." }, { status: 404 });
  const r = loaded.report.results.find((x) => x.id === id);
  if (!r) return NextResponse.json({ error: "Unknown stock" }, { status: 404 });
  try {
    return NextResponse.json(await analyzeStock(r, loaded.report));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "Analysis failed" }, { status: 500 });
  }
}
