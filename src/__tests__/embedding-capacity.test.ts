import { beforeEach, describe, expect, it, vi } from "vitest";
const model = vi.hoisted(() => ({ load: vi.fn(), extract: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: (...args: unknown[]) => model.load(...args) }));
import { TransformersEmbeddingProvider } from "../cache/embedding.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const output = { data: new Float32Array([1, 0]) };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
describe("bounded embedding inference", () => {
  beforeEach(() => { model.extract.mockReset().mockResolvedValue(output); model.load.mockReset().mockResolvedValue(model.extract); });
  it("bounds active work, queues FIFO and rejects overflow without starting inference", async () => {
    const hold = deferred<typeof output>(); model.extract.mockImplementation(() => hold.promise);
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 1, maxQueuedInferences: 2 });
    const a = provider.getEmbedding("a"); await turn();
    const b = provider.getEmbedding("b"); const c = provider.getEmbedding("c"); await turn();
    try {
      expect(model.extract.mock.calls.map(call => call[0])).toEqual(["a"]);
      await expect(provider.getEmbedding("overflow")).rejects.toThrow("embedding_capacity_exceeded");
    } finally { hold.resolve(output); await Promise.allSettled([a, b, c]); }
    expect(model.extract.mock.calls.map(call => call[0])).toEqual(["a", "b", "c"]);
    expect(await provider.getEmbedding("next")).toEqual([1, 0]);
  });
  it("supports explicit parallel capacity without exceeding it", async () => {
    const hold = deferred<typeof output>(); let active = 0; let peak = 0;
    model.extract.mockImplementation(async () => { active++; peak = Math.max(peak, active); try { return await hold.promise; } finally { active--; } });
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 2, maxQueuedInferences: 1 });
    const pending = [provider.getEmbedding("a"), provider.getEmbedding("b"), provider.getEmbedding("c")]; await turn();
    try { expect(peak).toBe(2); await expect(provider.getEmbedding("overflow")).rejects.toThrow("embedding_capacity_exceeded"); }
    finally { hold.resolve(output); await Promise.allSettled(pending); }
    expect(peak).toBe(2); expect(active).toBe(0);
  });
  it("reserves capacity while the model is loading and releases failed load waiters", async () => {
    const load = deferred<typeof model.extract>(); model.load.mockImplementation(() => load.promise);
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 1, maxQueuedInferences: 1 });
    const a = provider.getEmbedding("a"); const b = provider.getEmbedding("b"); await turn();
    try { const overflow = provider.getEmbedding("overflow"); load.reject(new Error("load failed")); await expect(overflow).rejects.toThrow("embedding_capacity_exceeded"); }
    finally { load.reject(new Error("load failed")); expect(await Promise.all([a, b])).toEqual([[], []]); }
    expect(await provider.getEmbedding("next")).toEqual([]); expect(model.load).toHaveBeenCalledTimes(1);
  });
  it("starts queued work after a failed inference and preserves the model", async () => {
    const hold = deferred<typeof output>(); model.extract.mockImplementationOnce(() => hold.promise);
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 1, maxQueuedInferences: 1 });
    const a = provider.getEmbedding("a"); const failure = a.catch(error => error); const b = provider.getEmbedding("b"); await turn();
    try { expect(model.extract).toHaveBeenCalledTimes(1); }
    finally { hold.reject(new Error("inference failed")); expect(await failure).toMatchObject({ message: "inference failed" }); await b; }
    expect(await b).toEqual([1, 0]); expect(await provider.getEmbedding("next")).toEqual([1, 0]);
    expect(model.load).toHaveBeenCalledTimes(1); expect(provider.isAvailable()).toBe(true);
  });
  it("snapshots limits and supports rejecting rather than queueing", async () => {
    const hold = deferred<typeof output>(); model.extract.mockImplementation(() => hold.promise);
    const limits = { maxConcurrentInferences: 1, maxQueuedInferences: 0 }; const provider = new TransformersEmbeddingProvider("test", limits);
    limits.maxConcurrentInferences = 100; const a = provider.getEmbedding("a"); await turn();
    try { const overflow = provider.getEmbedding("overflow"); hold.resolve(output); await expect(overflow).rejects.toThrow("embedding_capacity_exceeded"); }
    finally { hold.resolve(output); await a; }
  });
  it("bounds default capacity without caller configuration", async () => {
    const hold = deferred<typeof output>(); model.extract.mockImplementation(() => hold.promise);
    const provider = new TransformersEmbeddingProvider(); const accepted = Array.from({ length: 33 }, (_, i) => provider.getEmbedding(String(i))); await turn();
    try { expect(model.extract).toHaveBeenCalledTimes(1); await expect(provider.getEmbedding("overflow")).rejects.toThrow("embedding_capacity_exceeded"); }
    finally { hold.resolve(output); await Promise.allSettled(accepted); }
  });
  it("propagates overload through SemanticCache rather than treating it as a cache miss", async () => {
    const hold = deferred<typeof output>(); model.extract.mockImplementation(() => hold.promise);
    const provider = new TransformersEmbeddingProvider("test", { maxConcurrentInferences: 1, maxQueuedInferences: 0 });
    const store = new SQLiteVectorStore(":memory:", { useNativeVectors: false }); const cache = new SemanticCache(provider, store);
    const pending = cache.get("first"); await turn();
    try { await expect(cache.get("overflow")).rejects.toThrow("embedding_capacity_exceeded"); }
    finally { hold.resolve(output); await pending; cache.close(); }
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid active capacity: %s", invalid => {
    expect(() => new TransformersEmbeddingProvider("test", { maxConcurrentInferences: invalid })).toThrow("invalid_embedding_capacity");
  });
  it.each([-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid queued capacity: %s", invalid => {
    expect(() => new TransformersEmbeddingProvider("test", { maxQueuedInferences: invalid })).toThrow("invalid_embedding_capacity");
  });
});
