import Database from "better-sqlite3";
import * as sqlite_vec from "sqlite-vec";
import { IVectorStore, VectorMatch, CacheMetadata, ContentEntry } from "./types.js";
import { cosineSimilarity } from "./utils.js";

export class SQLiteVectorStore implements IVectorStore {
  private db: Database.Database;
  private isVecEnabled: boolean = false;

  constructor(dbPath: string = "cache.db") {
    this.db = new Database(dbPath);
    // Cache data is reconstructable; keep SQLite journals in memory to avoid delete I/O failures on restricted filesystems.
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    this.tryEnableVec();
    this.init();
  }

  private tryEnableVec() {
    try {
      sqlite_vec.load(this.db);
      this.isVecEnabled = true;
      console.error("sqlite-vec extension loaded successfully.");
    } catch (error) {
      console.error("Failed to load sqlite-vec, falling back to JS-based search:", error);
      this.isVecEnabled = false;
    }
  }

  private init() {
    // Content cache table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_cache (
        url TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);

    if (this.isVecEnabled) {
      try {
        // High-performance vector table
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS semantic_cache_vec USING vec0(
            id TEXT PRIMARY KEY,
            embedding float[384]
          );
          
          CREATE TABLE IF NOT EXISTS semantic_cache_metadata (
            id TEXT PRIMARY KEY,
            metadata TEXT NOT NULL,
            timestamp INTEGER NOT NULL
          );
        `);
        return;
      } catch (error) {
        console.error("Failed to initialize sqlite-vec tables, falling back to JS-based search:", error);
        this.isVecEnabled = false;
      }
    }

    if (!this.isVecEnabled) {
      // Fallback JS-based table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_cache_fallback (
          id TEXT PRIMARY KEY,
          vector TEXT NOT NULL,
          metadata TEXT NOT NULL,
          timestamp INTEGER NOT NULL
        );
      `);
    } else {
      return;
    }
  }

  async add(id: string, vector: number[], metadata: CacheMetadata): Promise<void> {
    if (this.isVecEnabled) {
      const vecStmt = this.db.prepare("INSERT OR REPLACE INTO semantic_cache_vec(id, embedding) VALUES (?, ?)");
      const metaStmt = this.db.prepare("INSERT OR REPLACE INTO semantic_cache_metadata(id, metadata, timestamp) VALUES (?, ?, ?)");
      
      const transaction = this.db.transaction((id, vec, meta) => {
        vecStmt.run(id, new Float32Array(vec));
        metaStmt.run(id, JSON.stringify(meta), Date.now());
      });
      transaction(id, vector, metadata);
    } else {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO vector_cache_fallback (id, vector, metadata, timestamp) VALUES (?, ?, ?, ?)"
      );
      stmt.run(id, JSON.stringify(vector), JSON.stringify(metadata), Date.now());
    }
  }

  async search(vector: number[], limit: number, namespace?: string): Promise<VectorMatch[]> {
    if (this.isVecEnabled) {
      // SQLite-vec KNN search
      const rows = this.db.prepare(`
        SELECT 
          v.id,
          vec_distance_cosine(v.embedding, ?) as distance,
          m.metadata
        FROM semantic_cache_vec v
        JOIN semantic_cache_metadata m ON v.id = m.id
        WHERE (? IS NULL OR COALESCE(json_extract(m.metadata, '$.namespace'), 'fallback') = ?)
        ORDER BY distance ASC
        LIMIT ?
      `).all(new Float32Array(vector), namespace ?? null, namespace ?? null, limit) as any[];

      return rows.map(row => ({
        id: row.id,
        score: 1 - row.distance, // Convert cosine distance to similarity
        metadata: JSON.parse(row.metadata)
      }));
    } else {
      // Fallback JS-based search
      const rows = this.db.prepare("SELECT id, vector, metadata FROM vector_cache_fallback").all() as any[];
      
      const results: VectorMatch[] = rows.map((row) => {
        const storedVector = JSON.parse(row.vector) as number[];
        const score = cosineSimilarity(vector, storedVector);
        return {
          id: row.id,
          score,
          metadata: JSON.parse(row.metadata),
        };
      });

      return results
        .filter((result) => namespace === undefined || (result.metadata.namespace ?? "fallback") === namespace)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    }
  }

  async clear(): Promise<void> {
    this.db.prepare("DELETE FROM content_cache").run();
    if (this.isVecEnabled) {
      this.db.prepare("DELETE FROM semantic_cache_vec").run();
      this.db.prepare("DELETE FROM semantic_cache_metadata").run();
    } else {
      this.db.prepare("DELETE FROM vector_cache_fallback").run();
    }
  }

  getStats(): { contentCount: number; vectorCount: number } {
    const contentCount = (this.db.prepare("SELECT COUNT(*) as count FROM content_cache").get() as { count: number }).count;
    let vectorCount = 0;
    if (this.isVecEnabled) {
      vectorCount = (this.db.prepare("SELECT COUNT(*) as count FROM semantic_cache_metadata").get() as { count: number }).count;
    } else {
      vectorCount = (this.db.prepare("SELECT COUNT(*) as count FROM vector_cache_fallback").get() as { count: number }).count;
    }
    return { contentCount, vectorCount };
  }

  async getContent(url: string): Promise<ContentEntry | null> {
    const row = this.db.prepare("SELECT * FROM content_cache WHERE url = ?").get(url) as ContentEntry | undefined;
    return row || null;
  }

  async setContent(url: string, content: string, category: string): Promise<void> {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO content_cache (url, content, category, timestamp) VALUES (?, ?, ?, ?)"
    );
    stmt.run(url, content, category, Date.now());
  }

  deleteExpiredContent(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.db.prepare("DELETE FROM content_cache WHERE timestamp < ?").run(cutoff);
    return result.changes;
  }

  close() {
    this.db.close();
  }
}
