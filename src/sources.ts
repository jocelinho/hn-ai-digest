/**
 * Shared multi-source core for the AI/tech digest.
 *
 * This is the single source of truth for WHAT gets crawled and HOW it's ranked,
 * imported by both the scheduled Cloudflare Worker (worker/src/index.ts) and the
 * manual News skill (fetch-news.ts). Keeping selection here means the daily Slack
 * digest and the local "fetch top news" always see the exact same candidates —
 * only the output surface (Slack vs terminal) differs.
 *
 * Runtime constraints: must run on BOTH Cloudflare Workers and bun. So:
 *   - standard fetch only, no Node/bun-specific APIs
 *   - no jsdom / DOMParser — feeds and HTML are parsed with regex
 *   - callers may inject a better article-text extractor (e.g. Readability on bun)
 */

// ---------- config ----------

export const MIN_CONTENT_LENGTH = 200;
export const MAX_CONTENT_CHARS = 24000; // cap what we hand the summarizer
const FETCH_UA = "Mozilla/5.0 (compatible; HN-AI-Digest/2.0)";

/** How many timely stories and evergreen picks a digest aims for. */
export const TIMELY_COUNT = 4;
export const EVERGREEN_COUNT = 1;
/** No single source may occupy more than this many timely slots. */
export const MAX_PER_SOURCE = 2;

// Expanded AI/tech keyword set — companies, products, and concepts. Matched
// case-insensitively against titles. Word-boundary forms avoid false positives
// (e.g. "ai" inside "chair").
export const AI_KEYWORDS = [
  // Labs / companies
  "openai", "anthropic", "deepmind", "google ai", "meta ai", "mistral",
  "perplexity", "\\bxai\\b", "cohere", "hugging ?face", "stability ai",
  "runway", "suno", "elevenlabs", "midjourney", "black forest", "nvidia",
  "scale ai", "databricks", "\\bcursor\\b", "replit", "windsurf",
  // Products / models
  "chatgpt", "gpt-?[0-9]", "\\bgpt\\b", "claude", "gemini", "llama",
  "grok", "\\bo[0-9]\\b", "sora", "dall-?e", "stable diffusion", "copilot",
  "codex", "devin", "\\bqwen\\b", "deepseek", "\\bkimi\\b", "phi-?[0-9]",
  // General terms (word-bounded)
  "\\bai\\b", "\\ba\\.i\\.", "\\bllm\\b", "\\bllms\\b", "\\bagi\\b",
  "large language model", "machine learning", "deep learning",
  "neural network", "transformer", "diffusion model", "multimodal",
  "generative ai", "\\brag\\b", "fine-?tun", "\\bagent(s|ic)?\\b",
  "prompt engineering", "inference", "embedding", "vector database",
  "reinforcement learning", "foundation model", "reasoning model",
];

const KEYWORD_REGEX = new RegExp(AI_KEYWORDS.join("|"), "i");

export function matchesAI(title: string): boolean {
  return KEYWORD_REGEX.test(title);
}

// ---------- types ----------

export type SourceId =
  | "hn" | "openai" | "techcrunch" | "theverge" | "arstechnica" | "every.to";

export type DigestKind = "timely" | "evergreen";

export interface Candidate {
  source: SourceId;
  sourceLabel: string;
  kind: DigestKind;
  /** Stable dedup id: HN id as string, else the normalized URL. */
  dedupId: string;
  title: string;
  url: string; // original article link
  publishedAt: number; // unix seconds
  score?: number; // HN points
  comments?: number; // HN comments
  hnId?: number;
  hnUrl?: string;
  blurb?: string; // public one-liner (every.to og:description) — no full text fetched
}

interface RSSFeed {
  source: SourceId;
  label: string;
  url: string;
}

// Front-of-mind timely feeds. RSS only gives title+link+date — that's all we
// need; full text is fetched per-pick downstream (same as HN). Anthropic has no
// official RSS, so its news is covered via HN + TechCrunch.
export const RSS_FEEDS: RSSFeed[] = [
  { source: "openai", label: "OpenAI", url: "https://openai.com/blog/rss.xml" },
  { source: "techcrunch", label: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { source: "theverge", label: "The Verge", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { source: "arstechnica", label: "Ars Technica", url: "https://feeds.arstechnica.com/arstechnica/technology-lab" },
];

// ---------- url / text helpers ----------

/** Normalize a URL into a stable dedup key (drop scheme, www, query, trailing slash). */
export function dedupKey(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Worker-safe HTML → text (no jsdom). The default article-text extractor. */
export function htmlToText(html: string): string {
  let s = html.slice(0, 400000); // bound work
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s).slice(0, MAX_CONTENT_CHARS);
}

/** Pull an og:/twitter:/name meta tag's content, attribute order agnostic. */
export function extractMeta(html: string, prop: string): string | null {
  const p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const a = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]*content=["']([^"']*)["']`, "i"));
  const b = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${p}["']`, "i"));
  const raw = a?.[1] ?? b?.[1];
  return raw ? decodeEntities(raw) : null;
}

