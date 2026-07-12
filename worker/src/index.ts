/**
 * Daily multi-source AI/tech digest → Slack, on a Cloudflare cron trigger.
 *
 * Selection logic (what to crawl, how to rank) lives in the shared ../../src/sources.ts
 * module, so this scheduled digest and the local "fetch top news" News skill always
 * see the exact same candidates — only the output surface differs (Slack vs terminal).
 *
 * Pipeline:
 *   1. Read today's picks + recent picks from Cloudflare D1 (article-reader /api/hn-digest)
 *   2. If today already has picks, reuse them (cache). Else:
 *      - collect timely candidates (HN + OpenAI/TechCrunch/Verge/Ars), dedup vs recent
 *      - fetch each pick's body, POST to article-reader (AI-summarizes + records the pick)
 *      - collect one evergreen every.to essay (title + public blurb, no paywall body)
 *   3. Post a layered digest (🔥 timely + 📖 evergreen) to a Slack incoming webhook
 *
 * State lives entirely in article-reader's D1 → shared cache/dedup across machines,
 * independent of any laptop. Fires on the cron trigger.
 */

import {
  Candidate,
  collectTimelyCandidates,
  collectEvergreenCandidates,
  fetchArticleText,
  fetchHNComments,
  generateWhyPicked,
  dedupKey,
} from "../../src/sources";

interface Env {
  ARTICLE_READER_API: string;
  HN_DIGEST_DEDUP_DAYS: string;
  SLACK_WEBHOOK_URL: string;
  RUN_TOKEN: string;
}

const MIN_COMMENTS_FOR_FALLBACK = 20;

interface TimelyOut {
  rank: number;
  title: string;
  sourceLabel: string;
  hnUrl?: string;
  score?: number;
  comments?: number;
  ai_summary: string;
  ai_summary_zh?: string;
  reading_time: number;
  article_reader_url: string;
  origin_url: string;
}

interface EvergreenOut {
  title: string;
  sourceLabel: string;
  blurb: string;
  url: string;
}

// ---------- digest state (D1 via article-reader) ----------

function todayUTC(): string {
  return new Date().toISOString().split("T")[0];
}
function daysAgoUTC(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split("T")[0];
}

interface DigestItem {
  hn_id?: number | null;
  hn_url?: string | null;
  source_url?: string;
  digest_source?: string;
  rank?: number | null;
  title?: string | null;
  ai_summary?: string | null;
  ai_summary_zh?: string | null;
  reading_time?: number | null;
  score?: number | null;
  comments?: number | null;
  article_reader_url: string;
}

