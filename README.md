# kite_portfolioagent

One-stop solution to analyse your Zerodha portfolio and mutual funds by connecting through Claude.

A Next.js web app (in `web/`) that screens your Kite holdings against the rules in `screen-rules.json` (valuation, quality, growth, price trend), pulls news sentiment, and produces a dashboard and reports.

## Project layout

| Path | Purpose |
|------|---------|
| `web/` | Next.js app (UI + API routes: `analyze`, `brief`, `kite`, `rules`) |
| `screen-rules.json` | Screening rules applied to holdings |
| `data/` | Fundamentals and cache |
| `reports/` | Generated screen reports (`.json` / `.md`) |

## Prerequisites

- Node.js 18.18+ and npm
- A Zerodha Kite account (connected through the Kite MCP)

## Running the server

```bash
cd web
npm install
cp .env.example .env.local   # optional, see below
npm run dev
```

Open http://localhost:3000.

Other scripts (run from `web/`): `npm run build`, `npm start` (production), `npm run typecheck`.

## Configuration

Set in `web/.env.local` (all optional):

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Enables Claude-based news sentiment and synthesis. Without it, a simple headline lexicon and rule-based synthesis are used. |
| `ANTHROPIC_MODEL` | Model override (default `claude-haiku-5-5`). |
| `KITE_DATA_DIR` | Folder holding `screen-rules.json`, `data/` and `reports/` (default: parent of `web/`). |
