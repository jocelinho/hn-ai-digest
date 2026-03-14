# HN AI Digest

Top AI news from Hacker News, filtered by community excitement. Fetches trending stories, ranks them by velocity and engagement, extracts article content, and sends them to [Article Reader](https://github.com/jocelinho/article-reader) for AI-powered summarization.

## How It Works

```
Hacker News API → Filter by AI keywords → Rank by excitement score
→ Extract content (Readability) → Cache in SQLite → Send to Article Reader API
```

1. Pulls the top 100 stories from Hacker News
2. Filters for AI-related content using 18+ keyword patterns (OpenAI, Anthropic, Claude, LLM, etc.)
3. Ranks by **excitement score**: velocity (points/hour) + engagement + popularity
4. Extracts readable article text via Mozilla Readability (falls back to top HN comments)
5. Caches results in SQLite to avoid reprocessing
6. Posts to Article Reader API for AI summarization and enhanced formatting
7. Returns top 3 articles as JSON

## Features

- **Smart keyword filtering** — Matches companies (OpenAI, Anthropic, DeepMind), products (GPT-4, Claude, Gemini), and general terms (LLM, AGI, transformer)
- **Excitement scoring** — Combines velocity, comment engagement, and raw score into a single ranking metric
- **Content extraction** — Mozilla Readability pulls clean article text from any URL
- **Comment fallback** — If an article is paywalled or inaccessible, uses top HN comments instead
- **Database caching** — SQLite tracks processed articles by date to prevent duplicates
- **Why picked** — Generates human-readable explanations for why each article was selected
- **Article Reader integration** — Sends articles for AI summarization with bilingual support

## Tech Stack

- **Bun** — Runtime and package manager
- **TypeScript** — All source files
- **SQLite** (via `bun:sqlite`) — Local article cache
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

### Usage

```bash
# Fetch and rank AI articles from HN (raw output)
bun run index.ts

# Full pipeline with caching and Article Reader integration
bun run fetch-news.ts
```

The database (`processed-articles.db`) is created automatically on first run.

## Project Structure

```
hn-ai-digest/
├── index.ts           # Main HN fetcher — filters, ranks, extracts content
├── fetch-news.ts      # Full pipeline with caching + Article Reader API
├── db.ts              # SQLite database module (schema, queries, caching)
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
