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
/** People-watch layer: max picks per digest, and how far back a post counts as "new". */
export const PEOPLE_COUNT = 3;
export const PEOPLE_MAX_AGE_HOURS = 76;

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

// Followed people (the 👤 layer). Their names also act as keywords across ALL
// timely sources: a mention lets a story through the AI filter and boosts its
// rank. This is the only coverage for X-only people (e.g. Mike Krieger has no
// blog/RSS — he surfaces when HN/TechCrunch/Verge write about him).
export const PEOPLE_NAMES = [
  "karpathy", "paul graham", "garry tan", "mike krieger", "thariq",
  "dex horthy", "dexter horthy", "humanlayer", "12-factor agents",
  "simon willison", "\\bswyx\\b", "latent space", "lilian weng",
  "sam altman", "dwarkesh", "ethan mollick", "ben thompson", "stratechery",
];

const PEOPLE_REGEX = new RegExp(PEOPLE_NAMES.join("|"), "i");

export function matchesPeople(title: string): boolean {
  return PEOPLE_REGEX.test(title);
}

// ---------- types ----------

export type SourceId =
  | "hn" | "openai" | "techcrunch" | "theverge" | "arstechnica" | "every.to"
  | "people";

export type DigestKind = "timely" | "evergreen" | "people";

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
  blurb?: string; // public one-liner (every.to og:description / feed description)
  person?: string; // people layer: who this update is from
  medium?: PersonMedium; // people layer: which of their channels it came from
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

export type PersonMedium = "blog" | "youtube" | "newsletter" | "podcast";

export interface PersonFeed {
  person: string;
  url: string;
  medium: PersonMedium;
  /** 2 = Jocelin 點名必追；1 = 推薦名單。搶 PEOPLE_COUNT 名額時高者優先。 */
  priority: 1 | 2;
  /** Person has no usable feed — scrape instead of fetching `url` as RSS/Atom. */
  scraper?: () => Promise<FeedEntry[]>;
}

