import { describe, it, expect, vi, beforeEach } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { IEmbeddingProvider } from "../cache/types.js";

function createMockEmbedding(vectors: Record<string, number[]>): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async (text: string) => {
      if (vectors[text]) return vectors[text];
      return new Array(384).fill(0.01);
    }),
    isAvailable: vi.fn(() => true),
  };
}

function makeVec(values: number[]): number[] {
  const vec = new Array(384).fill(0);
  values.forEach((v, i) => { vec[i] = v; });
  return vec;
}

describe("SemanticCache", () => {
  let store: InMemoryVectorStore;
  let cache: SemanticCache;

  beforeEach(() => {
    store = new InMemoryVectorStore();
  });

  it("finds an eligible namespace even when five closer entries use other namespaces", async () => {
    cache = new SemanticCache(createMockEmbedding({}), store);
    for (let i = 0; i < 6; i++) {
      await cache.set(`query ${i}`, [{ title: `Result ${i}`, url: `https://example.com/${i}`, snippet: "s", source: "test" }], `namespace-${i}`);
    }
    expect((await cache.get("query", "namespace-5"))?.[0].title).toBe("Result 5");
  });

  it("skips expired candidates and still uses a later valid hit", async () => {
    cache = new SemanticCache(createMockEmbedding({}), store);
    const vector = new Array(384).fill(0.01);
    await store.add("expired", vector, { query: "q", timestamp: Date.now() - 7_200_000, results: [{ title: "Expired", url: "https://example.com/old", snippet: "s", source: "test" }] });
    await cache.set("fresh", [{ title: "Fresh", url: "https://example.com/new", snippet: "s", source: "test" }]);
    expect((await cache.get("q", "fallback"))?.[0].title).toBe("Fresh");
  });

  it("should return cached results for semantically similar query", async () => {
    const mockEmbed = createMockEmbedding({
      "weather london":  makeVec([1, 0]),
      "london forecast": makeVec([0.99, 0.14]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    await cache.set("weather london", [{ title: "London Weather" }]);
    const hit = await cache.get("london forecast");
    expect(hit).not.toBeNull();
    expect(hit[0].title).toBe("London Weather");
  });

  it("should miss for unrelated queries", async () => {
    const mockEmbed = createMockEmbedding({
      "weather london": makeVec([1, 0]),
      "unrelated":       makeVec([0, 1]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    await cache.set("weather london", [{ title: "London Weather" }]);
    const hit = await cache.get("unrelated");
    expect(hit).toBeNull();
  });

  it("should detect content category from URL and title", async () => {
    const mockEmbed = createMockEmbedding({});
    cache = new SemanticCache(mockEmbed, store);

    await cache.setCachedContent("https://docs.example.com/api", "Content", "API Guide");
    const entry = await store.getContent("https://docs.example.com/api");
    expect(entry!.category).toBe("docs");
  });

  it("should re-rank results by semantic relevance", async () => {
    const mockEmbed = createMockEmbedding({
      "MCP protocol":        makeVec([1, 0]),
      "MCP Guide A guide on Model Context Protocol":   makeVec([0.95, 0.3]),
      "Cooking Pasta How to cook pasta at home":        makeVec([0.1, 1]),
    });
    cache = new SemanticCache(mockEmbed, store);

    const raw = [
      { title: "Cooking Pasta", snippet: "How to cook pasta at home", url: "1" },
      { title: "MCP Guide", snippet: "A guide on Model Context Protocol", url: "2" },
    ];
    const ranked = await cache.reRankResults("MCP protocol", raw);
    expect(ranked[0].title).toBe("MCP Guide");
  });

  it("should respect the requested re-rank limit", async () => {
    const vectors: Record<string, number[]> = {
      "MCP protocol": makeVec([1, 0]),
    };
    const raw = Array.from({ length: 8 }, (_, index) => {
      const title = `Result ${index}`;
      const snippet = `Snippet ${index}`;
      vectors[`${title} ${snippet}`] = makeVec([1 - index * 0.01, index * 0.01]);
      return {
        title,
        snippet,
        url: `https://example.com/${index}`,
        source: "test",
      };
    });
    cache = new SemanticCache(createMockEmbedding(vectors), store);

    const ranked = await cache.reRankResults("MCP protocol", raw, 8);

    expect(ranked).toHaveLength(8);
  });

  it("should bootstrap embeddings even when provider reports unavailable before first call", async () => {
    const lazyProvider: IEmbeddingProvider = {
      getEmbedding: vi.fn(async (text: string) => {
        if (text === "gold price") return makeVec([1, 0]);
        if (text === "Gold live market rate") return makeVec([0.95, 0.2]);
        return makeVec([0, 1]);
      }),
      isAvailable: vi.fn(() => false),
    };
    cache = new SemanticCache(lazyProvider, store, 0.7);

    await cache.set("gold price", [{ title: "Gold", url: "https://example.com/gold", snippet: "live market rate", source: "test" }]);
    const hit = await cache.get("gold price");

    expect(hit).not.toBeNull();
    expect(lazyProvider.getEmbedding).toHaveBeenCalled();
  });

  it("isolates cache hits by execution namespace", async () => {
    const mockEmbed = createMockEmbedding({
      "postgres pooling": makeVec([1, 0]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    await cache.set("postgres pooling", [{ title: "Fallback hit", url: "https://a.example", snippet: "s", source: "test" }], "fallback");
    await cache.set("postgres pooling", [{ title: "Aggregate hit", url: "https://b.example", snippet: "s", source: "test" }], "aggregate");

    const fallbackHit = await cache.get("postgres pooling", "fallback");
    const aggregateHit = await cache.get("postgres pooling", "aggregate");
    const autoMiss = await cache.get("postgres pooling", "auto:v1:technical:searxng,brave");

    expect(fallbackHit?.[0].title).toBe("Fallback hit");
    expect(aggregateHit?.[0].title).toBe("Aggregate hit");
    expect(autoMiss).toBeNull();
  });

  it("treats legacy entries without a namespace as fallback", async () => {
    const mockEmbed = createMockEmbedding({
      "weather london": makeVec([1, 0]),
    });
    cache = new SemanticCache(mockEmbed, store, 0.70);

    // Simulate a pre-upgrade cache entry with no namespace field.
    await store.add("legacy-id", makeVec([1, 0]), {
      query: "weather london",
      results: [{ title: "Legacy", url: "https://legacy.example", snippet: "s", source: "test" }],
      timestamp: Date.now(),
    });

    const hit = await cache.get("weather london", "fallback");
    expect(hit?.[0].title).toBe("Legacy");
  });
});
