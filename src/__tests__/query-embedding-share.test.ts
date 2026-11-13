import { describe, it, expect, vi } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { IEmbeddingProvider } from "../cache/types.js";
import { InvocationError } from "../runtime/request-context.js";
import { createSearchHandler, SearchTraceHistory } from "../tools/search.js";
import { TokenBucket } from "../rate-limiter.js";
import { ProviderHealthTracker } from "../providers/health.js";

function vec(...values: number[]): number[] {
  const v = new Array(384).fill(0);
  values.forEach((x, i) => {
    v[i] = x;
  });
  return v;
}

function countingProvider(): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async () => vec(1, 0)),
    isAvailable: () => true,
  };
}

describe("query embedding sharing", () => {
  it("get reuses a precomputed query vector without re-embedding", async () => {
    const provider = countingProvider();
    const cache = new SemanticCache(provider, new InMemoryVectorStore());

    const result = await cache.get("q", "fallback", vec(1, 0));

    expect(result).toBeNull();
    expect(provider.getEmbedding).not.toHaveBeenCalled();
  });

  it("set reuses a precomputed query vector without re-embedding", async () => {
    const provider = countingProvider();
    const cache = new SemanticCache(provider, new InMemoryVectorStore());
    const vector = vec(1, 0);
    const hit = { title: "Hit", url: "https://a.example/1", snippet: "s", source: "mock" };

    await cache.set("q", [hit], "fallback", {}, vector);

    expect(provider.getEmbedding).not.toHaveBeenCalled();
    expect(await cache.get("q", "fallback", vector)).toEqual([hit]);
  });

  it("re-rank reuses a precomputed query vector without re-embedding the query", async () => {
    const provider = countingProvider();
    const cache = new SemanticCache(provider, new InMemoryVectorStore());
    const raw = [
      { title: "A", snippet: "a", url: "1", source: "test" },
      { title: "B", snippet: "b", url: "2", source: "test" },
    ];

    await cache.reRankResults("q", raw, 5, vec(1, 0));

    expect(provider.getEmbedding).not.toHaveBeenCalledWith("q");
    expect(provider.getEmbedding).toHaveBeenCalledTimes(2);
  });

  it("re-rank bounds concurrent result embeddings instead of fanning out unbounded", async () => {
    let active = 0;
    let peak = 0;
    const provider: IEmbeddingProvider = {
      getEmbedding: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return vec(1, 0);
      }),
      isAvailable: () => true,
    };
    const cache = new SemanticCache(provider, new InMemoryVectorStore());
    const raw = Array.from({ length: 40 }, (_, i) => ({
      title: `T${i}`,
      snippet: `S${i}`,
      url: `${i}`,
      source: "test",
    }));

    await cache.reRankResults("q", raw, 40, vec(1, 0));

    expect(peak).toBeLessThanOrEqual(8);
    expect(provider.getEmbedding).toHaveBeenCalledTimes(40);
  });

  it("re-rank propagates embedding capacity errors instead of swallowing them", async () => {
    const provider: IEmbeddingProvider = {
      getEmbedding: vi.fn(async () => {
        throw new InvocationError("embedding_capacity_exceeded");
      }),
      isAvailable: () => true,
    };
    const cache = new SemanticCache(provider, new InMemoryVectorStore());
    const raw = [{ title: "A", snippet: "a", url: "1", source: "test" }];

    await expect(cache.reRankResults("q", raw, 5, vec(1, 0))).rejects.toThrow("embedding_capacity_exceeded");
  });
});

describe("web_search query embedding sharing", () => {
  const hit = { title: "Hit", url: "https://a.example/1", snippet: "s", source: "mock" };

  function handler(store: SemanticCache) {
    return createSearchHandler({
      searchLimiter: new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 }),
      cache: () => store,
      providers: () => [{ name: "mock", execute: async () => [hit] }],
      healthTracker: () => new ProviderHealthTracker(),
      intentDetector: { detect: async () => ({ intent: "general", source: "classifier" }) },
      crossLingual: null,
      reranker: null,
      fetchPage: async () => null,
      traces: new SearchTraceHistory(),
    });
  }

  it("embeds the query once across cache get/set/re-rank on a miss", async () => {
    const provider = countingProvider();
    const store = new SemanticCache(provider, new InMemoryVectorStore());

    await handler(store)({ query: "q" });

    const queryCalls = vi.mocked(provider.getEmbedding).mock.calls.filter((call) => call[0] === "q");
    expect(queryCalls).toHaveLength(1);
  });

  it("embeds the query once across cache get and re-rank on a hit", async () => {
    const provider = countingProvider();
    const store = new SemanticCache(provider, new InMemoryVectorStore());
    await store.set("q", [hit], "fallback");
    vi.mocked(provider.getEmbedding).mockClear();

    await handler(store)({ query: "q" });

    const queryCalls = vi.mocked(provider.getEmbedding).mock.calls.filter((call) => call[0] === "q");
    expect(queryCalls).toHaveLength(1);
  });
});
