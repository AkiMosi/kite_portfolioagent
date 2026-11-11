import { NextResponse } from "next/server";
import { loadLatestReport } from "../../../../lib/data";
import { refreshHoldings } from "../../../../lib/kite";

export const dynamic = "force-dynamic";

export async function POST() {
  const latest = loadLatestReport();
  if (!latest) return NextResponse.json({ error: "No report found. Run the kite-fundamental-analysis skill first." }, { status: 404 });
  try {
    return NextResponse.json(await refreshHoldings(latest));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "Kite refresh failed" }, { status: 502 });
  }
}
