# HN AI Digest

Top AI news from Hacker News, filtered by community excitement. Fetches trending stories, ranks them by velocity and engagement, extracts article content, and sends them to [Article Reader](https://github.com/jocelinho/article-reader) for AI-powered summarization.

## How It Works

```
Hacker News API → Filter by AI keywords → Rank by excitement score
→ Dedup against Cloudflare D1 → Extract content (Readability) → Send to Article Reader API
```

1. Queries Article Reader (`GET /api/hn-digest?date=today`) — if ≥3 picks already exist for today, returns them
2. Otherwise pulls the top 100 stories from Hacker News
3. Filters for AI-related content using 18+ keyword patterns (OpenAI, Anthropic, Claude, LLM, etc.)
4. Ranks by **excitement score**: velocity (points/hour) + engagement + popularity
5. Skips stories already picked recently (dedup set from `GET /api/hn-digest?since=...`)
6. Extracts readable article text via Mozilla Readability (falls back to top HN comments)
7. Posts to Article Reader API for summarization — which also records the pick in D1
8. Returns top 3 articles as JSON

**Stateless:** all state lives in the Article Reader Cloudflare D1, so it runs identically on any machine — no local database, no sync.

## Features

- **Smart keyword filtering** — Matches companies (OpenAI, Anthropic, DeepMind), products (GPT-4, Claude, Gemini), and general terms (LLM, AGI, transformer)
- **Excitement scoring** — Combines velocity, comment engagement, and raw score into a single ranking metric
- **Content extraction** — Mozilla Readability pulls clean article text from any URL
- **Comment fallback** — If an article is paywalled or inaccessible, uses top HN comments instead
- **Stateless dedup** — dedup + daily cache queried from Cloudflare D1 (`/api/hn-digest`); no local database
- **Why picked** — Generates human-readable explanations for why each article was selected
- **Article Reader integration** — Sends articles for AI summarization with bilingual support

## Tech Stack

- **Bun** — Runtime and package manager
- **TypeScript** — All source files
- **Cloudflare D1** (via Article Reader `/api/hn-digest`) — server-side digest state
- **Mozilla Readability + jsdom** — Content extraction
- **Article Reader API** — Downstream AI processing

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) v1.0+

### Setup

```bash
git clone https://github.com/jocelinho/hn-ai-digest.git
cd hn-ai-digest
bun install
```

### Configuration (optional)

Everything works with zero config — it's stateless, state lives in Cloudflare D1. Env vars (see `.env.example`):

| Var | Default | Purpose |
|---|---|---|
| `HN_AI_DIGEST_DIR` | — | Repo location (used by the Claude Code News skill to find this script); set per machine |
| `ARTICLE_READER_API` | `https://article-reader.pages.dev` | Summarization + digest-state service base URL |
| `HN_DIGEST_DEDUP_DAYS` | `14` | How many days back to dedup against previously-picked stories |

### Usage

```bash
# Fetch and rank AI articles from HN (raw output)
bun run index.ts

# Full pipeline with dedup, caching, and Article Reader integration
bun run fetch-news.ts
```

No local database — dedup and daily cache are read from Cloudflare D1 at runtime.

## Project Structure

```
hn-ai-digest/
├── index.ts           # HN fetcher — filters, ranks, extracts content (dedup set via env)
├── fetch-news.ts      # Full pipeline: D1 cache/dedup + Article Reader API
├── package.json
└── .gitignore
```

## Output Format

Each run returns a JSON array of the top articles:

```json
[
  {
    "title": "Article Title",
    "hn_url": "https://news.ycombinator.com/item?id=...",
    "source_url": "https://example.com/article",
    "score": 342,
    "comments": 156,
    "excitement_score": 28.5,
    "why_picked": "342 points in 3 hours with 156 comments...",
    "article_reader_url": "https://article-reader.pages.dev/article?id=..."
  }
]
```

## License

MIT
