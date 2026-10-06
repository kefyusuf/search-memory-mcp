import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { SearchResultItem } from "../cache/types.js";

const oldHit: SearchResultItem = { title: "Old guide", url: "https://docs.example/old", snippet: "Published 2024-01-10", source: "bing" };
const newHit: SearchResultItem = { title: "New guide", url: "https://docs.example/new", snippet: "Published 2026-09-10", source: "bing" };
type Response = { content: Array<{ text: string }>; isError?: boolean };
type Internals = { cache: SemanticCache; handleSearch(args: unknown): Promise<Response>; buildSearchResponse(query: string, results: SearchResultItem[], format: string): Promise<Response> };

describe("cached search filters", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("ENABLE_CROSSLINGUAL", "false");
    vi.stubEnv("ENABLE_RERANKER", "false");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  function setup() {
    const server = new WebSearchServer({ detect: async () => ({ intent: "technical", source: "heuristic" }) });
    const internals = server as unknown as Internals;
    internals.cache.close();
    // Identical embeddings model the strongest possible semantic-cache collision.
    internals.cache = new SemanticCache({
      getEmbedding: async () => [1, ...new Array(383).fill(0)], isAvailable: () => true,
    }, new InMemoryVectorStore());
    vi.spyOn(internals.cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));
    let providerCalls = 0;
    server.overrideSearchProvidersForTesting([{
      name: "bing", execute: async () => { providerCalls++; return [oldHit, newHit]; },
    }]);
    return { internals, calls: () => providerCalls };
  }

  it.each(["fallback", "aggregate", "auto"])("isolates date ranges with %s", async (strategy) => {
    const { internals, calls } = setup();
    const first = await internals.handleSearch({ query: "database guides", strategy, from_date: "2024-01-01", to_date: "2024-12-31", format: "json" });
    const second = await internals.handleSearch({ query: "database guides", strategy, from_date: "2026-01-01", format: "json", expand_query: false });
    expect(JSON.parse(first.content[0].text).results.map((r: SearchResultItem) => r.url)).toEqual([oldHit.url]);
    expect(JSON.parse(second.content[0].text).results.map((r: SearchResultItem) => r.url)).toEqual([newHit.url]);
    expect(calls()).toBe(2);
  });

  it("does not let a filtered search poison a later unfiltered search", async () => {
    const { internals } = setup();
    await internals.handleSearch({ query: "database guides", from_date: "2026-01-01" });
    const response = await internals.handleSearch({ query: "database guides", format: "json" });
    expect(JSON.parse(response.content[0].text).results.map((r: SearchResultItem) => r.url)).toEqual([oldHit.url, newHit.url]);
  });

  it.each([false, true])("rechecks domain/date on cache hits before output or deep fetch (deep=%s)", async (deep) => {
    const { internals, calls } = setup();
    vi.spyOn(internals.cache, "get").mockResolvedValue([
      oldHit, newHit, { ...newHit, url: "https://other.example/new" },
    ]);
    vi.spyOn(internals, "buildSearchResponse").mockImplementation(async (_query, results) => ({
      content: [{ text: JSON.stringify({ results }) }],
    }));
    const response = await internals.handleSearch({ query: "database guides", domain: "docs.example", from_date: "2026-01-01", format: "json", deep });
    expect(JSON.parse(response.content[0].text).results.map((r: SearchResultItem) => r.url)).toEqual([newHit.url]);
    expect(calls()).toBe(0);
  });

  it("tries providers when cached candidates are all outside the requested filters", async () => {
    const { internals, calls } = setup();
    vi.spyOn(internals.cache, "get").mockResolvedValue([oldHit]);
    const response = await internals.handleSearch({ query: "database guides", from_date: "2026-01-01", format: "json", expand_query: true });
    expect(JSON.parse(response.content[0].text).results.map((r: SearchResultItem) => r.url)).toEqual([newHit.url]);
    expect(calls()).toBeGreaterThan(0);
  });
});
