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
| `GMAIL_MCP_URL` | Gmail MCP server URL. When set, every **Run agents** saves the report as a Gmail draft (no recipient, never sent). |
| `KITE_DATA_DIR` | Folder holding `screen-rules.json`, `data/` and `reports/` (default: parent of `web/`). |
| `KITE_HISTORICAL` | Set to `1` only if your Kite account has the paid Connect plan (₹500/month). Kite is then used as a fallback source for daily candles when Yahoo fails. |

## Price history

**Run agents** builds the whole screen: live holdings from Kite, plus daily candles for each stock and NIFTY 50, which give SMA, RSI, trend and the 52-week range.

Candles come from Yahoo Finance's public chart endpoint. It needs no key. Kite's free plan doesn't include historical candles; they're part of the paid Connect plan. The endpoint is unofficial and for personal use only, so it can change without notice.

Candles are cached in `data/cache/candles/` (gitignored). After the first run, each run only fetches the days since the last cached close.

## Gmail draft report

With `GMAIL_MCP_URL` set, each **Run agents** click creates a draft in Gmail containing the brief, per-holding stance/scores/flags and quant-vs-news conflicts. The first run shows an "authorize here" link for Gmail sign-in (tokens are kept in `web/.gmail-oauth.json`, gitignored); click Run agents again afterwards. The draft has no recipient and is never sent automatically.
