import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { articleDb, ProcessedArticle } from "./db";

const HN_API = "https://hacker-news.firebaseio.com/v0";
const MIN_CONTENT_LENGTH = 200;
const MIN_COMMENTS_FOR_FALLBACK = 20;

const AI_KEYWORDS = [
  // Companies
  "openai", "anthropic", "deepmind", "mistral", "perplexity", "xai",
  // Products
  "chatgpt", "gpt-4", "gpt-5", "claude", "gemini", "llama", "grok",
  // General (with word boundaries to avoid false positives)
  "\\bai\\b", "\\bllm\\b", "\\bagi\\b",
  // Specific terms
  "large language model", "machine learning", "neural network",
  "transformer", "diffusion model", "multimodal"
];

const KEYWORD_REGEX = new RegExp(AI_KEYWORDS.join("|"), "i");

interface HNItem {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  time: number;
  descendants: number;
  kids?: number[];
}

interface HNComment {
  id: number;
  by: string;
  text: string;
  time: number;
  kids?: number[];
}

interface RankedArticle {
  rank: number;
  title: string;
  url: string;
  hn_url: string;
  hn_id?: number; // HN story ID
  score: number;
  comments: number;
  excitement_score: number;
  posted_hours_ago: number;
  content: string;
  content_source: "article" | "hn_comments";
  why_picked: string;
  article_reader_url?: string; // Present if cached
  article_reader_id?: string; // Present if cached
}

async function fetchItem<T>(id: number): Promise<T | null> {
  try {
    const res = await fetch(`${HN_API}/item/${id}.json`);
    return res.json();
  } catch {
    return null;
  }
}

async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HN-AI-Digest/1.0)"
      }
    });
    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    const content = article?.textContent?.trim();

    // Validate content is meaningful
    if (content && content.length >= MIN_CONTENT_LENGTH && !content.includes("Something went wrong")) {
      return content;
    }
    return null;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchHNComments(storyId: number, limit = 5): Promise<string | null> {
  const story = await fetchItem<HNItem>(storyId);
  if (!story?.kids || story.kids.length === 0) return null;

  const commentIds = story.kids.slice(0, limit);
  const comments = await Promise.all(
    commentIds.map(id => fetchItem<HNComment>(id))
  );

  const validComments = comments
    .filter((c): c is HNComment => c !== null && !!c.text && !c.text.includes("[dead]"))
    .map(c => `[${c.by}]: ${stripHtml(c.text)}`)
    .join("\n\n");

  if (validComments.length >= MIN_CONTENT_LENGTH) {
    return `[Top HN Comments]\n\n${validComments}`;
  }
  return null;
}

async function getTopStories(limit = 100): Promise<number[]> {
  const res = await fetch(`${HN_API}/topstories.json`);
  const ids: number[] = await res.json();
  return ids.slice(0, limit);
}

function calculateExcitement(item: HNItem): number {
  const hoursAgo = (Date.now() / 1000 - item.time) / 3600;
  const velocity = item.score / Math.max(hoursAgo, 0.5);
  const commentEngagement = item.descendants * 0.5;
  return velocity + commentEngagement + item.score * 0.1;
}

function matchesAI(title: string): boolean {
  return KEYWORD_REGEX.test(title);
}

function generateWhyPicked(item: HNItem, excitement: number, hoursAgo: number): string {
  const parts: string[] = [];

  // Velocity signal
  const pointsPerHour = Math.round(item.score / Math.max(hoursAgo, 0.5));
  if (pointsPerHour > 100) {
    parts.push(`Viral velocity — ${pointsPerHour} points/hour`);
  } else if (pointsPerHour > 30) {
    parts.push(`Fast-rising — ${pointsPerHour} points/hour`);
  }

  // Scale signal
  if (item.score > 1000) {
    parts.push(`${item.score.toLocaleString()} points — rare breakout story`);
  } else if (item.score > 500) {
    parts.push(`${item.score.toLocaleString()} points — high community interest`);
  }

  // Engagement signal
  const commentRatio = item.descendants / Math.max(item.score, 1);
  if (item.descendants > 500) {
    parts.push(`${item.descendants.toLocaleString()} comments — massive debate`);
  } else if (commentRatio > 0.5) {
    parts.push(`High comment ratio (${Math.round(commentRatio * 100)}%) — polarizing topic`);
  } else if (item.descendants > 100) {
    parts.push(`${item.descendants} comments — active discussion`);
  }

  // AI relevance
  const titleLower = item.title.toLowerCase();
  if (/facial recognition|surveillance|privacy/.test(titleLower)) {
    parts.push("AI civil liberties implications");
  } else if (/interview|hiring|job/.test(titleLower)) {
    parts.push("AI disrupting hiring practices");
  } else if (/regulation|ban|policy|guideline/.test(titleLower)) {
    parts.push("AI governance and policy");
  }

  if (parts.length === 0) {
    parts.push(`Excitement score: ${excitement} — top-ranked AI/tech story`);
  }

  return parts.slice(0, 3).join(". ") + ".";
}

