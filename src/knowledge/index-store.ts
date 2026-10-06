import Database from "better-sqlite3";
import * as sqlite_vec from "sqlite-vec";
import { randomUUID } from "node:crypto";
import { chunkText } from "./chunker.js";
import type { TransformersEmbeddingProvider } from "../cache/embedding.js";
import { assertRequestContext, InvocationError, type Permission, type RequestContext } from "../runtime/request-context.js";

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

export class KnowledgeIndex {
  private db: Database.Database;
  private isVecEnabled = false;
  private vecLoaded = false;
  private closed = false;
  private pendingEmbeddings: Promise<void> = Promise.resolve();
  private pendingEmbeddingChunks = 0;
  private readonly maxPendingEmbeddingChunks: number;
  private embeddingProvider?: Promise<TransformersEmbeddingProvider>;
  private readonly context?: RequestContext;
  private readonly scope: readonly [string, string, string];
  private readonly scopeWhere = "execution_mode = ? AND tenant_id = ? AND workspace_id = ?";
  private readonly docScopeWhere = "d.execution_mode = ? AND d.tenant_id = ? AND d.workspace_id = ?";

  constructor(dbPath: string = "websearch_cache.db", options: { enableEmbeddings?: boolean; context?: RequestContext; maxPendingEmbeddingChunks?: number } = {}) {
    // Omitted context is the legacy local adapter; an invalid supplied context cannot fall back.
    if ("context" in options) assertRequestContext(options.context);
    this.maxPendingEmbeddingChunks = options.maxPendingEmbeddingChunks ?? 256;
    if (!Number.isSafeInteger(this.maxPendingEmbeddingChunks) || this.maxPendingEmbeddingChunks <= 0) {
      throw new InvocationError("invalid_embedding_queue_limit");
    }
    this.context = options.context;
    this.scope = this.context ? [this.context.mode, this.context.tenantId, this.context.workspaceId] : ["local", "local", "local"];
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    if (options.enableEmbeddings !== false) this.tryEnableVec();
    try { this.init(); } catch (error) { this.db.close(); throw error; }
  }

  private tryEnableVec() {
    try {
      sqlite_vec.load(this.db);
      this.vecLoaded = true;
      this.isVecEnabled = true;
    } catch (error) {
      console.error("KnowledgeIndex: sqlite-vec unavailable, hybrid search degrades to FTS:", error);
      this.isVecEnabled = false;
    }
  }

  private init() {
    this.db.transaction(() => this.initSchema())();
  }

