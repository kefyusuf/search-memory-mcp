import { afterEach, describe, expect, it } from "vitest";
import { KnowledgeIndex, fuseChunkHits, type KnowledgeChunkHit } from "../knowledge/index-store.js";

function makeHit(overrides: Partial<KnowledgeChunkHit>): KnowledgeChunkHit {
  return {
    chunkId: "c1",
    docId: "d1",
    chunkIndex: 0,
    text: "hello",
    title: "t",
    source: "s",
    score: 0.5,
    matchedBy: "fts",
    ...overrides,
  };
}

describe("fuseChunkHits", () => {
  it("boosts chunks found by both FTS and vector (hybrid)", () => {
    const fts = [makeHit({ chunkId: "a", score: 0.9 }), makeHit({ chunkId: "b", score: 0.8 })];
    const vec = [makeHit({ chunkId: "b", score: 0.95, matchedBy: "vector" })];

    const fused = fuseChunkHits(fts, vec, 5);

    expect(fused[0].chunkId).toBe("b");
    expect(fused[0].matchedBy).toBe("hybrid");
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it("keeps FTS-only hits when vector is empty", () => {
    const fused = fuseChunkHits([makeHit({ chunkId: "only-fts" })], [], 5);
    expect(fused).toHaveLength(1);
    expect(fused[0].matchedBy).toBe("fts");
  });
});

describe("KnowledgeIndex", () => {
  let index: KnowledgeIndex;

  afterEach(() => {
    index?.close();
  });

  it("supports offline FTS-only indexing without loading embedding models", async () => {
    index = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
    index.ingest({ source: "offline-guide", content: "PgBouncer connection pooling guide." });
    await index.flush();
    const hits = await index.search("connection pooling");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ source: "offline-guide", matchedBy: "fts" });
    expect(index.getStats().vectorCount).toBe(0);
  });

  it("ingests a document into FTS-searchable chunks", async () => {
    index = new KnowledgeIndex(":memory:");

    const doc = index.ingest({
      title: "PgBouncer Guide",
      source: "https://example.com/pgbouncer",
      category: "docs",
      content:
        "PgBouncer is a lightweight connection pooler for PostgreSQL.\n\n" +
        "It multiplexes client connections to reduce backend load.\n\n" +
        "Pool sizing depends on cores and workload characteristics.",
    });

    expect(doc.chunkCount).toBeGreaterThanOrEqual(1);

    const hits = await index.search("PgBouncer connection pooler", 5, {
      embed: async () => [], // FTS-only path
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("PgBouncer");
    expect(hits[0].source).toBe("https://example.com/pgbouncer");
    expect(hits[0].matchedBy).toBe("fts");
  });

  it("filters search results by source", async () => {
    index = new KnowledgeIndex(":memory:");
    index.ingest({ title: "A", source: "https://a.example/doc", content: "PostgreSQL pooling reduces churn under load." });
    index.ingest({ title: "B", source: "https://b.example/doc", content: "PostgreSQL pooling reduces churn under load." });

    const hits = await index.search("PostgreSQL pooling", 10, {
      source: "https://a.example/doc",
      embed: async () => [],
    });

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.source).toBe("https://a.example/doc");
    }
  });

  it("lists and deletes documents", async () => {
    index = new KnowledgeIndex(":memory:");
    const doc = index.ingest({
      title: "Temp",
      source: "https://temp.example",
      content: "A short knowledge document about vector search and full text retrieval.",
    });

    expect(index.listDocs()).toHaveLength(1);
    expect(index.getStats().docCount).toBe(1);

    expect(index.deleteDoc(doc.id)).toBe(true);
    expect(index.listDocs()).toHaveLength(0);
    expect(index.deleteDoc("missing")).toBe(false);
  });

  it("rejects empty ingest", () => {
    index = new KnowledgeIndex(":memory:");
    expect(() => index.ingest({ content: "   " })).toThrow(/non-empty/);
  });
});
