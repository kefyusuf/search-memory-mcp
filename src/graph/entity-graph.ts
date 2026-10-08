import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { assertRequestContext, InvocationError, type Permission, type RequestContext } from "../runtime/request-context.js";

export type ExtractedEntity = {
  name: string;
  count: number;
};

export type EntityDocLink = {
  docId: string;
  source: string;
  title: string;
  count: number;
};

export type EntityNeighbor = {
  name: string;
  cooccurrence: number;
};

export type IndexDocumentInput = {
  docId: string;
  source: string;
  title: string;
  content: string;
};

const STOPWORDS = new Set([
  "The", "A", "An", "And", "Or", "But", "If", "Then", "Else", "When", "At", "By",
  "For", "With", "About", "Against", "Between", "Into", "Through", "During",
  "Before", "After", "Above", "Below", "To", "From", "Up", "Down", "In", "Out",
  "On", "Off", "Over", "Under", "Again", "Further", "Once", "Here", "There",
  "All", "Any", "Both", "Each", "Few", "More", "Most", "Other", "Some", "Such",
  "No", "Nor", "Not", "Only", "Own", "Same", "So", "Than", "Too", "Very", "Can",
  "Will", "Just", "Do", "Does", "Did", "Is", "Are", "Was", "Were", "Be", "Been",
  "Being", "Have", "Has", "Had", "Having", "Of", "As", "It", "Its", "This",
  "That", "These", "Those", "I", "Me", "My", "We", "Our", "You", "Your", "He",
  "She", "They", "Them", "His", "Her", "Their", "What", "Which", "Who", "Whom",
  "How", "Why", "Where", "Please", "Note", "Example", "Examples",
]);