// The people-watch roster. X/Twitter has no reliable free feed, so coverage is
// blog/YouTube/newsletter RSS + the PEOPLE_NAMES boost above for news mentions.
// All URLs verified live 2026-07-12.
export const PEOPLE_FEEDS: PersonFeed[] = [
  { person: "Andrej Karpathy", url: "https://karpathy.bearblog.dev/feed/", medium: "blog", priority: 2 },
  { person: "Andrej Karpathy", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCXUPKJO5MZQN11PqgIvyuvQ", medium: "youtube", priority: 2 },
  { person: "Garry Tan", url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCIBgYfDjtWlbJhg--Z4sOgQ", medium: "youtube", priority: 2 },
  // No feed exists — scraped from articles.html. See fetchPaulGrahamEssays().
  { person: "Paul Graham", url: "https://paulgraham.com/articles.html", medium: "blog", priority: 2, scraper: fetchPaulGrahamEssays },
  { person: "Thariq Shihipar", url: "https://www.thariq.io/rss.xml", medium: "blog", priority: 2 },
  { person: "Dex Horthy", url: "https://humanlayer.substack.com/feed", medium: "newsletter", priority: 2 },
  // Mike Krieger: X-only, no feed — covered by PEOPLE_NAMES mention-boost.
  { person: "Simon Willison", url: "https://simonwillison.net/atom/entries/", medium: "blog", priority: 1 },
  { person: "swyx", url: "https://www.latent.space/feed", medium: "newsletter", priority: 1 },
  { person: "Lilian Weng", url: "https://lilianweng.github.io/index.xml", medium: "blog", priority: 1 },
  { person: "Sam Altman", url: "https://blog.samaltman.com/posts.atom", medium: "blog", priority: 1 },
  { person: "Dwarkesh Patel", url: "https://www.dwarkesh.com/feed", medium: "podcast", priority: 1 },
  { person: "Ethan Mollick", url: "https://www.oneusefulthing.org/feed", medium: "newsletter", priority: 1 },
  { person: "Ben Thompson", url: "https://stratechery.com/feed/", medium: "newsletter", priority: 1 },
];

export const PERSON_MEDIUM_LABEL: Record<PersonMedium, string> = {
  blog: "Blog", youtube: "YouTube", newsletter: "Newsletter", podcast: "Podcast",
};

// digest_source encoding for people picks: "people:<medium>:<person>" — keeps
// person+medium round-trippable through the D1 cache without schema changes.
export function peopleSource(p: { person: string; medium: PersonMedium }): string {
  return `people:${p.medium}:${p.person}`;
}
export function parsePeopleSource(s: string): { person: string; medium: PersonMedium } | null {
  if (!s.startsWith("people:")) return null;
  const [, medium, ...rest] = s.split(":");
  return { person: rest.join(":"), medium: (medium || "blog") as PersonMedium };
}

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

export interface FetchedArticle {
  /** Readable text. For PDFs this is a short placeholder (the real content is read via pdfUrl). */
  text: string;
  /** Set when the URL serves a PDF — pass through to article-reader as pdf_url so Claude reads the PDF directly. */
  pdfUrl?: string;
}

/**
 * Fetch an article URL and return readable text. Uses the injected extractor
 * (e.g. Readability on bun) when provided, else the Worker-safe htmlToText.
 * PDFs can't be scraped as HTML — those return a placeholder plus pdfUrl.
 * Fail-open: returns null on any error or thin content.
 */
export async function fetchArticleText(url: string, extractor?: HtmlExtractor): Promise<FetchedArticle | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf") || body.startsWith("%PDF-")) {
      return { text: `[PDF] ${url}`, pdfUrl: url };
    }
    const text = (extractor ? extractor(body, url) : htmlToText(body))?.trim() ?? "";
    if (text.length >= MIN_CONTENT_LENGTH && !text.includes("Something went wrong")) {
      return { text: text.slice(0, MAX_CONTENT_CHARS) };
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

export type FeedEntry = { title: string; link: string; published: number; blurb?: string };

function parseFeedField(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  const out: FeedEntry[] = [];
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
    // No/unparseable date → 0 (unknown), NOT "now": some feeds (e.g. the PG
    // essays scraper) carry no dates at all, and stamping them fresh would make
    // the whole archive look new every single day.
    const ms = dateStr ? Date.parse(dateStr) : NaN;
    const published = Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
    // YouTube: media:description. RSS: description. Atom: summary. May contain HTML.
    const rawBlurb =
      parseFeedField(b, "media:description") || parseFeedField(b, "description") ||
      parseFeedField(b, "summary");
    const blurb = rawBlurb ? htmlToText(rawBlurb).slice(0, 300) : undefined;
    if (title && /^https?:\/\//i.test(link)) out.push({ title, link, published, blurb });
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

const PG_ARTICLES_URL = "https://paulgraham.com/articles.html";
const PG_MONTHS = ["january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"];
/** Essays are dated by month only, so the guard has to tolerate a full month plus slack. */
const PG_MAX_AGE_DAYS = 75;

/**
 * Paul Graham essays. He has no working feed — paulgraham.com/rss.html only
 * points at Aaron Swartz's scraper, which carries no dates AND stopped updating
 * in 2023, so the "undated feed ⇒ trust the top item" rule in
 * collectPeopleCandidates served a 2023 essay as new (seen 2026-07-27).
 * articles.html is the live list, newest first.
 *
 * Entries stay undated (published 0) so the top-item + D1 dedup path still
 * decides when an essay surfaces. The month printed at the top of the essay
 * page ("June 2026") is used only as a staleness guard, so a source that
 * freezes again can't repeat that bug. Fail-open on an unparseable month: a
 * stale essay would surface at most once, whereas failing closed would drop PG
 * silently and forever. Fail-open on network errors too: returns [].
 */
export async function fetchPaulGrahamEssays(): Promise<FeedEntry[]> {
  try {
    const res = await fetch(PG_ARTICLES_URL, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    // Newest essay = first <a> whose child is text; the nav is <area>/<img> links.
    const m = (await res.text()).match(/<a href="([a-z0-9_-]+\.html)">([^<]+)<\/a>/i);
    if (!m) return [];
    const link = `https://paulgraham.com/${m[1]}`;
    const title = decodeEntities(m[2]).trim();
    if (!title) return [];

    let published = 0; // stays 0 — see the top-item rule in collectPeopleCandidates
    try {
      const page = await fetch(link, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(10000) });
      if (page.ok) {
        // Essays open with "June 2026" right after the title.
        const d = htmlToText(await page.text()).slice(0, 600)
          .match(new RegExp(`\\b(${PG_MONTHS.join("|")})\\s+(\\d{4})\\b`, "i"));
        if (d) {
          const monthMs = Date.UTC(Number(d[2]), PG_MONTHS.indexOf(d[1].toLowerCase()), 1);
          if (Date.now() - monthMs > PG_MAX_AGE_DAYS * 86400_000) return []; // source went stale
        }
      }
    } catch { /* month check is best-effort; fall through and surface the essay */ }

    return [{ title, link, published }];
  } catch {
    return [];
  }
}

// ---------- ranking ----------

const SOURCE_WEIGHT: Record<SourceId, number> = {
  openai: 1.5, hn: 1.15, techcrunch: 1.1,
  theverge: 1.0, arstechnica: 1.0, "every.to": 1.0, people: 1.0,
};

/** Rank boost for timely stories that mention a followed person. */
const PEOPLE_MENTION_BOOST = 1.3;

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
  const mention = matchesPeople(c.title) ? PEOPLE_MENTION_BOOST : 1;
  return weight * recency * (1 + popularity) * mention;
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
    // A followed person's name counts as an AI keyword — their news gets in
    // even when the title has no AI term (e.g. "Garry Tan on YC's new fund").
    if (!matchesAI(c.title) && !matchesPeople(c.title)) continue;
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

/**
 * Collect the 👤 people layer: fresh posts from followed people's own channels.
 * Rules: only posts within PEOPLE_MAX_AGE_HOURS (cross-day dedup via excludeKeys
 * stops repeats anyway — the window is a backstop for the very first runs), at
 * most one item per person per digest, Jocelin's named people (priority 2) win
 * contested slots, then fresher first, capped at PEOPLE_COUNT.
 */
export async function collectPeopleCandidates(excludeKeys: Set<string>): Promise<Candidate[]> {
  const nowSec = Math.floor(Date.now() / 1000);
  const minPublished = nowSec - PEOPLE_MAX_AGE_HOURS * 3600;

  const batches = await Promise.all(
    PEOPLE_FEEDS.map(async (f): Promise<Candidate[]> => {
      try {
        let entries: FeedEntry[];
        if (f.scraper) {
          entries = await f.scraper();
        } else {
          const res = await fetch(f.url, { headers: { "User-Agent": FETCH_UA }, signal: AbortSignal.timeout(10000) });
          if (!res.ok) return [];
          entries = parseFeed(await res.text());
        }
        return entries
          .slice(0, 10)
          // Dated entries must be inside the freshness window. Undated entries
          // (published=0, e.g. the PG essays scraper) only count via the feed's
          // top item — it surfaces once (D1 dedup) whenever a new post lands.
          .filter((e, idx) => (e.published > 0 ? e.published >= minPublished : idx === 0))
          .filter((e) => !/#shorts/i.test(e.title)) // skip YouTube Shorts noise
          .filter((e) => !/^\[AINews\]/i.test(e.title)) // skip swyx's daily AINews (redundant with this digest)
          .map((e): Candidate => ({
            source: "people",
            sourceLabel: f.person,
            kind: "people",
            dedupId: dedupKey(e.link),
            title: e.title,
            url: e.link,
            publishedAt: e.published,
            blurb: e.blurb,
            person: f.person,
            medium: f.medium,
          }));
      } catch {
        return [];
      }
    }),
  );

  const priorityOf = (person: string): number =>
    Math.max(...PEOPLE_FEEDS.filter((f) => f.person === person).map((f) => f.priority));

  const fresh = batches
    .flat()
    .filter((c) => !excludeKeys.has(c.dedupId))
    .sort((a, b) =>
      priorityOf(b.person!) - priorityOf(a.person!) || b.publishedAt - a.publishedAt);

  const perPerson = new Set<string>();
  const picked: Candidate[] = [];
  for (const c of fresh) {
    if (picked.length >= PEOPLE_COUNT) break;
    if (perPerson.has(c.person!)) continue;
    perPerson.add(c.person!);
    picked.push(c);
  }
  return picked;
}
