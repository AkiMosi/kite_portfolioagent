import { NextResponse } from "next/server";
import { finishAuth } from "../../../../lib/kite";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const home = new URL("/", url.origin);
  if (!code) { home.searchParams.set("kite", "denied"); return NextResponse.redirect(home); }
  try {
    await finishAuth(code);
    home.searchParams.set("kite", "connected");
  } catch (e) {
    home.searchParams.set("kite", "error");
    home.searchParams.set("msg", (e as Error).message);
  }
  return NextResponse.redirect(home);
}
