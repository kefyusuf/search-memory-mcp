import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

const model = vi.hoisted(() => ({ embed: async (_text: string): Promise<number[]> => [1, ...Array(383).fill(0)] }));
// Replace model inference only; SQL, FTS and sqlite-vec execute unchanged.
vi.mock("../cache/embedding.js", () => ({ TransformersEmbeddingProvider: class { getEmbedding(text: string) { return model.embed(text); } } }));
function context(tenantId = "tenant-a", workspaceId = "workspace", permissions = ["knowledge:read", "knowledge:write"], signal = new AbortController().signal): RequestContext {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], scopes: permissions, expiresAt: Date.now() + 60_000 },
    membership: { principalId: "alice", tenantId, workspaceId, permissions },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 60_000, signal,
  });
}
describe("workspace knowledge isolation", () => {
  let dir: string; let path: string; let indexes: KnowledgeIndex[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "workspace-knowledge-")); path = join(dir, "index.db"); indexes = [];
    model.embed = async () => [1, ...Array(383).fill(0)];
  });
  afterEach(async () => { for (const index of indexes) { await index.flush(); index.close(); } vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  function open(ctx?: RequestContext, enableEmbeddings = false) {
    const index = new KnowledgeIndex(path, { enableEmbeddings, ...(ctx ? { context: ctx } : {}) }); indexes.push(index); return index;
  }
  it.each([["tenant-b", "workspace"], ["tenant-a", "other-workspace"]])("isolates FTS, ids, lists and stats from %s/%s", async (tenant, workspace) => {
    const a = open(context()); const b = open(context(tenant, workspace));
    const own = a.ingest({ source: "same", title: "Alice", content: "PostgreSQL pooling private Alice" });
    const foreign = b.ingest({ source: "same", title: "Bob", content: "pooling pooling pooling" });
    expect(a.getDoc(foreign.id)).toBeNull();
    expect(a.listDocs(1).map(d => d.id)).toEqual([own.id]);
    expect((await a.search("pooling", 1, { source: "same" })).map(h => h.docId)).toEqual([own.id]);
    expect(a.getStats()).toEqual({ docCount: 1, chunkCount: 1, vectorCount: 0 });
    expect(a.deleteDoc(foreign.id)).toBe(false);
    expect(b.getDoc(foreign.id)?.title).toBe("Bob");
  });
  it("allows identical input at the same time across scopes without id collisions", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const a = open(context()); const b = open(context("tenant-b"));
    const input = { source: "same", content: "Identical private input" };
    const own = a.ingest(input); const foreign = b.ingest(input);
    expect(a.getDoc(own.id)?.content).toBe(input.content);
    expect(a.getDoc(foreign.id)).toBeNull();
    expect(b.getDoc(foreign.id)?.content).toBe(input.content);
  });
  it("scopes actual vector retrieval before limit and counts", async () => {
    model.embed = async text => text.startsWith("Alice")
      ? [0.8, 0.6, ...Array(382).fill(0)] : [1, ...Array(383).fill(0)];
    const a = open(context(), true); const b = open(context("tenant-b"), true);
    const own = a.ingest({ title: "Alice", source: "same", content: "Alice private document" });
    await a.flush();
    // Three closer foreign hits exhaust search's 3x candidate limit if scope is applied too late.
    for (let i = 0; i < 3; i++) {
      b.ingest({ title: `Bob-${i}`, source: "same", content: "Bob private document" });
      await b.flush();
    }
    expect(a.getStats().vectorCount).toBe(1);
    const hits = await a.search("absentlexicalterm", 1, { source: "same", embed: model.embed });
    expect(hits.map(h => h.docId)).toEqual([own.id]);
    expect(hits[0].matchedBy).toBe("vector");
  });
  it("deletes owned FTS/chunks/vectors without deleting foreign data", async () => {
    const a = open(context(), true); const b = open(context("tenant-b"), true);
    const own = a.ingest({ title: "Alice", content: "Private pooling Alice" });
    await a.flush();
    const foreign = b.ingest({ title: "Bob", content: "Private pooling Bob" });
    await b.flush();
    expect(a.deleteDoc(own.id)).toBe(true);
    expect(a.getStats()).toEqual({ docCount: 0, chunkCount: 0, vectorCount: 0 });
    expect(await a.search("pooling", 5, { embed: model.embed })).toEqual([]);
    expect(b.getDoc(foreign.id)?.title).toBe("Bob");
    const db = new Database(path);
    sqliteVec.load(db);
    try { expect((db.prepare("SELECT count(*) AS n FROM knowledge_chunks_vec").get() as { n: number }).n).toBe(1); }
    finally { db.close(); }
  });
  it("does not recreate vectors when a deleted document's embedding finishes", async () => {
    let release!: (vector: number[]) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    model.embed = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const a = open(context(), true); const doc = a.ingest({ content: "Pending private document" });
    await ready; a.deleteDoc(doc.id); release([1, ...Array(383).fill(0)]); await a.flush();
    expect(a.getStats().vectorCount).toBe(0);
    const db = new Database(path);
    sqliteVec.load(db);
    try { expect((db.prepare("SELECT count(*) AS n FROM knowledge_chunks_vec").get() as { n: number }).n).toBe(0); }
    finally { db.close(); }
  });
  it("cleans existing vectors when reopened with model embeddings disabled", async () => {
    const first = open(context(), true); const doc = first.ingest({ content: "Existing private vector" });
    await first.flush(); first.close(); indexes = [];
    const offline = open(context());
    expect(offline.getStats().vectorCount).toBe(1);
    expect(offline.deleteDoc(doc.id)).toBe(true);
    const db = new Database(path); sqliteVec.load(db);
    try { expect((db.prepare("SELECT count(*) AS n FROM knowledge_chunks_vec").get() as { n: number }).n).toBe(0); }
    finally { db.close(); }
  });
  it("rechecks cancellation after waiting for query embedding", async () => {
    const controller = new AbortController(); const a = open(context("tenant-a", "workspace", undefined, controller.signal), true);
    a.ingest({ content: "Pooling private document" }); await a.flush();
    let release!: (vector: number[]) => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const pending = a.search("pooling", 5, { embed: () => { started(); return new Promise(resolve => { release = resolve; }); } });
    await ready; controller.abort(); release([1, ...Array(383).fill(0)]);
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("preserves legacy docs and FTS in local scope after migration and reopen", async () => {
    const db = new Database(path);
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE knowledge_docs (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, content TEXT NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0, timestamp INTEGER NOT NULL);
      CREATE TABLE knowledge_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, text TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(chunk_id UNINDEXED, doc_id UNINDEXED, text);
      INSERT INTO knowledge_docs VALUES ('legacy', 'same', 'Legacy', 'docs', 'Legacy pooling document', 1, 1);
      INSERT INTO knowledge_chunks VALUES ('legacy:0', 'legacy', 0, 'Legacy pooling document', 1);
      INSERT INTO knowledge_chunks_fts VALUES ('legacy:0', 'legacy', 'Legacy pooling document');
      CREATE VIRTUAL TABLE knowledge_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding float[384]);
    `);
    db.prepare("INSERT INTO knowledge_chunks_vec(id, embedding) VALUES (?, ?)").run("legacy:0", new Float32Array([1, ...Array(383).fill(0)]));
    db.close();
    const hosted = open(context("local", "local"), true); expect(await hosted.search("pooling", 5, { embed: model.embed })).toEqual([]);
    expect(hosted.getStats().vectorCount).toBe(0);
    expect(hosted.getDoc("legacy")).toBeNull();
    hosted.ingest({ content: "Hosted pooling document" }); await hosted.flush();
    for (const index of indexes) index.close(); indexes = [];
    const local = open(undefined, true); expect(local.getDoc("legacy")?.title).toBe("Legacy");
    expect(local.getStats().vectorCount).toBe(1);
    expect((await local.search("unmatchedword", 1, { embed: model.embed })).map(h => h.docId)).toEqual(["legacy"]);
    expect((await local.search("pooling")).map(h => h.docId)).toEqual(["legacy"]);
    expect(open(context("local", "local")).listDocs()).toHaveLength(1);
  });
  it("rejects forged contexts and writes from read-only membership", () => {
    expect(() => { const index = new KnowledgeIndex(path, { context: {} as RequestContext, enableEmbeddings: false }); indexes.push(index); }).toThrow("invalid_context");
    const a = open(context("tenant-a", "workspace", ["knowledge:read"]));
    expect(() => a.ingest({ content: "Forbidden" })).toThrow("forbidden");
    expect(() => a.deleteDoc("anything")).toThrow("forbidden");
    expect(a.listDocs()).toEqual([]);
  });
  it("denies reads for write-only membership but permits owned deletion", async () => {
    const a = open(context("tenant-a", "workspace", ["knowledge:write"])); const doc = a.ingest({ content: "Secret" });
    for (const read of [() => a.getDoc(doc.id), () => a.listDocs(), () => a.getStats()]) expect(read).toThrow("forbidden");
    await expect(a.search("")).rejects.toThrow("forbidden");
    expect(a.deleteDoc(doc.id)).toBe(true);
  });
});
