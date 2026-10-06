import Database from "better-sqlite3";
import * as sqlite_vec from "sqlite-vec";
import { createHash } from "node:crypto";
import type { IVectorStore, VectorMatch, CacheMetadata, ContentEntry } from "./types.js";
import { cosineSimilarity } from "./utils.js";
import { assertRequestContext, InvocationError, type Permission, type RequestContext } from "../runtime/request-context.js";

export class SQLiteVectorStore implements IVectorStore {
  private db: Database.Database;
  private isVecEnabled = false;
  private vecLoaded = false;
  private readonly context?: RequestContext;
  private readonly scope: readonly [string, string, string];
  private readonly scopeWhere = "execution_mode = ? AND tenant_id = ? AND workspace_id = ?";

  constructor(dbPath: string = "cache.db", options: { context?: RequestContext; useNativeVectors?: boolean } = {}) {
    if ("context" in options) assertRequestContext(options.context);
    this.context = options.context;
    this.scope = this.context ? [this.context.mode, this.context.tenantId, this.context.workspaceId] : ["local", "local", "local"];
    this.db = new Database(dbPath);
    // Reconstructable local cache; hosted durability and resource budgets remain separate gates.
    this.db.pragma("journal_mode = MEMORY");
    this.db.pragma("temp_store = MEMORY");
    if (options.useNativeVectors !== false) this.tryEnableVec();
    try { this.db.transaction(() => this.init())(); } catch (error) { this.db.close(); throw error; }
  }

  private tryEnableVec() {
    try {
      sqlite_vec.load(this.db);
      this.vecLoaded = true;
      this.isVecEnabled = true;
    } catch (error) {
      console.error("Failed to load sqlite-vec, falling back to JS-based search:", error);
    }
  }

