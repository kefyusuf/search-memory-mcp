import { beforeEach, describe, expect, it, vi } from "vitest";
const model = vi.hoisted(() => ({ load: vi.fn(), extract: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: (...args: unknown[]) => model.load(...args) }));
import { TransformersEmbeddingProvider } from "../cache/embedding.js";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
describe("embedding model lifecycle", () => {
  beforeEach(() => {
    model.extract.mockReset().mockImplementation(async () => ({ data: new Float32Array([0.25, 0.75]) }));
    model.load.mockReset().mockImplementation(async () => model.extract);
  });
  it("shares one pending model load among concurrent calls on the same provider", async () => {
    const load = deferred<typeof model.extract>(); model.load.mockImplementation(() => load.promise);
    const provider = new TransformersEmbeddingProvider("test-model", { maxConcurrentInferences: 2 });
    const a = provider.getEmbedding("Alice"); const b = provider.getEmbedding("Bob");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(model.load).toHaveBeenCalledTimes(1);
    load.resolve(model.extract); expect(await Promise.all([a, b])).toEqual([[0.25, 0.75], [0.25, 0.75]]);
    expect(model.extract.mock.calls.map(call => call[0])).toEqual(["Alice", "Bob"]);
    await provider.getEmbedding("Later"); expect(model.load).toHaveBeenCalledTimes(1);
  });
  it("shares one failed load and keeps the existing no-retry fallback", async () => {
    const load = deferred<typeof model.extract>(); model.load.mockImplementation(() => load.promise);
    const provider = new TransformersEmbeddingProvider(undefined, { maxConcurrentInferences: 2 });
    const a = provider.getEmbedding("Alice"); const b = provider.getEmbedding("Bob"); await new Promise<void>(resolve => setImmediate(resolve));
    expect(model.load).toHaveBeenCalledTimes(1);
    load.reject(new Error("model unavailable"));
    expect(await Promise.all([a, b])).toEqual([[], []]); expect(provider.isAvailable()).toBe(false);
    expect(await provider.getEmbedding("Later")).toEqual([]); expect(model.load).toHaveBeenCalledTimes(1);
    expect(model.extract).not.toHaveBeenCalled();
  });
  it("keeps distinct provider/model instances independent", async () => {
    await Promise.all([new TransformersEmbeddingProvider("a").getEmbedding("one"), new TransformersEmbeddingProvider("b").getEmbedding("two")]);
    expect(model.load.mock.calls.map(call => call.slice(0, 2))).toEqual([["feature-extraction", "a"], ["feature-extraction", "b"]]);
  });
  it("preserves text truncation and normalized mean pooling", async () => {
    const provider = new TransformersEmbeddingProvider(); await provider.getEmbedding("a".repeat(1000));
    expect(model.extract).toHaveBeenCalledWith("a".repeat(512), { pooling: "mean", normalize: true });
  });
  it("does not reload a successfully loaded model after an inference failure", async () => {
    const provider = new TransformersEmbeddingProvider(); model.extract.mockRejectedValueOnce(new Error("inference failed"));
    await expect(provider.getEmbedding("first")).rejects.toThrow("inference failed");
    expect(provider.isAvailable()).toBe(true); expect(await provider.getEmbedding("second")).toEqual([0.25, 0.75]);
    expect(model.load).toHaveBeenCalledTimes(1);
  });
});
