/**
 * Daily HN AI/tech digest → Slack, on a Cloudflare cron trigger.
 *
 * Runs the same pipeline as hn-ai-digest/fetch-news.ts, server-side:
 *   1. Check today's picks in Cloudflare D1 (via article-reader /api/hn-digest)
 *   2. If <3, fetch + rank HN, dedup against recent picks, extract content,
 *      POST to article-reader (which AI-summarizes and records the pick)
 *   3. Post the top 3 to a Slack incoming webhook
 *
 * State lives entirely in article-reader's D1, so this shares cache/dedup with
 * the local News skill. Independent of any laptop — fires on the cron trigger.
 */

interface Env {
  ARTICLE_READER_API: string;
  HN_DIGEST_DEDUP_DAYS: string;
  SLACK_WEBHOOK_URL: string;
  RUN_TOKEN: string;
}

const HN_API = "https://hacker-news.firebaseio.com/v0";
const ALGOLIA = "https://hn.algolia.com/api/v1/search";
const MIN_CONTENT_LENGTH = 200;
const MIN_COMMENTS_FOR_FALLBACK = 20;
const MAX_CONTENT_CHARS = 24000; // cap what we send to the summarizer
const MAX_CANDIDATES = 12; // bound subrequests (Worker limit) when picking
const COUNT = 3;

const AI_KEYWORDS = [
  "openai", "anthropic", "deepmind", "mistral", "perplexity", "xai",
  "chatgpt", "gpt-4", "gpt-5", "claude", "gemini", "llama", "grok",
  "\\bai\\b", "\\bllm\\b", "\\bagi\\b",
  "large language model", "machine learning", "neural network",
  "transformer", "diffusion model", "multimodal",
];
const KEYWORD_REGEX = new RegExp(AI_KEYWORDS.join("|"), "i");

// Firebase item shape (used only for the comment-fallback path)
interface HNItem { id: number; kids?: number[]; }
interface HNComment { id: number; by: string; text: string; time: number; kids?: number[]; }

// Algolia front-page hit — one request returns the whole front page with metadata
interface Hit {
  id: number;
  title: string;
  url: string;
  score: number;
  comments: number;
  time: number; // unix seconds
}

interface SlackArticle {
  rank: number;
  title: string;
  hn_url: string;
  score: number;
  comments: number;
  ai_summary: string;
  ai_summary_zh?: string;
  reading_time: number;
  article_reader_url: string;
}

// ---------- HN fetching / ranking ----------