  private init() {
    const columns = this.db.pragma("table_info(content_cache)") as Array<{ name: string }>;
    const legacy = columns.length > 0 && !columns.some(column => column.name === "execution_mode");
    if (legacy) this.db.exec("ALTER TABLE content_cache RENAME TO content_cache_legacy");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_cache (
        execution_mode TEXT NOT NULL, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        url TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL, timestamp INTEGER NOT NULL,
        PRIMARY KEY (execution_mode, tenant_id, workspace_id, url)
      );
      CREATE TABLE IF NOT EXISTS semantic_cache_metadata (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vector_cache_fallback (id TEXT PRIMARY KEY, vector TEXT NOT NULL, metadata TEXT NOT NULL, timestamp INTEGER NOT NULL);
    `);
    if (legacy) {
      this.db.exec(`INSERT INTO content_cache SELECT 'local', 'local', 'local', url, content, category, timestamp FROM content_cache_legacy;
        DROP TABLE content_cache_legacy;`);
    }
    for (const table of ["semantic_cache_metadata", "vector_cache_fallback"]) {
      const names = new Set((this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name));
      for (const name of ["execution_mode", "tenant_id", "workspace_id"]) {
        if (!names.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} TEXT NOT NULL DEFAULT 'local'`);
      }
      if (!names.has("entry_id")) this.db.exec(`ALTER TABLE ${table} ADD COLUMN entry_id TEXT`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table}(execution_mode, tenant_id, workspace_id)`);
    }
    if (this.isVecEnabled) {
      try {
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS semantic_cache_vec USING vec0(id TEXT PRIMARY KEY, embedding float[384])");
      } catch (error) {
        this.isVecEnabled = false;
        console.error("Failed to initialize sqlite-vec tables, falling back to JS-based search:", error);
      }
    }
  }

  /** Cache fills are internal effects of read tools; maintenance requires an explicit grant. */
  assertAccess(permission: Permission): void {
    if (!this.context) return; // Legacy local adapter only.
    assertRequestContext(this.context);
    if (!this.context.permissions.includes(permission)) throw new InvocationError("forbidden");
  }

  private physicalId(id: string): string {
    return this.scope[0] === "local" ? id : createHash("sha256").update(JSON.stringify([...this.scope, id])).digest("hex");
  }

  private hasNativeTable(): boolean {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'semantic_cache_vec'").get()) return false;
    if (!this.vecLoaded) { sqlite_vec.load(this.db); this.vecLoaded = true; }
    return true;
  }

  async add(id: string, vector: number[], metadata: CacheMetadata): Promise<void> {
    this.assertAccess("search:read");
    const physicalId = this.physicalId(id);
    this.db.transaction(() => {
      const table = this.isVecEnabled ? "semantic_cache_metadata" : "vector_cache_fallback";
      const existing = this.db.prepare(`SELECT execution_mode, tenant_id, workspace_id FROM ${table} WHERE id = ?`).get(physicalId) as
        { execution_mode: string; tenant_id: string; workspace_id: string } | undefined;
      if (existing && [existing.execution_mode, existing.tenant_id, existing.workspace_id].some((value, index) => value !== this.scope[index])) {
        throw new InvocationError("cache_key_conflict");
      }
      if (this.isVecEnabled) {
        // vec0 does not support replacement; keep refresh and metadata changes atomic.
        this.db.prepare("DELETE FROM semantic_cache_vec WHERE id = ?").run(physicalId);
        this.db.prepare("INSERT INTO semantic_cache_vec(id, embedding) VALUES (?, ?)").run(physicalId, new Float32Array(vector));
        this.db.prepare("INSERT OR REPLACE INTO semantic_cache_metadata(id, metadata, timestamp, execution_mode, tenant_id, workspace_id, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(physicalId, JSON.stringify(metadata), Date.now(), ...this.scope, id);
      } else {
        this.db.prepare("INSERT OR REPLACE INTO vector_cache_fallback(id, vector, metadata, timestamp, execution_mode, tenant_id, workspace_id, entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(physicalId, JSON.stringify(vector), JSON.stringify(metadata), Date.now(), ...this.scope, id);
      }
    })();
  }

  async search(vector: number[], limit: number, namespace?: string): Promise<VectorMatch[]> {
    this.assertAccess("search:read");
    if (this.isVecEnabled) {
      const rows = this.db.prepare(`
        SELECT COALESCE(m.entry_id, m.id) AS id, vec_distance_cosine(v.embedding, ?) AS distance, m.metadata
        FROM semantic_cache_vec v JOIN semantic_cache_metadata m ON v.id = m.id
        WHERE m.execution_mode = ? AND m.tenant_id = ? AND m.workspace_id = ?
          AND (? IS NULL OR COALESCE(json_extract(m.metadata, '$.namespace'), 'fallback') = ?)
        ORDER BY distance ASC LIMIT ?
      `).all(new Float32Array(vector), ...this.scope, namespace ?? null, namespace ?? null, limit) as Array<{ id: string; distance: number; metadata: string }>;
      return rows.map(row => ({ id: row.id, score: 1 - row.distance, metadata: JSON.parse(row.metadata) }));
    }
    const rows = this.db.prepare(`
      SELECT COALESCE(entry_id, id) AS id, vector, metadata FROM vector_cache_fallback WHERE ${this.scopeWhere}
        AND (? IS NULL OR COALESCE(json_extract(metadata, '$.namespace'), 'fallback') = ?)
    `).all(...this.scope, namespace ?? null, namespace ?? null) as Array<{ id: string; vector: string; metadata: string }>;
    return rows.map(row => ({ id: row.id, score: cosineSimilarity(vector, JSON.parse(row.vector)), metadata: JSON.parse(row.metadata) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async clear(): Promise<void> {
    this.assertAccess("cache:manage");
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM content_cache WHERE ${this.scopeWhere}`).run(...this.scope);
      if (this.hasNativeTable()) {
        this.db.prepare(`DELETE FROM semantic_cache_vec WHERE id IN (SELECT id FROM semantic_cache_metadata WHERE ${this.scopeWhere})`).run(...this.scope);
      }
      for (const table of ["semantic_cache_metadata", "vector_cache_fallback"]) this.db.prepare(`DELETE FROM ${table} WHERE ${this.scopeWhere}`).run(...this.scope);
    })();
  }

  getStats(): { contentCount: number; vectorCount: number } {
    this.assertAccess("status:read");
    const count = (table: string) => (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${this.scopeWhere}`).get(...this.scope) as { n: number }).n;
    return { contentCount: count("content_cache"), vectorCount: count("semantic_cache_metadata") + count("vector_cache_fallback") };
  }

  async getContent(url: string): Promise<ContentEntry | null> {
    this.assertAccess("content:read");
    return (this.db.prepare(`SELECT url, content, category, timestamp FROM content_cache WHERE ${this.scopeWhere} AND url = ?`).get(...this.scope, url) as ContentEntry | undefined) ?? null;
  }

  async setContent(url: string, content: string, category: string): Promise<void> {
    this.assertAccess("content:read");
    this.db.prepare("INSERT OR REPLACE INTO content_cache(execution_mode, tenant_id, workspace_id, url, content, category, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(...this.scope, url, content, category, Date.now());
  }

  deleteExpiredContent(maxAgeMs: number): number {
    this.assertAccess("cache:manage");
    return this.db.prepare(`DELETE FROM content_cache WHERE ${this.scopeWhere} AND timestamp < ?`).run(...this.scope, Date.now() - maxAgeMs).changes;
  }

  close(): void { this.db.close(); }
}