async function getTopAIArticles(count = 3): Promise<RankedArticle[]> {
  const today = articleDb.constructor.getTodayDate();

  // Check if we already have today's articles cached
  const cachedArticles = articleDb.getArticlesByDate(today);
  if (cachedArticles.length >= count) {
    console.error(`✅ Found ${cachedArticles.length} cached articles for ${today}`);

    // Return cached articles in the expected format
    // Note: We don't have the content stored, so we'll return empty content
    // The News skill should just open the URLs without processing
    return cachedArticles.map(article => ({
      rank: article.rank,
      title: article.title,
      url: article.hn_url, // Use HN URL as placeholder
      hn_url: article.hn_url,
      score: article.score,
      comments: article.comments,
      excitement_score: article.excitement_score,
      posted_hours_ago: 0, // Not stored, placeholder
      content: "", // Empty, will be skipped
      content_source: "article" as const,
      why_picked: article.why_picked || "",
      article_reader_url: article.article_reader_url,
      article_reader_id: article.article_reader_id
    }));
  }

  console.error(`🔍 No cached articles for ${today}, fetching from HN...`);

  const topIds = await getTopStories(100);
  const items = await Promise.all(topIds.map(id => fetchItem<HNItem>(id)));

  const aiItems = items
    .filter((item): item is HNItem =>
      item !== null &&
      item.url !== undefined &&
      matchesAI(item.title)
    )
    .map(item => ({
      item,
      excitement: calculateExcitement(item)
    }))
    .sort((a, b) => b.excitement - a.excitement);

  const results: RankedArticle[] = [];
  let rank = 1;
  let skippedCount = 0;

  for (const entry of aiItems) {
    if (results.length >= count) break;

    // Skip if already processed in previous days
    if (articleDb.isArticleProcessed(entry.item.id)) {
      const processedDate = articleDb.getArticleProcessedDate(entry.item.id);
      console.error(`⏭️  Skipping "${entry.item.title}" (already processed on ${processedDate})`);
      skippedCount++;
      continue;
    }

    // Try 1: Fetch article content directly
    let content = await fetchArticleContent(entry.item.url!);
    let contentSource: "article" | "hn_comments" = "article";

    // Try 2: Fall back to HN comments if article fails
    if (!content && entry.item.descendants >= MIN_COMMENTS_FOR_FALLBACK) {
      content = await fetchHNComments(entry.item.id);
      contentSource = "hn_comments";
    }

    // Skip if no content available
    if (!content) {
      continue;
    }

    const hoursAgo = Math.round((Date.now() / 1000 - entry.item.time) / 3600 * 10) / 10;

    results.push({
      rank: rank++,
      title: entry.item.title,
      url: entry.item.url!,
      hn_url: `https://news.ycombinator.com/item?id=${entry.item.id}`,
      hn_id: entry.item.id,
      score: entry.item.score,
      comments: entry.item.descendants,
      excitement_score: Math.round(entry.excitement * 10) / 10,
      posted_hours_ago: hoursAgo,
      content,
      content_source: contentSource,
      why_picked: generateWhyPicked(entry.item, Math.round(entry.excitement * 10) / 10, hoursAgo),
    });
  }

  if (skippedCount > 0) {
    console.error(`📊 Skipped ${skippedCount} previously processed article(s)`);
  }

  return results;
}

// Main execution
const articles = await getTopAIArticles(3);
console.log(JSON.stringify(articles, null, 2));