  private initSchema() {
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

    const columns = new Set((this.db.pragma("table_info(knowledge_docs)") as Array<{ name: string }>).map(column => column.name));
    for (const name of ["execution_mode", "tenant_id", "workspace_id"]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE knowledge_docs ADD COLUMN ${name} TEXT NOT NULL DEFAULT 'local'`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_knowledge_docs_scope ON knowledge_docs(execution_mode, tenant_id, workspace_id, timestamp)");

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

  private authorize(permission: Permission): void {
    if (!this.context) return;
    assertRequestContext(this.context);
    if (!this.context.permissions.includes(permission)) throw new InvocationError("forbidden");
  }

  private hasVectorTable(): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks_vec'").get()) return false;
    // Disabling inference must not disable deletion/statistics for persisted vectors.
    if (!this.vecLoaded) { sqlite_vec.load(this.db); this.vecLoaded = true; }
    return true;
  }

  ingest(input: KnowledgeDocInput): KnowledgeDoc {
    this.authorize("knowledge:write");
    const content = input.content.trim();
    if (!content) {
      throw new Error("ingest requires non-empty content");
    }

    const source = (input.source || "inline").trim();
    const title = (input.title || source || "Untitled").trim();
    const category = (input.category || "general").trim();
    const chunks = chunkText(content);
    if (this.isVecEnabled && chunks.length > this.maxPendingEmbeddingChunks - this.pendingEmbeddingChunks) {
      throw new InvocationError("embedding_queue_full");
    }
    const timestamp = Date.now();
    // Opaque global ids keep chunk/vector references unique even for concurrent identical inputs.
    const docId = randomUUID();

    const insertDoc = this.db.prepare(`
      INSERT INTO knowledge_docs (id, source, title, category, content, chunk_count, timestamp, execution_mode, tenant_id, workspace_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = this.db.prepare(`
      INSERT INTO knowledge_chunks (id, doc_id, chunk_index, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO knowledge_chunks_fts (chunk_id, doc_id, text) VALUES (?, ?, ?)
    `);

    const run = this.db.transaction(() => {
      insertDoc.run(docId, source, title, category, content, chunks.length, timestamp, ...this.scope);
      for (const chunk of chunks) {
        const chunkId = `${docId}:${chunk.index}`;
        insertChunk.run(chunkId, docId, chunk.index, chunk.text, timestamp);
        insertFts.run(chunkId, docId, chunk.text);
      }
    });
    run();

    if (this.isVecEnabled && chunks.length > 0) {
      // Ingest/transaction/reservation are synchronous; failed writes consume no queue capacity.
      this.pendingEmbeddingChunks += chunks.length;
      this.pendingEmbeddings = this.pendingEmbeddings
        .then(() => this.embedChunks(docId, chunks.map((chunk) => ({ id: `${docId}:${chunk.index}`, text: chunk.text }))))
        .catch(() => undefined)
        .finally(() => { this.pendingEmbeddingChunks -= chunks.length; });
    }

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

  private getEmbeddingProvider(): Promise<TransformersEmbeddingProvider> {
    return this.embeddingProvider ??= import("../cache/embedding.js").then(({ TransformersEmbeddingProvider }) => new TransformersEmbeddingProvider());
  }

  private async embedChunks(docId: string, chunks: { id: string; text: string }[]): Promise<void> {
    if (!this.isVecEnabled || chunks.length === 0 || this.closed) return;

    try {
      this.authorize("knowledge:write");
      const provider = await this.getEmbeddingProvider();

      for (const chunk of chunks) {
        if (this.closed) return;
        const embedding = await provider.getEmbedding(chunk.text);
        if (this.closed) return;
        this.authorize("knowledge:write");
        if (embedding.length === EMBEDDING_DIM) {
          this.db.transaction(() => {
            const owned = this.db.prepare(`SELECT 1 FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id WHERE ${this.docScopeWhere} AND c.id = ? AND d.id = ?`).get(...this.scope, chunk.id, docId);
            if (!owned) return; // Pending inference must not resurrect deleted vectors.
            this.db.prepare("INSERT OR REPLACE INTO knowledge_chunks_vec(id, embedding) VALUES (?, ?)")
              .run(chunk.id, new Float32Array(embedding));
          })();
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
    this.authorize("knowledge:read");
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ftsHits = this.searchFts(trimmed, limit * 3, options?.source);
    const vectorHits = await this.searchVector(trimmed, limit * 3, options);
    this.authorize("knowledge:read");

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
          AND ${this.docScopeWhere}
          AND (? IS NULL OR d.source = ?)
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, ...this.scope, source ?? null, source ?? null, limit) as Array<{
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
        const provider = await this.getEmbeddingProvider();
        vector = await provider.getEmbedding(query);
      }
      this.authorize("knowledge:read");
      if (vector.length !== EMBEDDING_DIM) return [];

      const sourceFilter = options?.source ?? null;
      const rows = this.db.prepare(`
        SELECT c.id AS chunkId, c.doc_id AS docId, c.chunk_index AS chunkIndex, c.text AS text,
               d.title AS title, d.source AS source,
               vec_distance_cosine(v.embedding, ?) AS distance
        FROM knowledge_chunks_vec v
        JOIN knowledge_chunks c ON c.id = v.id
        JOIN knowledge_docs d ON d.id = c.doc_id
        WHERE ${this.docScopeWhere} AND (? IS NULL OR d.source = ?)
        ORDER BY distance ASC
        LIMIT ?
      `).all(new Float32Array(vector), ...this.scope, sourceFilter, sourceFilter, limit) as Array<{
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
      if (error instanceof InvocationError) throw error;
      console.error("KnowledgeIndex: vector search failed:", error);
      return [];
    }
  }

  getDoc(docId: string): KnowledgeDoc | null {
    this.authorize("knowledge:read");
    const row = this.db.prepare(`
      SELECT id, source, title, category, content, chunk_count AS chunkCount, timestamp
      FROM knowledge_docs WHERE ${this.scopeWhere} AND id = ?
    `).get(...this.scope, docId) as KnowledgeDoc | undefined;
    return row ?? null;
  }

  listDocs(limit: number = 50): Array<Omit<KnowledgeDoc, "content">> {
    this.authorize("knowledge:read");
    return this.db.prepare(`
      SELECT id, source, title, category, chunk_count AS chunkCount, timestamp
      FROM knowledge_docs
      WHERE ${this.scopeWhere}
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?
    `).all(...this.scope, limit) as Array<Omit<KnowledgeDoc, "content">>;
  }

  deleteDoc(docId: string): boolean {
    this.authorize("knowledge:write");

    const run = this.db.transaction(() => {
      if (!this.db.prepare(`SELECT 1 FROM knowledge_docs WHERE ${this.scopeWhere} AND id = ?`).get(...this.scope, docId)) return false;
      // Select vector ids before deleting the owning chunks.
      if (this.hasVectorTable()) {
        this.db.prepare(
          "DELETE FROM knowledge_chunks_vec WHERE id IN (SELECT id FROM knowledge_chunks WHERE doc_id = ?)",
        ).run(docId);
      }
      this.db.prepare("DELETE FROM knowledge_chunks_fts WHERE doc_id = ?").run(docId);
      this.db.prepare("DELETE FROM knowledge_chunks WHERE doc_id = ?").run(docId);
      this.db.prepare(`DELETE FROM knowledge_docs WHERE ${this.scopeWhere} AND id = ?`).run(...this.scope, docId);
      return true;
    });
    return run();
  }

  getStats(): { docCount: number; chunkCount: number; vectorCount: number } {
    this.authorize("knowledge:read");
    const docCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM knowledge_docs WHERE ${this.scopeWhere}`).get(...this.scope) as { c: number }).c;
    const chunkCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks c JOIN knowledge_docs d ON d.id = c.doc_id WHERE ${this.docScopeWhere}`).get(...this.scope) as { n: number }).n;
    let vectorCount = 0;
    if (this.hasVectorTable()) {
      vectorCount = (this.db.prepare(`SELECT COUNT(*) AS n FROM knowledge_chunks_vec v JOIN knowledge_chunks c ON c.id = v.id JOIN knowledge_docs d ON d.id = c.doc_id WHERE ${this.docScopeWhere}`).get(...this.scope) as { n: number }).n;
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
