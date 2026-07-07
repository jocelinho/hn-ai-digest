/**
 * Fetch and process top AI/tech news — fully stateless.
 *
 * State lives entirely in the Article Reader Cloudflare D1 (via /api/hn-digest),
 * so this runs identically on any machine with no local DB / iCloud sync:
 * - "Today's cache": if D1 already has >=3 picks for today, return them
 * - Cross-day dedup: skip HN stories already picked in the last N days
 * - New picks are recorded in D1 as part of the POST /api/article call
 */

// Downstream summarization + digest-state service. Override via env for local dev.
const ARTICLE_READER_API = process.env.ARTICLE_READER_API ?? "https://article-reader.pages.dev";
// How many days back to look when deduping against previously-picked stories.
const DEDUP_WINDOW_DAYS = Number(process.env.HN_DIGEST_DEDUP_DAYS ?? 14);

interface OutputArticle {
  rank: number;
  title: string;
  hn_url: string;
  score: number;
  comments: number;
  excitement_score: number;
  posted_hours_ago: number;
  article_reader_url: string;
  article_reader_id: string;
  ai_summary: string;
  reading_time: number;
  cached: boolean;
}

interface DigestItem {
  hn_id: number;
  hn_url: string | null;
  digest_date: string;
  rank: number | null;
  excitement_score: number | null;
  title: string | null;
  ai_summary: string | null;
  reading_time: number | null;
  score: number | null;
  comments: number | null;
  article_reader_id: string;
  article_reader_url: string;
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function daysAgoStr(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().split("T")[0];
}

/** Query the digest state in D1. Returns [] on any failure (fail-open). */
async function getDigest(params: { date?: string; since?: string }): Promise<DigestItem[]> {
  const qs = params.date ? `date=${params.date}` : `since=${params.since}`;
  try {
    const res = await fetch(`${ARTICLE_READER_API}/api/hn-digest?${qs}`, {
      signal: AbortSignal.timeout(15000),
    });
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

async function main() {
  const today = todayStr();

  // Step 1: Today's cache — already picked >=3 for today? Return them.
  const todays = await getDigest({ date: today });
  if (todays.length >= 3) {
    console.error(`✅ Found ${todays.length} cached picks for ${today} (from Cloudflare)`);
    const output: OutputArticle[] = todays.slice(0, 3).map(item => ({
      rank: item.rank ?? 0,
      title: item.title ?? "",
      hn_url: item.hn_url ?? "",
      score: item.score ?? 0,
      comments: item.comments ?? 0,
      excitement_score: item.excitement_score ?? 0,
      posted_hours_ago: 0, // not tracked in digest state
      article_reader_url: item.article_reader_url,
      article_reader_id: item.article_reader_id,
      ai_summary: item.ai_summary ?? "",
      reading_time: item.reading_time ?? 0,
      cached: true,
    }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Step 2: Build cross-day dedup set from recent picks.
  const since = daysAgoStr(DEDUP_WINDOW_DAYS);
  const recent = await getDigest({ since });
  const processedIds = recent.map(i => i.hn_id).filter((x): x is number => x != null);
  console.error(`🔍 No cached picks for ${today}, fetching from HN (deduping ${processedIds.length} recent stories)...`);

  // Step 3: Fetch + rank from HN. Pass the dedup set to index.ts via env.
  const { execSync } = await import("child_process");
  const articlesJson = execSync("bun run index.ts", {
    cwd: import.meta.dir,
    encoding: "utf-8",
    env: { ...process.env, PROCESSED_HN_IDS: processedIds.join(",") },
  });

  interface HNArticle {
    rank: number;
    title: string;
    url: string;
    hn_url: string;
    hn_id: number;
    score: number;
    comments: number;
    excitement_score: number;
    posted_hours_ago: number;
    content: string;
    why_picked: string;
  }

  const hnArticles: HNArticle[] = JSON.parse(articlesJson);

  if (hnArticles.length === 0) {
    console.error("❌ No new articles found");
    process.exit(1);
  }

  // Step 4: Process through ArticleReader API — this also records the pick in D1.
  console.error(`🔄 Processing ${hnArticles.length} article(s) through ArticleReader...`);

  const results: OutputArticle[] = [];

  for (const article of hnArticles) {
    console.error(`[${article.rank}/${hnArticles.length}] Processing: ${article.title}`);

    try {
      const response = await fetch(`${ARTICLE_READER_API}/api/article`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_type: 'url',
          source_url: article.url,
          raw_content: article.content,
          title: article.title,
          hn_url: article.hn_url,
          hn_score: article.score,
          hn_comments: article.comments,
          why_picked: article.why_picked,
          // Digest selection dimension — makes the pick queryable across machines.
          hn_id: article.hn_id,
          digest_date: today,
          digest_rank: article.rank,
          excitement_score: article.excitement_score,
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        console.error(`  ❌ API failed: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      console.error(`  ✅ Processed and recorded`);

      results.push({
        rank: article.rank,
        title: data.title || article.title,
        hn_url: article.hn_url,
        score: article.score,
        comments: article.comments,
        excitement_score: article.excitement_score,
        posted_hours_ago: article.posted_hours_ago,
        article_reader_url: data.url,
        article_reader_id: data.id,
        ai_summary: data.ai_summary || "",
        reading_time: data.reading_time || 0,
        cached: false
      });
    } catch (error: any) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
