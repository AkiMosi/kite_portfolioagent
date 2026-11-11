import Dashboard from "./Dashboard";
import { loadLatestReport, loadRules } from "../lib/data";

export const dynamic = "force-dynamic";

export default function Page() {
  const loaded = loadLatestReport();
  if (!loaded)
    return (
      <main className="main">
        <h1>Portfolio Agent</h1>
        <p className="muted">No report found in the data folder. Run the kite-fundamental-analysis skill to create one, then reload.</p>
      </main>
    );
  const { report, file } = loaded;
  const holdings = report.results.filter((r) => r.sources.includes("holding"));
  const candidates = report.results.filter((r) => !r.sources.includes("holding"));
  return <Dashboard report={{ ...report, results: holdings }} candidates={candidates} file={file} rules={loadRules()} claude={!!process.env.ANTHROPIC_API_KEY} />;
}
