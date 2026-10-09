import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const model = vi.hoisted(() => ({ load: vi.fn(), extract: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: (...args: unknown[]) => model.load(...args) }));
import { TransformersEmbeddingProvider } from "../cache/embedding.js";
import { KnowledgeIndex } from "../knowledge/index-store.js";

const vector = new Float32Array(384).fill(0.05);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("embedding model startup", () => {
  let finish!: (extractor: unknown) => void;
  beforeEach(() => {
    model.extract.mockReset().mockResolvedValue({ data: vector });
    model.load.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  });
  const closers: Array<{ close(): void }> = [];
  afterEach(() => { closers.splice(0).forEach((item) => item.close()); });

  it("answers a query without waiting while the model is still loading", async () => {
    const provider = new TransformersEmbeddingProvider("test", { loadWaitMs: 0 });
    provider.warmUp();
    const started = Date.now();
    expect(await provider.getEmbedding("query")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("lets background work wait for the model instead of dropping its vector", async () => {
    const provider = new TransformersEmbeddingProvider("test", { loadWaitMs: 0 });
    const pending = provider.getEmbedding("chunk", { waitForModel: true });
    await turn();
    finish(model.extract);
    expect((await pending).length).toBe(384);
  });

  it("does not hold the inference slot while a query skips a loading model", async () => {
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 1, maxQueuedInferences: 0, loadWaitMs: 0 });
    const background = provider.getEmbedding("chunk", { waitForModel: true });
    await turn();
    expect(await provider.getEmbedding("query")).toEqual([]);
    finish(model.extract);
    expect((await background).length).toBe(384);
  });

  it("knowledge index embeds documents ingested during loading, with the shared provider", async () => {
    const provider = new TransformersEmbeddingProvider("test", { loadWaitMs: 0 });
    const shared = vi.spyOn(provider, "getEmbedding");
    const index = new KnowledgeIndex(":memory:", { embeddingProvider: provider });
    closers.push(index);
    index.ingest({ content: "PgBouncer pools PostgreSQL connections for Kubernetes services.", title: "Pooling", source: "notes.md" });
    await turn();
    finish(model.extract);
    await index.flush();
    expect(shared).toHaveBeenCalled();
    expect(model.load).toHaveBeenCalledTimes(1);
    expect(index.getStats().vectorCount).toBe(1);
  });
});