const TECH_TOKEN = /^[A-Za-z][A-Za-z0-9+#.\-_]{2,30}$/;

export function extractEntities(text: string): ExtractedEntity[] {
  if (!text || !text.trim()) return [];

  const counts = new Map<string, number>();
  const phraseMentions = new Map<number, string>();
  const compoundMentions: Array<{ start: number; end: number }> = [];

  // Multi-word capitalized phrases: "Machine Learning", "React Native"
  // Join only horizontal spacing; a trailing period ends the phrase.
  const phrasePattern = /\b([A-Z][A-Za-z0-9+#.\-_]*(?:(?<!\.)[ \t]+[A-Z][A-Za-z0-9+#.\-_]*){0,3})\b/g;
  let match: RegExpExecArray | null;
  while ((match = phrasePattern.exec(text)) !== null) {
    const phrase = match[1].replace(/\s+/g, " ").trim();
    const first = phrase.split(" ")[0];
    if (STOPWORDS.has(first) || phrase.length < 3) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    phraseMentions.set(match.index, phrase);
    // Do not hide real names inside phrases spanning line/sentence boundaries.
    if (phrase.includes(" ") && !/[\r\n]|\.[ \t]/.test(match[1])) {
      compoundMentions.push({ start: match.index, end: match.index + match[1].length });
    }
  }

  // Standalone tech-looking tokens: PgBouncer, kubernetes, PostgreSQL
  const tokenPattern = /\b([A-Za-z][A-Za-z0-9+#.\-_]{2,30})\b/g;
  let compoundIndex = 0;
  while ((match = tokenPattern.exec(text)) !== null) {
    const token = match[1];
    if (STOPWORDS.has(token) || !TECH_TOKEN.test(token)) continue;
    // Skip generic lowercase words unless they look technical (camelCase / mixed / digits).
    const looksTechnical =
      /[A-Z]/.test(token.slice(1)) ||
      /\d/.test(token) ||
      /[+#._-]/.test(token) ||
      /^[A-Z][a-z]+[A-Z]/.test(token);
    const startsCapital = /^[A-Z]/.test(token);
    if (!looksTechnical && !startsCapital) continue;
    while (compoundIndex < compoundMentions.length && compoundMentions[compoundIndex].end <= match.index) {
      compoundIndex++;
    }
    const compound = compoundMentions[compoundIndex];
    if (compound && compound.start <= match.index && match.index + token.length <= compound.end) continue;
    // The phrase pass may already have counted this exact text occurrence.
    if (phraseMentions.get(match.index) === token) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .filter((entity) => entity.name.length >= 3)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

function entityId(name: string): string {
  return createHash("sha1").update(name.toLowerCase()).digest("hex");
}

export class EntityGraph {
  private db: Database.Database;
  private readonly context?: RequestContext;
  private readonly scope: readonly [string, string, string];
  private readonly scopeWhere = "execution_mode = ? AND tenant_id = ? AND workspace_id = ?";

  constructor(dbPath: string = "websearch_cache.db", options: { context?: RequestContext } = {}) {
    // Context omission is reserved for legacy local callers, never hosted fallback.
    if ("context" in options) assertRequestContext(options.context);
    this.context = options.context;
    this.scope = this.context
      ? [this.context.mode, this.context.tenantId, this.context.workspaceId]
      : ["local", "local", "local"];
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("temp_store = MEMORY");
    try { this.init(); } catch (error) { this.db.close(); throw error; }
  }

  private init() {
    this.db.transaction(() => this.initSchema())();
  }

  private initSchema() {
    const columns = this.db.pragma("table_info(graph_entities)") as Array<{ name: string }>;
    const legacy = columns.length > 0 && !columns.some(column => column.name === "execution_mode");
    if (legacy) {
      // Rebuild global primary/unique keys so identical ids and names can coexist.
      for (const table of ["graph_entities", "graph_docs", "graph_doc_entities"]) {
        this.db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_entities (
        execution_mode TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        mention_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (execution_mode, tenant_id, workspace_id, id),
        UNIQUE (execution_mode, tenant_id, workspace_id, name)
      );

      CREATE TABLE IF NOT EXISTS graph_docs (
        execution_mode TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (execution_mode, tenant_id, workspace_id, doc_id)
      );

      CREATE TABLE IF NOT EXISTS graph_doc_entities (
        execution_mode TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (execution_mode, tenant_id, workspace_id, doc_id, entity_id)
      );
    `);
    if (legacy) {
      const tables = [
        ["graph_entities", "id, name, mention_count"],
        ["graph_docs", "doc_id, source, title, timestamp"],
        ["graph_doc_entities", "doc_id, entity_id, count"],
      ];
      for (const [table, dataColumns] of tables) {
        this.db.exec(`INSERT INTO ${table} (execution_mode, tenant_id, workspace_id, ${dataColumns}) SELECT 'local', 'local', 'local', ${dataColumns} FROM ${table}_legacy`);
        this.db.exec(`DROP TABLE ${table}_legacy`);
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_graph_doc_entities_scope_entity ON graph_doc_entities(execution_mode, tenant_id, workspace_id, entity_id)");
  }

  private authorize(permission: Permission): void {
    if (!this.context) return;
    assertRequestContext(this.context);
    if (!this.context.permissions.includes(permission)) throw new InvocationError("forbidden");
  }

  indexDocument(input: IndexDocumentInput): number {
    this.authorize("knowledge:write");
    const entities = extractEntities(input.content);
    const timestamp = Date.now();

    const run = this.db.transaction(() => {
      // Replace any previous index for this doc.
      this.db.prepare(`DELETE FROM graph_doc_entities WHERE ${this.scopeWhere} AND doc_id = ?`).run(...this.scope, input.docId);
      this.db.prepare(`DELETE FROM graph_docs WHERE ${this.scopeWhere} AND doc_id = ?`).run(...this.scope, input.docId);

      this.db.prepare(
        "INSERT INTO graph_docs (execution_mode, tenant_id, workspace_id, doc_id, source, title, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(...this.scope, input.docId, input.source, input.title, timestamp);

      const upsertEntity = this.db.prepare(`
        INSERT INTO graph_entities (execution_mode, tenant_id, workspace_id, id, name, mention_count) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(execution_mode, tenant_id, workspace_id, id) DO UPDATE SET mention_count = mention_count + excluded.mention_count
      `);
      const link = this.db.prepare(
        "INSERT OR REPLACE INTO graph_doc_entities (execution_mode, tenant_id, workspace_id, doc_id, entity_id, count) VALUES (?, ?, ?, ?, ?, ?)",
      );

      for (const entity of entities) {
        const id = entityId(entity.name);
        upsertEntity.run(...this.scope, id, entity.name, entity.count);
        link.run(...this.scope, input.docId, id, entity.count);
      }
    });
    run();

    return entities.length;
  }

  entitiesForDoc(docId: string): ExtractedEntity[] {
    this.authorize("knowledge:read");
    return this.db.prepare(`
      SELECT e.name AS name, de.count AS count
      FROM graph_doc_entities de
      JOIN graph_entities e ON e.id = de.entity_id
        AND e.execution_mode = de.execution_mode AND e.tenant_id = de.tenant_id AND e.workspace_id = de.workspace_id
      WHERE de.execution_mode = ? AND de.tenant_id = ? AND de.workspace_id = ? AND de.doc_id = ?
      ORDER BY de.count DESC, e.name ASC
    `).all(...this.scope, docId) as ExtractedEntity[];
  }

  docsForEntity(name: string, limit: number = 10): EntityDocLink[] {
    this.authorize("knowledge:read");
    return this.db.prepare(`
      SELECT d.doc_id AS docId, d.source AS source, d.title AS title, de.count AS count
      FROM graph_entities e
      JOIN graph_doc_entities de ON de.entity_id = e.id
        AND de.execution_mode = e.execution_mode AND de.tenant_id = e.tenant_id AND de.workspace_id = e.workspace_id
      JOIN graph_docs d ON d.doc_id = de.doc_id
        AND d.execution_mode = de.execution_mode AND d.tenant_id = de.tenant_id AND d.workspace_id = de.workspace_id
      WHERE e.execution_mode = ? AND e.tenant_id = ? AND e.workspace_id = ? AND LOWER(e.name) = LOWER(?)
      ORDER BY de.count DESC, d.timestamp DESC
      LIMIT ?
    `).all(...this.scope, name, limit) as EntityDocLink[];
  }

  relatedEntities(name: string, limit: number = 10): EntityNeighbor[] {
    this.authorize("knowledge:read");
    return this.db.prepare(`
      SELECT e2.name AS name, COUNT(*) AS cooccurrence
      FROM graph_entities e1
      JOIN graph_doc_entities de1 ON de1.entity_id = e1.id
        AND de1.execution_mode = e1.execution_mode AND de1.tenant_id = e1.tenant_id AND de1.workspace_id = e1.workspace_id
      JOIN graph_doc_entities de2 ON de2.doc_id = de1.doc_id AND de2.entity_id != de1.entity_id
        AND de2.execution_mode = de1.execution_mode AND de2.tenant_id = de1.tenant_id AND de2.workspace_id = de1.workspace_id
      JOIN graph_entities e2 ON e2.id = de2.entity_id
        AND e2.execution_mode = de2.execution_mode AND e2.tenant_id = de2.tenant_id AND e2.workspace_id = de2.workspace_id
      WHERE e1.execution_mode = ? AND e1.tenant_id = ? AND e1.workspace_id = ? AND LOWER(e1.name) = LOWER(?)
      GROUP BY e2.name
      ORDER BY cooccurrence DESC, e2.name ASC
      LIMIT ?
    `).all(...this.scope, name, limit) as EntityNeighbor[];
  }

  getStats(): { entityCount: number; docCount: number; linkCount: number } {
    this.authorize("knowledge:read");
    const entityCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM graph_entities WHERE ${this.scopeWhere}`).get(...this.scope) as { c: number }).c;
    const docCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM graph_docs WHERE ${this.scopeWhere}`).get(...this.scope) as { c: number }).c;
    const linkCount = (this.db.prepare(`SELECT COUNT(*) AS c FROM graph_doc_entities WHERE ${this.scopeWhere}`).get(...this.scope) as { c: number }).c;
    return { entityCount, docCount, linkCount };
  }

  close(): void {
    this.db.close();
  }
}
