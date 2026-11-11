import fs from "node:fs";
import path from "node:path";
import type { Report } from "./types";

export const dataDir = () => process.env.KITE_DATA_DIR || path.resolve(process.cwd(), "..");

export function loadLatestReport(): { report: Report; file: string } | null {
  const dir = path.join(dataDir(), "reports");
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^screen-.*\.json$/.test(f)).sort();
  const file = files.at(-1);
  if (!file) return null;
  return { report: JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Report, file };
}

export function loadRules(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), "screen-rules.json"), "utf8")); } catch { return {}; }
}

export const symbolOf = (id: string) => id.split(":").pop() ?? id;
