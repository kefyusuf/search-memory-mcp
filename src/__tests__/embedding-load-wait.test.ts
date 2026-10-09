import { beforeEach, describe, expect, it, vi } from "vitest";
const model = vi.hoisted(() => ({ load: vi.fn(), extract: vi.fn() }));
vi.mock("@huggingface/transformers", () => ({ pipeline: (...args: unknown[]) => model.load(...args) }));
import { TransformersEmbeddingProvider } from "../cache/embedding.js";

describe("embedding model first download", () => {
  beforeEach(() => { model.extract.mockReset().mockResolvedValue({ data: new Float32Array([0.5, 0.5]) }); model.load.mockReset(); });

  it("answers without a vector while the model is still downloading, then uses it once loaded", async () => {
    let finish!: (extractor: unknown) => void;
    model.load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const provider = new TransformersEmbeddingProvider("test", { loadWaitMs: 20 });

    expect(await provider.getEmbedding("first")).toEqual([]);
    expect(provider.isAvailable()).toBe(true);

    finish(model.extract);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await provider.getEmbedding("second")).toEqual([0.5, 0.5]);
    expect(model.load).toHaveBeenCalledTimes(1);
  });

  it("starts the download ahead of the first call with warmUp", async () => {
    model.load.mockResolvedValue(model.extract);
    const provider = new TransformersEmbeddingProvider("test");
    provider.warmUp();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(model.load).toHaveBeenCalledTimes(1);
    expect(await provider.getEmbedding("x")).toEqual([0.5, 0.5]);
    expect(model.load).toHaveBeenCalledTimes(1);
  });
});