async function getDigest(env: Env, params: { date?: string; since?: string }): Promise<DigestItem[]> {
  const qs = params.date ? `date=${params.date}` : `since=${params.since}`;
  try {
    const res = await fetch(`${env.ARTICLE_READER_API}/api/hn-digest?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: DigestItem[] };
    return data.items ?? [];
  } catch {
    return [];
  }
}

/** Build the cross-day dedup key set from recent picks (URL- and HN-id-based). */
function buildExcludeSet(recent: DigestItem[]): Set<string> {
  const keys = new Set<string>();
  for (const i of recent) {
    if (i.source_url) keys.add(dedupKey(i.source_url));
    if (i.hn_id != null) keys.add(String(i.hn_id));
    if (i.hn_url) keys.add(dedupKey(i.hn_url));
  }
  return keys;
}

// ---------- pipeline ----------

async function postArticle(env: Env, c: Candidate, content: string, today: string, rank: number): Promise<TimelyOut | null> {
  try {
    const res = await fetch(`${env.ARTICLE_READER_API}/api/article`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "url",
        source_url: c.url,
        raw_content: content,
        title: c.title,
        hn_url: c.hnUrl,
        hn_score: c.score,
        hn_comments: c.comments,
        why_picked: generateWhyPicked(c, Math.floor(Date.now() / 1000)),
        hn_id: c.hnId,
        digest_date: today,
        digest_rank: rank,
        excitement_score: undefined,
        digest_source: c.source,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    return {
      rank,
      title: data.title || c.title,
      sourceLabel: c.sourceLabel,
      hnUrl: c.hnUrl,
      score: c.score,
      comments: c.comments,
      ai_summary: data.ai_summary || "",
      ai_summary_zh: data.ai_summary_zh || undefined,
      reading_time: data.reading_time || 0,
      article_reader_url: data.url,
      origin_url: c.url,
    };
  } catch {
    return null;
  }
}

async function collectTimely(env: Env, exclude: Set<string>, today: string): Promise<TimelyOut[]> {
  const candidates = await collectTimelyCandidates(exclude);

  // Fetch body for each candidate (HN comment fallback), then summarize+record.
  const withContent: { c: Candidate; content: string }[] = [];
  for (const c of candidates) {
    let content = await fetchArticleText(c.url);
    if (!content && c.source === "hn" && c.hnId != null && (c.comments ?? 0) >= MIN_COMMENTS_FOR_FALLBACK) {
      content = await fetchHNComments(c.hnId);
    }
    if (content) withContent.push({ c, content });
  }

  const out = await Promise.all(
    withContent.map(({ c, content }, i) => postArticle(env, c, content, today, i + 1)),
  );
  return out.filter((x): x is TimelyOut => x !== null).map((x, i) => ({ ...x, rank: i + 1 }));
}

async function collectEvergreen(env: Env, exclude: Set<string>, today: string): Promise<EvergreenOut[]> {
  const cands = await collectEvergreenCandidates(exclude);
  const out: EvergreenOut[] = [];
  for (const c of cands) {
    // Record the pick in D1 for cross-day dedup (title+blurb only — no paywall body).
    try {
      await fetch(`${env.ARTICLE_READER_API}/api/article`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: "url",
          source_url: c.url,
          raw_content: `${c.title}\n\n${c.blurb ?? ""}`.trim(),
          title: c.title,
          digest_date: today,
          digest_rank: 0,
          digest_source: c.source,
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      // Recording is best-effort; still show it even if the write failed.
    }
    out.push({ title: c.title, sourceLabel: c.sourceLabel, blurb: c.blurb ?? "", url: c.url });
  }
  return out;
}

// ---------- Slack formatting ----------

// Jocelin's Slack member ID — mentioned in the daily digest so it triggers a
// push notification (plain bot messages only produce an unread badge).
const MENTION = "<@U074AC11VNV>";

function tldr(zh?: string, en?: string): string {
  const src = zh || en || "";
  const m = src.match(/TLDR[:：]\s*\**\s*(.+)/i);
  let line = m ? m[1] : src;
  line = line.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}

/** Escape mrkdwn special chars in display text (not in URLs). */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Small grey metadata line: source · votes · comments · reading time · HN link. */
function metaLine(a: TimelyOut): string {
  const parts: string[] = [];
  if (a.sourceLabel) parts.push(esc(a.sourceLabel));
  if (a.score != null) parts.push(`⬆︎ ${a.score}`);
  if (a.comments != null) parts.push(`💬 ${a.comments}`);
  if (a.reading_time) parts.push(`📖 ${a.reading_time} min`);
  if (a.hnUrl) parts.push(`<${a.hnUrl}|HN 討論>`);
  return parts.length ? parts.join("   ·   ") : "—";
}

function slackBlocks(timely: TimelyOut[], evergreen: EvergreenOut[], date: string) {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "🗞️  今日 AI・科技新聞", emoji: true } },
    { type: "context", elements: [{ type: "mrkdwn", text: `📅 ${date} · ${MENTION}` }] },
  ];

  if (timely.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "🔥  *今日即時*" } });
    timely.forEach((a, idx) => {
      // Clickable bold title → the reader page; Chinese TLDR on its own line.
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*<${a.article_reader_url}|${a.rank}. ${esc(a.title)}>*\n${esc(tldr(a.ai_summary_zh, a.ai_summary))}` },
      });
      // Metadata demoted to a small grey context line.
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: metaLine(a) }] });
      if (idx < timely.length - 1) blocks.push({ type: "divider" });
    });
  }

  if (evergreen.length) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "📖  *深度精選*" } });
    for (const e of evergreen) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*<${e.url}|${esc(e.title)}>*${e.blurb ? `\n${esc(e.blurb)}` : ""}` },
      });
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "every.to   ·   點標題讀原文" }] });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "🤖 via hn-ai-digest · HN · OpenAI · TechCrunch · The Verge · Ars · every.to" }],
  });
  // Top-level text is the mobile/lock-screen notification preview.
  return { text: `🗞️ 今日 AI・科技新聞 ${date} ${MENTION}`, blocks };
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

async function runDigest(env: Env, force = false): Promise<{ status: string; timely: number; evergreen: number; cached: boolean }> {
  const today = todayUTC();
  const dedupDays = Number(env.HN_DIGEST_DEDUP_DAYS ?? 14);

  // Today's cache: reuse if we already have timely picks for today (unless forced).
  const cachedItems = force ? [] : await getDigest(env, { date: today });
  const cachedTimely = cachedItems.filter((i) => (i.rank ?? 0) >= 1);
  const cachedEvergreen = cachedItems.filter((i) => i.digest_source === "every.to");

  let timely: TimelyOut[];
  let evergreen: EvergreenOut[];
  let usedCache = false;

  if (cachedTimely.length >= 3) {
    usedCache = true;
    timely = cachedTimely.slice(0, 5).map((i, idx) => ({
      rank: i.rank ?? idx + 1,
      title: i.title ?? "",
      sourceLabel: sourceLabelOf(i.digest_source),
      hnUrl: i.hn_url ?? undefined,
      score: i.score ?? undefined,
      comments: i.comments ?? undefined,
      ai_summary: i.ai_summary ?? "",
      ai_summary_zh: i.ai_summary_zh ?? undefined,
      reading_time: i.reading_time ?? 0,
      article_reader_url: i.article_reader_url,
      origin_url: i.source_url ?? i.article_reader_url,
    }));
    evergreen = cachedEvergreen.map((i) => ({
      title: i.title ?? "",
      sourceLabel: "every.to",
      blurb: i.ai_summary ?? "",
      url: i.source_url ?? "",
    }));
  } else {
    const recent = await getDigest(env, { since: daysAgoUTC(dedupDays) });
    const exclude = buildExcludeSet(recent);
    timely = await collectTimely(env, exclude, today);
    evergreen = await collectEvergreen(env, exclude, today);
  }

  if (timely.length === 0 && evergreen.length === 0) {
    await postToSlack(env, { text: `🗞️ Top AI/Tech News — ${today}\n(no fresh AI/tech stories found today)` });
    return { status: "empty", timely: 0, evergreen: 0, cached: usedCache };
  }

  const ok = await postToSlack(env, slackBlocks(timely, evergreen, today));
  return { status: ok ? "sent" : "slack_failed", timely: timely.length, evergreen: evergreen.length, cached: usedCache };
}

function sourceLabelOf(source?: string): string {
  switch (source) {
    case "hn": return "Hacker News";
    case "openai": return "OpenAI";
    case "techcrunch": return "TechCrunch";
    case "theverge": return "The Verge";
    case "arstechnica": return "Ars Technica";
    case "every.to": return "every.to";
    default: return "";
  }
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
    const force = url.searchParams.get("force") === "1";
    // ?sync=1 awaits the digest and returns its status (use with the fast cache
    // path; a forced fresh run can exceed the HTTP time limit).
    if (url.searchParams.get("sync") === "1") {
      const result = await runDigest(env, force);
      return new Response(JSON.stringify(result) + "\n", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Default: run in the background (like the cron) so slow summarization doesn't
    // hit the HTTP response time limit; return immediately.
    ctx.waitUntil(runDigest(env, force));
    return new Response(`queued — digest running${force ? " (forced refresh)" : ""}, will post to Slack shortly\n`, { status: 202 });
  },
};
