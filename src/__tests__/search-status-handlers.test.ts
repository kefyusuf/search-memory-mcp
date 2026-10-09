import { describe, expect, it, vi } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import type { SearchResultItem } from "../cache/types.js";
import { ProviderHealthTracker } from "../providers/health.js";
import type { SearchProvider } from "../providers/base.js";
import { TokenBucket } from "../rate-limiter.js";
import { createSearchHandler, SearchTraceHistory, type SearchToolDeps } from "../tools/search.js";
import { createStatusHandler } from "../tools/status.js";
import { InMemoryVectorStore } from "./helpers.js";

const hit = (url: string): SearchResultItem => ({ title: `Title ${url}`, url, snippet: "snippet", source: "mock" });
const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;

function deps(overrides: Partial<SearchToolDeps> = {}): SearchToolDeps {
  const cache = new SemanticCache({ getEmbedding: async () => [], isAvailable: () => false }, new InMemoryVectorStore());
  vi.spyOn(cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));
  const providers: SearchProvider[] = [{ name: "mock", execute: async () => [hit("https://a.example/1"), hit("https://b.example/2")] }];
  return {
    searchLimiter: new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 }),
    cache: () => cache,
    providers: () => providers,
    healthTracker: () => new ProviderHealthTracker(),
    intentDetector: { detect: async () => ({ intent: "general", source: "heuristic" }) },
    crossLingual: null,
    reranker: null,
    fetchPage: async () => null,
    traces: new SearchTraceHistory(),
    ...overrides,
  };
}

describe("web_search handler", () => {
  it("returns ranked results and records a trace", async () => {
    const traces = new SearchTraceHistory();
    const search = createSearchHandler(deps({ traces }));
    const result = await search({ query: "example", max_results: 1 });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("https://a.example/1");
    expect(text(result)).not.toContain("https://b.example/2");
    expect(traces.recent()).toEqual([expect.objectContaining({ query: "example", cache: "miss", strategy: "fallback", resultCount: 1 })]);
  });

  it("returns structured JSON when requested", async () => {
    const search = createSearchHandler(deps());
    const parsed = JSON.parse(text(await search({ query: "example", format: "json" })));
    expect(parsed).toMatchObject({ query: "example", results: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }] });
  });

  it("explains empty and domain-filtered results", async () => {
    const empty = createSearchHandler(deps({ providers: () => [{ name: "mock", execute: async () => [] }] }));
    const none = await empty({ query: "example" });
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/^Web search is currently unavailable/);

    const filtered = await createSearchHandler(deps())({ query: "example", domain: "c.example" });
    expect(text(filtered)).toBe('No results matched the domain filter "c.example". Try a broader search or fetch_content with a direct URL.');
  });

  it("enforces the search rate limit before validating input", async () => {
    const search = createSearchHandler(deps({ searchLimiter: new TokenBucket({ maxTokens: 0, refillRatePerSecond: 0 }) }));
    const result = await search({ query: "" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^Rate limit exceeded: web_search allows 10 requests per minute/);
  });

  it("answers deep searches from fetched pages", async () => {
    const search = createSearchHandler(deps({
      fetchPage: async (url) => ({ url, title: "Doc", content: "Example answers explain the example topic in detail." }),
    }));
    const result = await search({ query: "example topic", deep: true });
    expect(text(result)).toContain("https://a.example/1");
  });
});

describe("SearchTraceHistory", () => {
  it("keeps the newest entries up to its limit", () => {
    const history = new SearchTraceHistory(2);
    for (const query of ["a", "b", "c"]) history.push({ query, totalMs: 1, cache: "miss", strategy: "fallback", resultCount: 0 });
    expect(history.recent().map((entry) => entry.query)).toEqual(["c", "b"]);
  });
});

describe("server_status handler", () => {
  it("reports provider health, stores and configuration", async () => {
    const status = createStatusHandler({
      providers: () => [{ name: "mock", execute: async () => [] }],
      healthTracker: () => new ProviderHealthTracker(),
      cacheStats: () => ({ contentCount: 1, vectorCount: 2 }),
      knowledgeStats: () => ({ docCount: 0, chunkCount: 0, vectorCount: 0 }),
      memoryStats: () => ({ count: 0, sessions: 0 }),
      graphStats: () => ({ entityCount: 0, docCount: 0, linkCount: 0 }),
      traces: new SearchTraceHistory(),
      browserRunning: () => false,
      crosslingualEnabled: false,
      rerankerEnabled: true,
      fetchWaitUntil: "networkidle",
      cacheDbPath: "test.db",
      startedAt: Date.now() - 5_000,
    });
    const parsed = JSON.parse(text(await status()));
    expect(parsed).toMatchObject({
      providers: [{ name: "mock", available: true }],
      cache: { contentCount: 1, vectorCount: 2 },
      browser: "idle",
      crosslingual: "disabled",
      config: { searchProviders: ["mock"], reranker: "enabled", cacheDbPath: "test.db", fetchWaitUntil: "networkidle" },
    });
    expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(5);
  });
});
