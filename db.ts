import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "processed-articles.db");

export interface ProcessedArticle {
  hn_id: number;
  title: string;
  hn_url: string;
  article_reader_url: string;
  article_reader_id: string;
  score: number;
  comments: number;
  excitement_score: number;
  processed_date: string; // YYYY-MM-DD
  processed_timestamp: number;
  rank: number; // Position in that day's top 3
  why_picked?: string;
}

class ArticleDatabase {
  private db: Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_articles (
        hn_id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        hn_url TEXT NOT NULL,
        article_reader_url TEXT NOT NULL,
        article_reader_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        comments INTEGER NOT NULL,
        excitement_score REAL NOT NULL,
        processed_date TEXT NOT NULL,
        processed_timestamp INTEGER NOT NULL,
        rank INTEGER NOT NULL,
        why_picked TEXT DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_processed_date
        ON processed_articles(processed_date);

      CREATE INDEX IF NOT EXISTS idx_hn_id
        ON processed_articles(hn_id);
    `);
  }

  /**
   * Get articles processed on a specific date (YYYY-MM-DD)
   */
  getArticlesByDate(date: string): ProcessedArticle[] {
    const query = this.db.query<ProcessedArticle, string>(`
      SELECT * FROM processed_articles
      WHERE processed_date = ?
      ORDER BY rank ASC
    `);
    return query.all(date);
  }

  /**
   * Check if an article was already processed (any date)
   */
  isArticleProcessed(hnId: number): boolean {
    const query = this.db.query<{ count: number }, number>(`
      SELECT COUNT(*) as count
      FROM processed_articles
      WHERE hn_id = ?
    `);
    const result = query.get(hnId);
    return result ? result.count > 0 : false;
  }

  /**
   * Get processed date for an article
   */
  getArticleProcessedDate(hnId: number): string | null {
    const query = this.db.query<{ processed_date: string }, number>(`
      SELECT processed_date
      FROM processed_articles
      WHERE hn_id = ?
    `);
    const result = query.get(hnId);
    return result ? result.processed_date : null;
  }

  /**
   * Save a processed article
   */
  saveArticle(article: ProcessedArticle): void {
    const query = this.db.query(`
      INSERT OR REPLACE INTO processed_articles
      (hn_id, title, hn_url, article_reader_url, article_reader_id,
       score, comments, excitement_score, processed_date, processed_timestamp, rank, why_picked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    query.run(
      article.hn_id,
      article.title,
      article.hn_url,
      article.article_reader_url,
      article.article_reader_id,
      article.score,
      article.comments,
      article.excitement_score,
      article.processed_date,
      article.processed_timestamp,
      article.rank,
      article.why_picked || ""
    );
  }

  /**
   * Get today's date in YYYY-MM-DD format
   */
  static getTodayDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  close() {
    this.db.close();
  }
}

export const articleDb = new ArticleDatabase();