// One request → the whole HN front page with title/score/comments/url.
async function getFrontPage(): Promise<Hit[]> {
  const res = await fetch(`${ALGOLIA}?tags=front_page&hitsPerPage=50`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  const data = (await res.json()) as { hits?: any[] };
  return (data.hits ?? [])
    .filter((h) => h.url && h.title)
    .map((h) => ({
      id: Number(h.objectID),
      title: h.title as string,
      url: h.url as string,
      score: h.points ?? 0,
      comments: h.num_comments ?? 0,
      time: h.created_at_i ?? Math.floor(Date.now() / 1000),
    }));
}

// Firebase item fetch — only used for the comment-fallback path
async function fetchItem<T>(id: number): Promise<T | null> {
  try {
    const res = await fetch(`${HN_API}/item/${id}.json`, { signal: AbortSignal.timeout(10000) });
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function calculateExcitement(h: Hit, now: number): number {
  const hoursAgo = (now / 1000 - h.time) / 3600;
  const velocity = h.score / Math.max(hoursAgo, 0.5);
  return velocity + h.comments * 0.5 + h.score * 0.1;
}

function matchesAI(title: string): boolean {
  return KEYWORD_REGEX.test(title);
}

function generateWhyPicked(h: Hit, excitement: number, hoursAgo: number): string {
  const parts: string[] = [];
  const pph = Math.round(h.score / Math.max(hoursAgo, 0.5));
  if (pph > 100) parts.push(`Viral velocity — ${pph} points/hour`);
  else if (pph > 30) parts.push(`Fast-rising — ${pph} points/hour`);
  if (h.score > 1000) parts.push(`${h.score.toLocaleString()} points — rare breakout story`);
  else if (h.score > 500) parts.push(`${h.score.toLocaleString()} points — high community interest`);
  if (h.comments > 500) parts.push(`${h.comments.toLocaleString()} comments — massive debate`);
  else if (h.comments > 100) parts.push(`${h.comments} comments — active discussion`);
  if (parts.length === 0) parts.push(`Excitement score: ${excitement} — top-ranked AI/tech story`);
  return parts.slice(0, 3).join(". ") + ".";
}

// ---------- content extraction (Worker-safe, no jsdom) ----------

function htmlToText(html: string): string {
  let s = html.slice(0, 400000); // bound work
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, MAX_CONTENT_CHARS);
}

async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; HN-AI-Digest/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const text = htmlToText(await res.text());
    if (text.length >= MIN_CONTENT_LENGTH && !text.includes("Something went wrong")) return text;
    return null;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

async function fetchHNComments(storyId: number, limit = 5): Promise<string | null> {
  const story = await fetchItem<HNItem>(storyId);
  if (!story?.kids?.length) return null;
  const comments = await Promise.all(story.kids.slice(0, limit).map((id) => fetchItem<HNComment>(id)));
  const valid = comments
    .filter((c): c is HNComment => !!c && !!c.text && !c.text.includes("[dead]"))
    .map((c) => `[${c.by}]: ${stripHtml(c.text)}`)
    .join("\n\n");
  return valid.length >= MIN_CONTENT_LENGTH ? `[Top HN Comments]\n\n${valid}` : null;
}

// ---------- article-reader (D1-backed digest state) ----------

function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}
function daysAgoUTC(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

async function getDigest(env: Env, params: { date?: string; since?: string }): Promise<any[]> {
  const qs = params.date ? `date=${params.date}` : `since=${params.since}`;
  try {
    const res = await fetch(`${env.ARTICLE_READER_API}/api/hn-digest?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: any[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

// ---------- pipeline ----------

async function collectFreshArticles(env: Env, today: string): Promise<SlackArticle[]> {
  const dedupDays = Number(env.HN_DIGEST_DEDUP_DAYS ?? 14);
  const recent = await getDigest(env, { since: daysAgoUTC(dedupDays) });
  const processedIds = new Set(recent.map((i) => i.hn_id).filter((x: any) => x != null));

  const now = Date.now();
  const front = await getFrontPage();

  const ranked = front
    .filter((h) => matchesAI(h.title) && !processedIds.has(h.id))
    .map((h) => ({ h, excitement: calculateExcitement(h, now) }))
    .sort((a, b) => b.excitement - a.excitement)
    .slice(0, MAX_CANDIDATES); // bound subrequests

  const picked: {
    h: Hit; content: string; excitement: number; hoursAgo: number; rank: number; whyPicked: string;
  }[] = [];

  for (const entry of ranked) {
    if (picked.length >= COUNT) break;

    let content = await fetchArticleContent(entry.h.url);
    if (!content && entry.h.comments >= MIN_COMMENTS_FOR_FALLBACK) {
      content = await fetchHNComments(entry.h.id);
    }
    if (!content) continue;

    const hoursAgo = Math.round(((now / 1000 - entry.h.time) / 3600) * 10) / 10;
    const excitement = Math.round(entry.excitement * 10) / 10;
    picked.push({
      h: entry.h, content, excitement, hoursAgo,
      rank: picked.length + 1,
      whyPicked: generateWhyPicked(entry.h, excitement, hoursAgo),
    });
  }

  // POST each to article-reader (parallel) — summarizes + records the pick in D1
  const results = await Promise.all(
    picked.map(async (p): Promise<SlackArticle | null> => {
      try {
        const res = await fetch(`${env.ARTICLE_READER_API}/api/article`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_type: "url",
            source_url: p.h.url,
            raw_content: p.content,
            title: p.h.title,
            hn_url: `https://news.ycombinator.com/item?id=${p.h.id}`,
            hn_score: p.h.score,
            hn_comments: p.h.comments,
            why_picked: p.whyPicked,
            hn_id: p.h.id,
            digest_date: today,
            digest_rank: p.rank,
            excitement_score: p.excitement,
          }),
          signal: AbortSignal.timeout(90000),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as any;
        return {
          rank: p.rank,
          title: data.title || p.h.title,
          hn_url: `https://news.ycombinator.com/item?id=${p.h.id}`,
          score: p.h.score,
          comments: p.h.comments,
          ai_summary: data.ai_summary || "",
          ai_summary_zh: data.ai_summary_zh || undefined,
          reading_time: data.reading_time || 0,
          article_reader_url: data.url,
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter((x): x is SlackArticle => x !== null);
}

// ---------- Slack formatting ----------

function tldr(summary?: string, fallback?: string): string {
  const src = summary || fallback || "";
  const m = src.match(/TLDR[:：]\s*\**\s*(.+)/i);
  let line = m ? m[1] : src;
  line = line.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return line.length > 220 ? line.slice(0, 217) + "…" : line;
}

function slackBlocks(articles: SlackArticle[], date: string) {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: `🗞️ Top AI/Tech News — ${date}`, emoji: true } },
  ];
  for (const a of articles) {
    const summary = tldr(a.ai_summary_zh, a.ai_summary);
    const meta = `📖 <${a.article_reader_url}|Read (${a.reading_time}m)>  ·  💬 <${a.hn_url}|HN ${a.comments}>  ·  ⬆︎ ${a.score}`;
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${a.rank}. ${a.title}*\n${summary}\n${meta}` },
    });
  }
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "via hn-ai-digest · ranked by community excitement" }],
  });
  return { blocks };
}

async function postToSlack(env: Env, payload: unknown): Promise<boolean> {
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  return res.ok;
}

// ---------- entry ----------

async function runDigest(env: Env): Promise<{ status: string; count: number; cached: boolean }> {
  const today = todayUTC();

  // Today's cache: already picked >=3? Reuse them.
  const cached = await getDigest(env, { date: today });
  let articles: SlackArticle[];
  let usedCache = false;

  if (cached.length >= COUNT) {
    usedCache = true;
    articles = cached.slice(0, COUNT).map((i, idx) => ({
      rank: i.rank ?? idx + 1,
      title: i.title ?? "",
      hn_url: i.hn_url ?? "",
      score: i.score ?? 0,
      comments: i.comments ?? 0,
      ai_summary: i.ai_summary ?? "",
      ai_summary_zh: i.ai_summary_zh ?? undefined,
      reading_time: i.reading_time ?? 0,
      article_reader_url: i.article_reader_url,
    }));
  } else {
    articles = await collectFreshArticles(env, today);
  }

  if (articles.length === 0) {
    await postToSlack(env, { text: `🗞️ Top AI/Tech News — ${today}\n(no fresh AI/tech stories found today)` });
    return { status: "empty", count: 0, cached: usedCache };
  }

  const ok = await postToSlack(env, slackBlocks(articles, today));
  return { status: ok ? "sent" : "slack_failed", count: articles.length, cached: usedCache };
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDigest(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.searchParams.get("token") !== env.RUN_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }
    // Run in the background (like the cron) so slow summarization doesn't hit
    // the HTTP response time limit; return immediately.
    ctx.waitUntil(runDigest(env));
    return new Response("queued — digest running, will post to Slack shortly\n", { status: 202 });
  },
};