export type HtmlExtractor = (html: string, url: string) => string | null;

/**
 * Fetch an article URL and return readable text. Uses the injected extractor
 * (e.g. Readability on bun) when provided, else the Worker-safe htmlToText.
 * Fail-open: returns null on any error or thin content.
 */
export async function fetchArticleText(url: string, extractor?: HtmlExtractor): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const html = await res.text();
    const text = (extractor ? extractor(html, url) : htmlToText(html))?.trim() ?? "";
    if (text.length >= MIN_CONTENT_LENGTH && !text.includes("Something went wrong")) {
      return text.slice(0, MAX_CONTENT_CHARS);
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- HN (Algolia front page) ----------

const ALGOLIA = "https://hn.algolia.com/api/v1/search";
const HN_API = "https://hacker-news.firebaseio.com/v0";

export async function fetchHNCandidates(): Promise<Candidate[]> {
  try {
    const res = await fetch(`${ALGOLIA}?tags=front_page&hitsPerPage=50`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { hits?: any[] };
    return (data.hits ?? [])
      .filter((h) => h.url && h.title)
      .map((h): Candidate => {
        const id = Number(h.objectID);
        return {
          source: "hn",
          sourceLabel: "Hacker News",
          kind: "timely",
          dedupId: String(id),
          title: h.title as string,
          url: h.url as string,
          publishedAt: h.created_at_i ?? Math.floor(Date.now() / 1000),
          score: h.points ?? 0,
          comments: h.num_comments ?? 0,
          hnId: id,
          hnUrl: `https://news.ycombinator.com/item?id=${id}`,
        };
      });
  } catch {
    return [];
  }
}

// HN comment fallback (Firebase) — used when an article body won't fetch.
interface HNItem { id: number; kids?: number[]; }
interface HNComment { by: string; text: string; }

async function fetchItem<T>(id: number): Promise<T | null> {
  try {
    const res = await fetch(`${HN_API}/item/${id}.json`, { signal: AbortSignal.timeout(10000) });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchHNComments(storyId: number, limit = 5): Promise<string | null> {
  const story = await fetchItem<HNItem>(storyId);
  if (!story?.kids?.length) return null;
  const comments = await Promise.all(story.kids.slice(0, limit).map((id) => fetchItem<HNComment>(id)));
  const valid = comments
    .filter((c): c is HNComment => !!c && !!c.text && !c.text.includes("[dead]"))
    .map((c) => `[${c.by}]: ${htmlToText(c.text)}`)
    .join("\n\n");
  return valid.length >= MIN_CONTENT_LENGTH ? `[Top HN Comments]\n\n${valid}` : null;
}

// ---------- RSS / Atom feeds ----------

function parseFeedField(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function parseFeed(xml: string): { title: string; link: string; published: number }[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const out: { title: string; link: string; published: number }[] = [];
  for (const b of blocks) {
    const title = parseFeedField(b, "title");
    // RSS: <link>url</link>. Atom: <link href="url" rel="alternate"/>.
    let link = parseFeedField(b, "link");
    if (!link) {
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
        ?? b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? alt[1] : "";
    }
    const dateStr =
      parseFeedField(b, "pubDate") || parseFeedField(b, "published") ||
      parseFeedField(b, "updated") || parseFeedField(b, "dc:date");
    const ms = dateStr ? Date.parse(dateStr) : NaN;
    const published = Number.isNaN(ms) ? Math.floor(Date.now() / 1000) : Math.floor(ms / 1000);
    if (title && /^https?:\/\//i.test(link)) out.push({ title, link, published });
  }
  return out;
}

export async function fetchRSSCandidates(feed: RSSFeed): Promise<Candidate[]> {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml).slice(0, 20).map((e): Candidate => ({
      source: feed.source,
      sourceLabel: feed.label,
      kind: "timely",
      dedupId: dedupKey(e.link),
      title: e.title,
      url: e.link,
      publishedAt: e.published,
    }));
  } catch {
    return [];
  }
}

// ---------- every.to (evergreen, scraped — no public feed) ----------

const EVERYTO_SKIP = new Set([
  "pricing", "login", "subscribe", "about", "podcast", "podcasts", "episode",
  "account", "gift", "chat", "consulting", "courses", "guides", "p", "search",
  "welcome", "sign-in", "sitemap", "authors", "author", "tag", "tags", "rss",
]);

function extractEveryToLinks(html: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  const re = /href=["'](\/[a-z0-9-]+\/[a-z0-9-]{8,})["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const path = m[1];
    const first = path.split("/")[1];
    if (EVERYTO_SKIP.has(first)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push("https://every.to" + path);
  }
  return paths;
}

/**
 * Pick recent every.to essays as evergreen candidates. Scrapes the homepage for
 * article links, then reads each one's public og:title/og:description (paywall
 * body is never fetched). Fail-open: returns [] if scraping breaks.
 */
export async function fetchEveryToCandidates(limit = 4): Promise<Candidate[]> {
  try {
    const res = await fetch("https://every.to", { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const links = extractEveryToLinks(await res.text()).slice(0, limit);
    const metas = await Promise.all(links.map(async (url): Promise<Candidate | null> => {
      try {
        const r = await fetch(url, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null;
        const html = await r.text();
        const title = extractMeta(html, "og:title") ?? "";
        const blurb = extractMeta(html, "og:description") ?? extractMeta(html, "description") ?? "";
        if (!title) return null;
        return {
          source: "every.to",
          sourceLabel: "every.to",
          kind: "evergreen",
          dedupId: dedupKey(url),
          title: title.replace(/\s*[|–-]\s*Every\s*$/i, "").trim(),
          url,
          publishedAt: Math.floor(Date.now() / 1000),
          blurb,
        };
      } catch {
        return null;
      }
    }));
    return metas.filter((c): c is Candidate => c !== null);
  } catch {
    return [];
  }
}

// ---------- ranking ----------

const SOURCE_WEIGHT: Record<SourceId, number> = {
  openai: 1.5, hn: 1.15, techcrunch: 1.1,
  theverge: 1.0, arstechnica: 1.0, "every.to": 1.0,
};

/**
 * Cross-source score. Blends recency, source weight, and (for HN) community
 * popularity onto one scale so official releases, HN breakouts, and media can
 * be ranked together. Higher = more prominent.
 */
export function rankScore(c: Candidate, nowSec: number): number {
  const hoursAgo = Math.max(0, (nowSec - c.publishedAt) / 3600);
  const recency = 1 / (1 + hoursAgo / 18); // gentle ~day-long decay, in (0,1]
  const weight = SOURCE_WEIGHT[c.source] ?? 1.0;
  const popularity =
    c.source === "hn"
      ? Math.min((c.score ?? 0) / 400, 2.5) + Math.min((c.comments ?? 0) / 250, 1.2)
      : 0.4; // non-HN has no vote signal; small flat boost
  return weight * recency * (1 + popularity);
}

export function generateWhyPicked(c: Candidate, nowSec: number): string {
  if (c.source === "hn") {
    const hoursAgo = Math.max(0.5, (nowSec - c.publishedAt) / 3600);
    const pph = Math.round((c.score ?? 0) / hoursAgo);
    const parts: string[] = [];
    if (pph > 100) parts.push(`Viral velocity — ${pph} points/hour`);
    else if (pph > 30) parts.push(`Fast-rising — ${pph} points/hour`);
    if ((c.score ?? 0) > 1000) parts.push(`${(c.score ?? 0).toLocaleString()} points — rare breakout`);
    else if ((c.score ?? 0) > 500) parts.push(`${(c.score ?? 0).toLocaleString()} points — high interest`);
    if ((c.comments ?? 0) > 500) parts.push(`${(c.comments ?? 0).toLocaleString()} comments — massive debate`);
    else if ((c.comments ?? 0) > 100) parts.push(`${c.comments} comments — active discussion`);
    if (!parts.length) parts.push("Top-ranked AI/tech story on HN");
    return parts.slice(0, 3).join(". ") + ".";
  }
  return `From ${c.sourceLabel} — fresh AI/tech coverage.`;
}

// ---------- collection ----------

/**
 * Collect timely candidates across all sources: fetch in parallel, keep AI
 * matches, drop anything in `excludeKeys` (recent picks) and intra-batch dupes,
 * rank, then apply a per-source cap so no single source dominates.
 */
export async function collectTimelyCandidates(excludeKeys: Set<string>): Promise<Candidate[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const batches = await Promise.all([
    fetchHNCandidates(),
    ...RSS_FEEDS.map((f) => fetchRSSCandidates(f)),
  ]);

  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (const c of batches.flat()) {
    if (!matchesAI(c.title)) continue;
    if (excludeKeys.has(c.dedupId) || excludeKeys.has(dedupKey(c.url))) continue;
    if (seen.has(c.dedupId)) continue;
    seen.add(c.dedupId);
    pool.push(c);
  }

  pool.sort((a, b) => rankScore(b, nowSec) - rankScore(a, nowSec));

  // Diversity: cap picks per source while filling up to TIMELY_COUNT.
  const perSource = new Map<SourceId, number>();
  const picked: Candidate[] = [];
  for (const c of pool) {
    if (picked.length >= TIMELY_COUNT) break;
    const n = perSource.get(c.source) ?? 0;
    if (n >= MAX_PER_SOURCE) continue;
    perSource.set(c.source, n + 1);
    picked.push(c);
  }
  // If diversity cap left us short (thin day), backfill from remaining pool.
  if (picked.length < TIMELY_COUNT) {
    for (const c of pool) {
      if (picked.length >= TIMELY_COUNT) break;
      if (!picked.includes(c)) picked.push(c);
    }
  }
  return picked;
}

/** Collect evergreen picks (every.to), excluding recent picks. */
export async function collectEvergreenCandidates(excludeKeys: Set<string>): Promise<Candidate[]> {
  const cands = await fetchEveryToCandidates();
  return cands.filter((c) => !excludeKeys.has(c.dedupId)).slice(0, EVERGREEN_COUNT);
}
