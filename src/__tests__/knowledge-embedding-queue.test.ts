import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { chunkText } from "../knowledge/chunker.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = vi.hoisted(() => ({ embed: async (_text: string): Promise<number[]> => [1, ...Array(383).fill(0)] }));
vi.mock("../cache/embedding.js", () => ({ TransformersEmbeddingProvider: class { getEmbedding(text: string) { return model.embed(text); } } }));

describe("bounded knowledge embedding queue", () => {
  let indexes: KnowledgeIndex[]; let dirs: string[]; let unblock: (() => void) | undefined;
  beforeEach(() => { indexes = []; dirs = []; unblock = undefined; model.embed = async () => [1, ...Array(383).fill(0)]; });
  afterEach(async () => { unblock?.(); for (const index of indexes) { await index.flush(); index.close(); } for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
  function open(limit: number, enableEmbeddings = true) {
    const index = new KnowledgeIndex(":memory:", { maxPendingEmbeddingChunks: limit, enableEmbeddings }); indexes.push(index); return index;
  }
  function blockModel() {
    const waiting = new Promise<void>(resolve => { unblock = resolve; });
    model.embed = async () => { await waiting; return [1, ...Array(383).fill(0)]; };
  }
  it("rejects overload before writing documents, chunks or FTS rows", async () => {
    blockModel(); const index = open(1);
    const first = index.ingest({ content: "Accepted PostgreSQL document" });
    expect(() => index.ingest({ content: "Rejected overloadmarker document" })).toThrow("embedding_queue_full");
    expect(index.listDocs().map(doc => doc.id)).toEqual([first.id]);
    expect(index.getStats()).toMatchObject({ docCount: 1, chunkCount: 1 });
    expect(await index.search("overloadmarker", 5, { embed: async () => [] })).toEqual([]);
  });
  it("charges every chunk rather than one slot per document", () => {
    blockModel(); const index = open(2); const content = "x".repeat(1500);
    expect(chunkText(content)).toHaveLength(2);
    index.ingest({ content });
    expect(() => index.ingest({ content: "One more chunk" })).toThrow("embedding_queue_full");
  });
  it("rejects a document larger than the entire budget without charging capacity", async () => {
    const index = open(1);
    expect(() => index.ingest({ content: "x".repeat(1500) })).toThrow("embedding_queue_full");
    expect(index.getStats().docCount).toBe(0);
    index.ingest({ content: "Small document" }); await index.flush();
    expect(index.getStats().vectorCount).toBe(1);
  });
  it("restores capacity when accepted embedding jobs settle", async () => {
    blockModel(); const index = open(1); index.ingest({ content: "First document" });
    expect(() => index.ingest({ content: "Too soon" })).toThrow("embedding_queue_full");
    unblock!(); await index.flush(); index.ingest({ content: "Second document" }); await index.flush();
    expect(index.getStats()).toEqual({ docCount: 2, chunkCount: 2, vectorCount: 2 });
  });
  it("restores capacity after failed model inference and keeps FTS data", async () => {
    model.embed = async () => { throw new Error("model failed"); };
    const index = open(1); index.ingest({ content: "Failure searchablemarker" }); await index.flush();
    model.embed = async () => [1, ...Array(383).fill(0)];
    index.ingest({ content: "Successful second document" }); await index.flush();
    expect(index.getStats()).toEqual({ docCount: 2, chunkCount: 2, vectorCount: 1 });
    expect(await index.search("searchablemarker", 5, { embed: async () => [] })).toHaveLength(1);
  });
  it("retains capacity after document deletion until its inference settles", async () => {
    blockModel(); const index = open(1); const doc = index.ingest({ content: "Pending document" });
    index.deleteDoc(doc.id);
    expect(() => index.ingest({ content: "Replacement" })).toThrow("embedding_queue_full");
    unblock!(); await index.flush(); index.ingest({ content: "Replacement" }); await index.flush();
    expect(index.getStats()).toEqual({ docCount: 1, chunkCount: 1, vectorCount: 1 });
  });
  it("does not queue inference or apply its budget when embeddings are disabled", async () => {
    let calls = 0; model.embed = async () => { calls++; return []; }; const index = open(1, false);
    for (let i = 0; i < 5; i++) index.ingest({ content: "x".repeat(1500) });
    await index.flush(); expect(calls).toBe(0);
    expect(index.getStats()).toEqual({ docCount: 5, chunkCount: 10, vectorCount: 0 });
  });
  it("bounds default embedding work without requiring caller configuration", () => {
    const index = new KnowledgeIndex(":memory:"); indexes.push(index);
    expect(() => index.ingest({ content: "x".repeat(280_000) })).toThrow("embedding_queue_full");
    expect(index.getStats()).toEqual({ docCount: 0, chunkCount: 0, vectorCount: 0 });
  });
  it("does not reserve queue capacity or retain partial rows after a failed SQL transaction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "embedding-queue-")); dirs.push(dir); const path = join(dir, "index.db");
    const index = new KnowledgeIndex(path, { maxPendingEmbeddingChunks: 1 }); indexes.push(index);
    const db = new Database(path);
    try {
      db.exec("CREATE TRIGGER fail_chunk BEFORE INSERT ON knowledge_chunks BEGIN SELECT RAISE(ABORT, 'chunk failure'); END");
      expect(() => index.ingest({ content: "Rejected partial document" })).toThrow("chunk failure");
      expect(index.getStats()).toEqual({ docCount: 0, chunkCount: 0, vectorCount: 0 });
      db.exec("DROP TRIGGER fail_chunk");
    } finally { db.close(); }
    index.ingest({ content: "Accepted after rollback" }); await index.flush();
    expect(index.getStats()).toEqual({ docCount: 1, chunkCount: 1, vectorCount: 1 });
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid queue limits: %s", limit => {
    expect(() => open(limit)).toThrow("invalid_embedding_queue_limit");
  });
});
