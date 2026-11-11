import { NextResponse } from "next/server";
import { createDraft } from "../../../../lib/gmail";
import type { Analysis } from "../../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const { analyses, brief } = (await req.json()) as { analyses: Analysis[]; brief: string | null };
  try {
    return NextResponse.json(await createDraft(analyses, brief));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message ?? "Gmail draft failed" }, { status: 502 });
  }
}
