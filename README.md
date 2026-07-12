# HN AI Digest

Daily AI/tech digest across multiple sources — Hacker News, OpenAI blog, TechCrunch,
The Verge, Ars Technica — ranked by excitement, deduped, and summarized (English +
繁體中文) via [Article Reader](https://github.com/jocelinho/article-reader), plus one
evergreen [every.to](https://every.to) essay. Runs two ways off the **same selection
core**: a manual "fetch top news" (Claude Code News skill) and a daily 09:00 Slack cron.

## How It Works

```
HN front page + OpenAI/TechCrunch/Verge/Ars RSS  → filter by AI keywords
→ cross-source rank + per-source diversity cap → dedup vs Cloudflare D1
→ extract content → Article Reader (AI summary, records pick) → timely list
                                                     ＋ every.to essay → evergreen
```

1. Queries Article Reader (`GET /api/hn-digest?date=today`) — if today already has picks, returns them (cache)
2. Otherwise collects candidates from all sources in parallel (HN front page + 4 RSS feeds)
3. Filters for AI/tech content using an expanded keyword set (labs, products, concepts)
4. Ranks across sources (recency × source weight × popularity), caps each source to ≤2 timely slots
5. Skips anything picked in the last `HN_DIGEST_DEDUP_DAYS` days (`GET /api/hn-digest?since=...`), keyed by `source_url`
6. Extracts readable text (Mozilla Readability locally / regex in the Worker; HN-comment fallback)
7. Posts to Article Reader for bilingual summarization — which also records the pick in D1
8. Adds one recent every.to essay (title + public blurb + link; no paywall body fetched)

**Stateless:** all state lives in the Article Reader Cloudflare D1 — runs identically on any machine, no local DB, no sync.

## Two surfaces, one core

| Surface | Entry | Output |
|---|---|---|
| Manual (News skill) | `fetch-news.ts` | JSON on stdout → rendered + opened in browser |
| Daily 09:00 Slack | `worker/` (Cloudflare cron `0 1 * * *`) | Layered Block Kit message to a Slack webhook |

Both import `src/sources.ts` — the single source of truth for **what** is crawled and **how**
it's ranked. Change a source or keyword there and both surfaces update together.

## Features

- **Multi-source** — HN + OpenAI + TechCrunch + The Verge + Ars Technica, plus evergreen every.to
- **Cross-source ranking** — recency, source weight, and HN community popularity on one scale
- **Source diversity** — no single feed may take more than 2 timely slots
- **Bilingual summaries** — English + 繁體中文 TLDR & key takeaways per timely pick
- **Content extraction** — Mozilla Readability (local) with a top-HN-comments fallback
- **Stateless dedup** — cross-day dedup + daily cache from Cloudflare D1, keyed by `source_url`
- **Force refresh** — `--force` (local) / `?force=1` (Worker) bypasses today's cache

## Tech Stack

- **Bun** + **TypeScript** — runtime and sources
- **Cloudflare Workers** (cron) + **Cloudflare D1** (via Article Reader `/api/hn-digest`) — schedule + state
- **Mozilla Readability + jsdom** — local content extraction
- **Article Reader API** — downstream bilingual AI summarization

## Getting Started

```bash
git clone https://github.com/jocelinho/hn-ai-digest.git
cd hn-ai-digest
bun install
```

### Configuration

Works with zero config (stateless). Env vars (see `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `HN_AI_DIGEST_DIR` | — | Repo location (used by the Claude Code News skill to find this script); set per machine |
| `ARTICLE_READER_API` | `https://tech-news.jocelinho.com` | Summarization + digest-state service base URL |
| `HN_DIGEST_DEDUP_DAYS` | `14` | How many days back to dedup against previously-picked stories |

### Usage

```bash
# Manual pipeline (multi-source, dedup, caching, Article Reader)
bun run fetch-news.ts

# Bypass today's cache and re-collect fresh
bun run fetch-news.ts --force
```

### Daily Slack digest (Cloudflare Worker)

```bash
cd worker
bunx wrangler deploy                 # cron 0 1 * * * = 09:00 Asia/Taipei
# secrets (never committed): SLACK_WEBHOOK_URL, RUN_TOKEN — set via `wrangler secret put`
# manual trigger: curl "https://hn-news-slack.<subdomain>.workers.dev/?token=<RUN_TOKEN>&force=1"
```

## Project Structure

```
hn-ai-digest/
├── src/
│   └── sources.ts     # shared core: sources, keywords, ranking, dedup, extraction
├── fetch-news.ts      # manual surface: D1 cache/dedup + Article Reader + JSON out
├── worker/
│   ├── src/index.ts   # scheduled surface: cron → layered Slack digest
│   └── wrangler.toml
├── package.json
└── .gitignore
```

## Output Format

`fetch-news.ts` prints a layered object:

```json
{
  "date": "2026-07-08",
  "cached": false,
  "timely": [
    {
      "rank": 1,
      "title": "Article Title",
      "source": "TechCrunch",
      "ai_summary": "**TLDR:** ...",
      "ai_summary_zh": "**TLDR：** ...",
      "article_reader_url": "https://tech-news.jocelinho.com/article?id=...",
      "hn_url": "https://news.ycombinator.com/item?id=...",
      "origin_url": "https://...",
      "score": 197, "comments": 92, "reading_time": 3
    }
  ],
  "evergreen": [
    { "title": "Essay Title", "source": "every.to", "blurb": "One-line teaser", "url": "https://every.to/..." }
  ]
}
```

## License

MIT
