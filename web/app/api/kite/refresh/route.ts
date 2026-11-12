import { NextResponse } from "next/server";
import { buildScreen } from "../../../../lib/build";
import { loadLatestReport } from "../../../../lib/data";
import { refreshHoldings } from "../../../../lib/kite";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json(await buildScreen());
  } catch (buildError) {
    // A full rebuild needs Kite's historical-data tool. If that fails but an older screen exists,
    // still refresh live holdings into it so the dashboard stays usable.
    const latest = loadLatestReport();
    const reason = (buildError as Error).message ?? "screen build failed";
    if (!latest) return NextResponse.json({ error: `Could not build the screen: ${reason}` }, { status: 502 });
    try {
      const res = await refreshHoldings(latest);
      return NextResponse.json(res.status === "ok" ? { ...res, missing: [`full rebuild failed (${reason}); holdings refreshed only`, ...res.missing] } : res);
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message ?? "Kite refresh failed" }, { status: 502 });
    }
  }
}
