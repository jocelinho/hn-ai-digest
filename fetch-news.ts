/**
 * Fetch and process top AI/tech news with caching
 *
 * Features:
 * - Returns cached articles if already processed today
 * - Skips articles already processed on previous days
 * - Processes new articles through ArticleReader API
 * - Saves processed articles to SQLite database
 */

import { articleDb, ProcessedArticle } from "./db";

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

async function main() {
  const today = articleDb.constructor.getTodayDate();

  // Step 1: Check for today's cached articles
  const cachedArticles = articleDb.getArticlesByDate(today);

  if (cachedArticles.length >= 3) {
    console.error(`✅ Found ${cachedArticles.length} cached articles for ${today}`);

    const output: OutputArticle[] = cachedArticles.map(article => ({
      rank: article.rank,
      title: article.title,
      hn_url: article.hn_url,
      score: article.score,
      comments: article.comments,
      excitement_score: article.excitement_score,
      posted_hours_ago: 0, // Not stored
      article_reader_url: article.article_reader_url,
      article_reader_id: article.article_reader_id,
      ai_summary: "", // Not stored, will be fetched from URL if needed
      reading_time: 0, // Not stored
      cached: true
    }));

    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Step 2: Fetch new articles from HN
  console.error(`🔍 No cached articles for ${today}, fetching from HN...`);

  const { execSync } = await import("child_process");
  const articlesJson = execSync("bun run index.ts", {
    cwd: import.meta.dir,
    encoding: "utf-8"
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

  // Step 3: Process through ArticleReader API
  console.error(`🔄 Processing ${hnArticles.length} article(s) through ArticleReader...`);

  const results: OutputArticle[] = [];

  for (const article of hnArticles) {
    console.error(`[${article.rank}/${hnArticles.length}] Processing: ${article.title}`);

    try {
      const response = await fetch('https://article-reader.pages.dev/api/article', {
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
        }),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        console.error(`  ❌ API failed: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();

      // Step 4: Save to database
      const processedArticle: ProcessedArticle = {
        hn_id: article.hn_id,
        title: article.title,
        hn_url: article.hn_url,
        article_reader_url: data.url,
        article_reader_id: data.id,
        score: article.score,
        comments: article.comments,
        excitement_score: article.excitement_score,
        processed_date: today,
        processed_timestamp: Date.now(),
        rank: article.rank,
        why_picked: article.why_picked,
      };

      articleDb.saveArticle(processedArticle);
      console.error(`  ✅ Processed and saved`);

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
