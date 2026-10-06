import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = vi.hoisted(() => ({ providers: 0, calls: 0 }));
vi.mock("../cache/embedding.js", () => ({ TransformersEmbeddingProvider: class {
  constructor() { model.providers++; }
  async getEmbedding(_text: string) { model.calls++; return [1, ...Array(383).fill(0)]; }
} }));
import { KnowledgeIndex } from "../knowledge/index-store.js";
describe("knowledge index model ownership", () => {
  let indexes: KnowledgeIndex[]; let dir: string;
  beforeEach(() => { indexes = []; dir = mkdtempSync(join(tmpdir(), "knowledge-model-")); model.providers = 0; model.calls = 0; });
  afterEach(async () => { for (const index of indexes) { await index.flush(); index.close(); } rmSync(dir, { recursive: true, force: true }); });
  function open(enableEmbeddings = true) { const index = new KnowledgeIndex(join(dir, `${indexes.length}.db`), { enableEmbeddings }); indexes.push(index); return index; }
  it("reuses one lazy provider for document jobs and default vector queries", async () => {
    const index = open(); expect(model.providers).toBe(0);
    index.ingest({ content: "First private document" }); await index.flush();
    index.ingest({ content: "Second private document" }); await index.flush();
    expect(await index.search("absentlexicalterm")).toHaveLength(2);
    await index.search("anotherquery");
    expect(model.providers).toBe(1); expect(model.calls).toBe(4);
  });
  it("shares initialization between concurrent default vector queries", async () => {
    const index = open();
    await Promise.all([index.search("first query"), index.search("second query")]); expect(model.providers).toBe(1); expect(model.calls).toBe(2);
  });
  it("keeps provider ownership separate across indexes", async () => {
    const a = open(); const b = open(); a.ingest({ content: "Alice" }); await a.flush();
    b.ingest({ content: "Bob" }); await b.flush(); expect(model.providers).toBe(2);
    expect(a.getStats().vectorCount).toBe(1); expect(b.getStats().vectorCount).toBe(1);
  });
  it("does not create providers for FTS-only or caller-supplied query embeddings", async () => {
    const offline = open(false); offline.ingest({ content: "FTS document" }); await offline.flush(); await offline.search("FTS");
    const enabled = open(); await enabled.search("query", 5, { embed: async () => [] }); expect(model.providers).toBe(0);
  });
});
