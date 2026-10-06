import Database from "better-sqlite3";
import * as sqlite_vec from "sqlite-vec";
import { createHash } from "node:crypto";
import { chunkText } from "./chunker.js";

export type KnowledgeDocInput = {
  title?: string;
  source?: string;
  category?: string;
  content: string;
};

export type KnowledgeDoc = {
  id: string;
  source: string;
  title: string;
  category: string;
  content: string;
  chunkCount: number;
  timestamp: number;
};

export type KnowledgeChunkHit = {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  title: string;
  source: string;
  score: number;
  matchedBy: "fts" | "vector" | "hybrid";
};

const EMBEDDING_DIM = 384;

function makeId(parts: string[]): string {
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

export class KnowledgeIndex {
  private db: Database.Database;
  private isVecEnabled = false;
  private closed = false;
  private pendingEmbeddings: Promise<void> = Promise.resolve();

  constructor(dbPath: string = "websearch_cache.db", options: { enableEmbeddings?: boolean } = {}) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    if (options.enableEmbeddings !== false) this.tryEnableVec();
    this.init();
  }

  private tryEnableVec() {
    try {
      sqlite_vec.load(this.db);
      this.isVecEnabled = true;
    } catch (error) {
      console.error("KnowledgeIndex: sqlite-vec unavailable, hybrid search degrades to FTS:", error);
      this.isVecEnabled = false;
    }
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_docs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        doc_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (doc_id) REFERENCES knowledge_docs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(doc_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_docs_source ON knowledge_docs(source);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        chunk_id UNINDEXED,
        doc_id UNINDEXED,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);

    if (this.isVecEnabled) {
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_vec USING vec0(
            id TEXT PRIMARY KEY,
            embedding float[${EMBEDDING_DIM}]
          );
        `);
      } catch (error) {
        console.error("KnowledgeIndex: vec table init failed, using FTS only:", error);
        this.isVecEnabled = false;
      }
    }
  }

  ingest(input: KnowledgeDocInput): KnowledgeDoc {
    const content = input.content.trim();
    if (!content) {
      throw new Error("ingest requires non-empty content");
    }

    const source = (input.source || "inline").trim();
    const title = (input.title || source || "Untitled").trim();
    const category = (input.category || "general").trim();
    const chunks = chunkText(content);
    const timestamp = Date.now();
    const docId = makeId([source, title, String(content.length), String(timestamp)]);

    const insertDoc = this.db.prepare(`
      INSERT INTO knowledge_docs (id, source, title, category, content, chunk_count, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT INTO knowledge_chunks (id, doc_id, chunk_index, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO knowledge_chunks_fts (chunk_id, doc_id, text) VALUES (?, ?, ?)
    `);

    const run = this.db.transaction(() => {
      insertDoc.run(docId, source, title, category, content, chunks.length, timestamp);
      for (const chunk of chunks) {
        const chunkId = `${docId}:${chunk.index}`;
        insertChunk.run(chunkId, docId, chunk.index, chunk.text, timestamp);
        insertFts.run(chunkId, docId, chunk.text);
      }
    });
    run();

    const embedJob = this.embedChunks(docId, chunks.map((chunk) => ({ id: `${docId}:${chunk.index}`, text: chunk.text })));
    this.pendingEmbeddings = this.pendingEmbeddings.then(() => embedJob).catch(() => undefined);

    return {
      id: docId,
      source,
      title,
      category,
      content,
      chunkCount: chunks.length,
      timestamp,
    };
  }

  private async embedChunks(docId: string, chunks: { id: string; text: string }[]): Promise<void> {
    if (!this.isVecEnabled || chunks.length === 0 || this.closed) return;

    try {
      const { TransformersEmbeddingProvider } = await import("../cache/embedding.js");
      const provider = new TransformersEmbeddingProvider();

      for (const chunk of chunks) {
        if (this.closed) return;
        const embedding = await provider.getEmbedding(chunk.text);
        if (this.closed) return;
        if (embedding.length === EMBEDDING_DIM) {
          this.db.prepare("INSERT OR REPLACE INTO knowledge_chunks_vec(id, embedding) VALUES (?, ?)")
            .run(chunk.id, new Float32Array(embedding));
        }
      }
      console.error(`KnowledgeIndex: embedded ${chunks.length} chunks for doc ${docId.slice(0, 8)}`);
    } catch (error) {
      if (!this.closed) {
        console.error("KnowledgeIndex: embedding failed, chunk remains FTS-only:", error);
      }
    }
  }

  /** Wait for background embedding jobs to settle (used by tests/tools). */
  async flush(): Promise<void> {
    await this.pendingEmbeddings;
  }

  async search(
    query: string,
    limit: number = 5,
    options?: { source?: string; embed?: (text: string) => Promise<number[]> },
  ): Promise<KnowledgeChunkHit[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ftsHits = this.searchFts(trimmed, limit * 3, options?.source);
    const vectorHits = await this.searchVector(trimmed, limit * 3, options);

    return fuseChunkHits(ftsHits, vectorHits, limit);
  }

  private searchFts(query: string, limit: number, source?: string): KnowledgeChunkHit[] {
    // Escape FTS5 query by quoting each token; supports prefix match on last token.
    const tokens = query
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .map((token) => token.replace(/"/g, ""))
      .filter(Boolean);

    if (tokens.length === 0) return [];

    const ftsQuery = tokens.map((token, index) =>
      index === tokens.length - 1 ? `"${token}"*` : `"${token}"`
    ).join(" OR ");

    try {
      const rows = this.db.prepare(`
        SELECT c.id AS chunkId, c.doc_id AS docId, c.chunk_index AS chunkIndex, c.text AS text,
               d.title AS title, d.source AS source,
               bm25(knowledge_chunks_fts) AS rank
        FROM knowledge_chunks_fts
        JOIN knowledge_chunks c ON c.id = knowledge_chunks_fts.chunk_id
        JOIN knowledge_docs d ON d.id = c.doc_id
        WHERE knowledge_chunks_fts MATCH ?
          AND (? IS NULL OR d.source = ?)
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, source ?? null, source ?? null, limit) as Array<{
        chunkId: string;
        docId: string;
        chunkIndex: number;
        text: string;
        title: string;
        source: string;
        rank: number;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunkId,
        docId: row.docId,
        chunkIndex: row.chunkIndex,
        text: row.text,
        title: row.title,
        source: row.source,
        // bm25() is lower-is-better; convert to a positive rank score.
        score: 1 / (1 + Math.max(row.rank, 0)),
        matchedBy: "fts" as const,
      }));
    } catch (error) {
      console.error("KnowledgeIndex: FTS query failed:", error);
      return [];
    }
  }

  private async searchVector(
    query: string,
    limit: number,
    options?: { source?: string; embed?: (text: string) => Promise<number[]> },
  ): Promise<KnowledgeChunkHit[]> {
    if (!this.isVecEnabled) return [];

    try {
      const embed = options?.embed;
      let vector: number[] = [];
      if (embed) {
        vector = await embed(query);
      } else {
        const { TransformersEmbeddingProvider } = await import("../cache/embedding.js");
        vector = await new TransformersEmbeddingProvider().getEmbedding(query);
      }
      if (vector.length !== EMBEDDING_DIM) return [];

      const sourceFilter = options?.source ?? null;
      const rows = this.db.prepare(`
        SELECT c.id AS chunkId, c.doc_id AS docId, c.chunk_index AS chunkIndex, c.text AS text,
               d.title AS title, d.source AS source,
               vec_distance_cosine(v.embedding, ?) AS distance
        FROM knowledge_chunks_vec v
        JOIN knowledge_chunks c ON c.id = v.id
        JOIN knowledge_docs d ON d.id = c.doc_id
        WHERE (? IS NULL OR d.source = ?)
        ORDER BY distance ASC
        LIMIT ?
      `).all(new Float32Array(vector), sourceFilter, sourceFilter, limit) as Array<{
        chunkId: string;
        docId: string;
        chunkIndex: number;
        text: string;
        title: string;
        source: string;
        distance: number;
      }>;

      return rows.map((row) => ({
        chunkId: row.chunkId,
        docId: row.docId,
        chunkIndex: row.chunkIndex,
        text: row.text,
        title: row.title,
        source: row.source,
        score: 1 - row.distance,
        matchedBy: "vector" as const,
      }));
    } catch (error) {
      console.error("KnowledgeIndex: vector search failed:", error);
      return [];
    }
  }

  getDoc(docId: string): KnowledgeDoc | null {
    const row = this.db.prepare(`
      SELECT id, source, title, category, content, chunk_count AS chunkCount, timestamp
      FROM knowledge_docs WHERE id = ?
    `).get(docId) as KnowledgeDoc | undefined;
    return row ?? null;
  }

  listDocs(limit: number = 50): Array<Omit<KnowledgeDoc, "content">> {
    return this.db.prepare(`
      SELECT id, source, title, category, chunk_count AS chunkCount, timestamp
      FROM knowledge_docs
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Array<Omit<KnowledgeDoc, "content">>;
  }

  deleteDoc(docId: string): boolean {
    const doc = this.getDoc(docId);
    if (!doc) return false;

    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM knowledge_chunks WHERE doc_id = ?").run(docId);
      this.db.prepare("DELETE FROM knowledge_docs WHERE id = ?").run(docId);
      this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE doc_id = ?").run(docId);
      if (this.isVecEnabled) {
        this.db.prepare(
          "DELETE FROM knowledge_chunks_vec WHERE id IN (SELECT id FROM knowledge_chunks WHERE doc_id = ?)",
        ).run(docId);
      }
    });
    run();
    return true;
  }

  getStats(): { docCount: number; chunkCount: number; vectorCount: number } {
    const docCount = (this.db.prepare("SELECT COUNT(*) AS c FROM knowledge_docs").get() as { c: number }).c;
    const chunkCount = (this.db.prepare("SELECT COUNT(*) AS c FROM knowledge_chunks").get() as { c: number }).c;
    let vectorCount = 0;
    if (this.isVecEnabled) {
      vectorCount = (this.db.prepare("SELECT COUNT(*) AS c FROM knowledge_chunks_vec").get() as { c: number }).c;
    }
    return { docCount, chunkCount, vectorCount };
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }
}

const RRF_K = 60;

export function fuseChunkHits(
  ftsHits: KnowledgeChunkHit[],
  vectorHits: KnowledgeChunkHit[],
  limit: number,
): KnowledgeChunkHit[] {
  const scores = new Map<string, { hit: KnowledgeChunkHit; score: number; sources: Set<string> }>();

  const addList = (hits: KnowledgeChunkHit[], label: "fts" | "vector") => {
    hits.forEach((hit, index) => {
      const existing = scores.get(hit.chunkId);
      const contribution = 1 / (RRF_K + index + 1);
      if (existing) {
        existing.score += contribution;
        existing.sources.add(label);
      } else {
        scores.set(hit.chunkId, {
          hit,
          score: contribution,
          sources: new Set([label]),
        });
      }
    });
  };

  addList(ftsHits, "fts");
  addList(vectorHits, "vector");

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      ...entry.hit,
      score: entry.score,
      matchedBy: entry.sources.size >= 2 ? "hybrid" : entry.hit.matchedBy,
    }));
}
