import { afterEach, describe, expect, it, vi } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import { searchCacheTtlMs } from "../cache/search-ttl.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { TokenBucket } from "../rate-limiter.js";
import { createSearchHandler, SearchTraceHistory } from "../tools/search.js";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { InMemoryVectorStore } from "./helpers.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const hit = { title: "Hit", url: "https://a.example/1", snippet: "s", source: "mock" };

function cache() {
  return new SemanticCache({ getEmbedding: async () => [1, ...new Array(383).fill(0)], isAvailable: () => true }, new InMemoryVectorStore());
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("search cache TTL by intent", () => {
  it("keeps fast-changing queries briefly and reference queries longer", () => {
    expect(searchCacheTtlMs("news")).toBe(15 * MINUTE);
    expect(searchCacheTtlMs("shopping")).toBe(HOUR);
    expect(searchCacheTtlMs("local")).toBe(HOUR);
    expect(searchCacheTtlMs("general")).toBe(HOUR);
    expect(searchCacheTtlMs("commercial")).toBe(HOUR);
    expect(searchCacheTtlMs("technical")).toBe(24 * HOUR);
    expect(searchCacheTtlMs("research")).toBe(24 * HOUR);
    expect(searchCacheTtlMs("navigational")).toBe(24 * HOUR);
  });

  it.each([
    ["news", 14 * MINUTE, true],
    ["news", 16 * MINUTE, false],
    ["technical", 23 * HOUR, true],
    ["technical", 25 * HOUR, false],
  ] as const)("serves a %s entry aged %d ms: %s", async (intent, age, served) => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const store = cache();
    await store.set("query", [hit], "fallback", { ttlMs: searchCacheTtlMs(intent) });
    vi.setSystemTime(Date.now() + age);
    expect(await store.get("query", "fallback")).toEqual(served ? [hit] : null);
  });

  it.each([true, false])("persists the TTL in SQLite (native vectors: %s)", async (useNativeVectors) => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const sqlite = new SQLiteVectorStore(":memory:", { useNativeVectors });
    const store = new SemanticCache({ getEmbedding: async () => [1, ...new Array(383).fill(0)], isAvailable: () => true }, sqlite);
    await store.set("query", [hit], "fallback", { ttlMs: searchCacheTtlMs("technical") });
    vi.setSystemTime(Date.now() + 2 * HOUR);
    expect(await store.get("query", "fallback")).toEqual([hit]);
    store.close();
  });

  it("keeps the one-hour limit for entries stored without a TTL", async () => {
    vi.useFakeTimers({ now: 1_000_000_000_000 });
    const store = cache();
    await store.set("query", [hit], "fallback");
    vi.setSystemTime(Date.now() + 59 * MINUTE);
    expect(await store.get("query", "fallback")).toEqual([hit]);
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(await store.get("query", "fallback")).toBeNull();
  });
});

describe("web_search cache TTL", () => {
  function search(store: SemanticCache, intent: "news" | "technical" = "technical") {
    vi.spyOn(store, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));
    return createSearchHandler({
      searchLimiter: new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 }),
      cache: () => store,
      providers: () => [{ name: "brave", execute: async () => [hit] }],
      healthTracker: () => new ProviderHealthTracker(),
      intentDetector: { detect: async () => ({ intent, source: "classifier" }) },
      crossLingual: null,
      reranker: null,
      fetchPage: async () => null,
      traces: new SearchTraceHistory(),
    });
  }

  it.each([
    ["latest kubernetes news today", 15 * MINUTE],
    ["react query retry configuration error", 24 * HOUR],
    ["how tall is mount everest", HOUR],
  ])("stores %s with the heuristic intent TTL", async (query, ttlMs) => {
    const store = cache();
    const set = vi.spyOn(store, "set");
    await search(store)({ query });
    expect(set).toHaveBeenCalledWith(query, [hit], "fallback", { ttlMs });
  });

  it("uses the planned intent for strategy=auto", async () => {
    const store = cache();
    const set = vi.spyOn(store, "set");
    await search(store, "news")({ query: "how tall is mount everest", strategy: "auto" });
    expect(set).toHaveBeenCalledWith("how tall is mount everest", expect.any(Array), "auto:v1:news:brave", { ttlMs: 15 * MINUTE });
  });
});
