import { NextResponse } from "next/server";
import { finishGmailAuth } from "../../../../lib/gmail";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const home = new URL("/", url.origin);
  if (!code) { home.searchParams.set("gmail", "denied"); return NextResponse.redirect(home); }
  try {
    await finishGmailAuth(code);
    home.searchParams.set("gmail", "connected");
  } catch (e) {
    home.searchParams.set("gmail", "error");
    home.searchParams.set("msg", (e as Error).message);
  }
  return NextResponse.redirect(home);
}
