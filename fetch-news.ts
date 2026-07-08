/**
 * Fetch and process the daily AI/tech digest — manual / local version of the News skill.
 *
 * Shares ALL selection logic with the scheduled Slack worker via ./src/sources.ts,
 * so "fetch top news" locally sees the exact same candidates as the 09:00 Slack digest.
 * The only differences here: (1) uses jsdom+Readability for higher-quality article
 * text extraction (bun can, the Worker can't), (2) prints structured JSON for the
 * skill to render + open in the browser instead of posting to Slack.
 *
 * Fully stateless — today's-cache + cross-day dedup both come from Cloudflare D1
 * (article-reader /api/hn-digest), so this runs identically on any machine.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import {
  Candidate,
  HtmlExtractor,
  collectTimelyCandidates,
  collectEvergreenCandidates,
  fetchArticleText,
  fetchHNComments,
  generateWhyPicked,
  dedupKey,
} from "./src/sources";

const ARTICLE_READER_API = process.env.ARTICLE_READER_API ?? "https://article-reader.pages.dev";
const DEDUP_WINDOW_DAYS = Number(process.env.HN_DIGEST_DEDUP_DAYS ?? 14);
const MIN_COMMENTS_FOR_FALLBACK = 20;

// Higher-quality extractor than the Worker-safe regex fallback: strips nav/ads/
// boilerplate via Readability. Injected into the shared fetchArticleText.
const readabilityExtractor: HtmlExtractor = (html, url) => {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = article?.textContent?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null;
  }
};

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
  article_reader_id?: string;
  article_reader_url: string;
}

interface TimelyOut {
  rank: number;
  title: string;
  source: string;
  ai_summary: string;
  ai_summary_zh?: string;
  article_reader_url: string;
  article_reader_id?: string;
  hn_url?: string;
  origin_url: string;
  score?: number;
  comments?: number;
  reading_time: number;
  cached: boolean;
}

interface EvergreenOut {
  title: string;
  source: string;
  blurb: string;
  url: string;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}
function daysAgoStr(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/** Query digest state in D1. Fail-open to []. */
async function getDigest(params: { date?: string; since?: string }): Promise<DigestItem[]> {
  const qs = params.date ? `date=${params.date}` : `since=${params.since}`;
  try {
    const res = await fetch(`${ARTICLE_READER_API}/api/hn-digest?${qs}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      console.error(`⚠️  hn-digest query failed: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    return (data.items ?? []) as DigestItem[];
  } catch (error: any) {
    console.error(`⚠️  hn-digest query error: ${error.message}`);
    return [];
  }
}

function buildExcludeSet(recent: DigestItem[]): Set<string> {
  const keys = new Set<string>();
  for (const i of recent) {
    if (i.source_url) keys.add(dedupKey(i.source_url));
    if (i.hn_id != null) keys.add(String(i.hn_id));
    if (i.hn_url) keys.add(dedupKey(i.hn_url));
  }
  return keys;
}

async function postArticle(c: Candidate, content: string, today: string, rank: number): Promise<TimelyOut | null> {
  try {
    const res = await fetch(`${ARTICLE_READER_API}/api/article`, {
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
        digest_source: c.source,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      console.error(`  ❌ API failed: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    console.error(`  ✅ ${c.sourceLabel}: ${c.title.slice(0, 60)}`);
    return {
      rank,
      title: data.title || c.title,
      source: c.sourceLabel,
      ai_summary: data.ai_summary || "",
      ai_summary_zh: data.ai_summary_zh || undefined,
      article_reader_url: data.url,
      article_reader_id: data.id,
      hn_url: c.hnUrl,
      origin_url: c.url,
      score: c.score,
      comments: c.comments,
      reading_time: data.reading_time || 0,
      cached: false,
    };
  } catch (error: any) {
    console.error(`  ❌ Failed: ${error.message}`);
    return null;
  }
}

async function main() {
  const today = todayStr();
  const force = process.argv.includes("--force") || process.env.FORCE_REFRESH === "1";

  // Step 1: Today's cache — reuse if we already have timely picks for today (unless forced).
  const cachedItems = force ? [] : await getDigest({ date: today });
  const cachedTimely = cachedItems.filter((i) => (i.rank ?? 0) >= 1);
  const cachedEvergreen = cachedItems.filter((i) => i.digest_source === "every.to");

  if (cachedTimely.length >= 3) {
    console.error(`✅ Found ${cachedTimely.length} cached picks for ${today} (from Cloudflare)`);
    const timely: TimelyOut[] = cachedTimely.slice(0, 5).map((i, idx) => ({
      rank: i.rank ?? idx + 1,
      title: i.title ?? "",
      source: sourceLabelOf(i.digest_source),
      ai_summary: i.ai_summary ?? "",
      ai_summary_zh: i.ai_summary_zh ?? undefined,
      article_reader_url: i.article_reader_url,
      article_reader_id: i.article_reader_id,
      hn_url: i.hn_url ?? undefined,
      origin_url: i.source_url ?? i.article_reader_url,
      score: i.score ?? undefined,
      comments: i.comments ?? undefined,
      reading_time: i.reading_time ?? 0,
      cached: true,
    }));
    const evergreen: EvergreenOut[] = cachedEvergreen.map((i) => ({
      title: i.title ?? "",
      source: "every.to",
      blurb: i.ai_summary ?? "",
      url: i.source_url ?? "",
    }));
    console.log(JSON.stringify({ date: today, cached: true, timely, evergreen }, null, 2));
    return;
  }

  // Step 2: Cross-day dedup set from recent picks.
  const recent = await getDigest({ since: daysAgoStr(DEDUP_WINDOW_DAYS) });
  const exclude = buildExcludeSet(recent);
  console.error(`🔍 No cache for ${today}; collecting from all sources (deduping ${exclude.size} recent keys)...`);

  // Step 3: Collect timely candidates (shared selection), fetch body, summarize+record.
  const candidates = await collectTimelyCandidates(exclude);
  console.error(`📰 ${candidates.length} timely candidate(s): ${candidates.map((c) => c.source).join(", ")}`);

  const timely: TimelyOut[] = [];
  let rank = 1;
  for (const c of candidates) {
    let content = await fetchArticleText(c.url, readabilityExtractor);
    if (!content && c.source === "hn" && c.hnId != null && (c.comments ?? 0) >= MIN_COMMENTS_FOR_FALLBACK) {
      content = await fetchHNComments(c.hnId);
    }
    if (!content) {
      console.error(`  ⏭️  ${c.sourceLabel}: no content — ${c.title.slice(0, 50)}`);
      continue;
    }
    const out = await postArticle(c, content, today, rank);
    if (out) timely.push({ ...out, rank: rank++ });
  }

  // Step 4: One evergreen every.to essay (title + public blurb, no paywall body).
  const evCands = await collectEvergreenCandidates(exclude);
  const evergreen: EvergreenOut[] = [];
  for (const c of evCands) {
    try {
      await fetch(`${ARTICLE_READER_API}/api/article`, {
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
      /* best-effort record */
    }
    evergreen.push({ title: c.title, source: c.sourceLabel, blurb: c.blurb ?? "", url: c.url });
  }

  if (timely.length === 0 && evergreen.length === 0) {
    console.error("❌ No new articles found");
    process.exit(1);
  }

  console.log(JSON.stringify({ date: today, cached: false, timely, evergreen }, null, 2));
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

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
