import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer, SearchSchema } from "../index.js";
import type { SearchResultItem } from "../cache/types.js";

type Response = { content: Array<{ text: string }>; isError?: boolean };
type Internals = {
  handleSearch(args: unknown): Promise<Response>;
  cache: {
    get(query: string, namespace?: string): Promise<SearchResultItem[] | null>;
    set(query: string, results: SearchResultItem[], namespace?: string): Promise<void>;
    reRankResults(query: string, results: SearchResultItem[], limit: number): Promise<SearchResultItem[]>;
  };
};

describe("web search query expansion", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("ENABLE_CROSSLINGUAL", "false");
    vi.stubEnv("ENABLE_RERANKER", "false");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function setup() {
    const detector = { detect: vi.fn(async () => ({ intent: "technical" as const, source: "heuristic" as const })) };
    const server = new WebSearchServer(detector);
    const executedQueries: string[] = [];
    server.overrideSearchProvidersForTesting([{
      name: "bing",
      execute: async (query) => {
        executedQueries.push(query);
        return query.includes("database") ? [{
          title: "Database backup", url: "https://docs.example/backup", snippet: "Backup guide", source: "bing",
        }] : [];
      },
    }]);
    const internals = server as unknown as Internals;
    const get = vi.spyOn(internals.cache, "get").mockResolvedValue(null);
    vi.spyOn(internals.cache, "set").mockResolvedValue();
    vi.spyOn(internals.cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));
    return { internals, detector, get, executedQueries };
  }

  it("recovers results through expansion while retaining domain and original intent input", async () => {
    const { internals, detector, executedQueries } = setup();
    const response = await internals.handleSearch({
      query: "db backup", strategy: "auto", expand_query: true, domain: "docs.example", format: "json",
    });
    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.query).toBe("db backup");
    expect(payload.results.map((result: SearchResultItem) => result.url)).toEqual(["https://docs.example/backup"]);
    expect(detector.detect).toHaveBeenCalledExactlyOnceWith("db backup");
    expect(executedQueries).toEqual([
      "db backup site:docs.example",
      "db database backup site:docs.example",
      "database backup site:docs.example",
    ]);
  });

  it("keeps the default single-query behavior", async () => {
    const { internals, detector, executedQueries } = setup();
    const response = await internals.handleSearch({ query: "db backup" });
    expect(response.isError).toBe(true);
    expect(detector.detect).not.toHaveBeenCalled();
    expect(executedQueries).toEqual(["db backup"]);
  });

  it("expands explicit fallback without loading the intent classifier", async () => {
    const { internals, detector } = setup();
    const response = await internals.handleSearch({ query: "db backup", expand_query: true, format: "json" });
    expect(JSON.parse(response.content[0].text).resultCount).toBe(1);
    expect(detector.detect).not.toHaveBeenCalled();
  });

  it("serves expanded cache hits without contacting providers", async () => {
    const { internals, get, executedQueries } = setup();
    get.mockResolvedValue([{
      title: "Cached", url: "https://docs.example/backup", snippet: "Cached backup guide", source: "bing",
    }]);
    const response = await internals.handleSearch({ query: "db backup", expand_query: true, format: "json" });
    expect(JSON.parse(response.content[0].text).meta.cache).toBe("hit");
    expect(executedQueries).toEqual([]);
  });

  it("isolates expanded cache lookups from single-query lookups", async () => {
    const { internals, get } = setup();
    await internals.handleSearch({ query: "db backup", expand_query: true });
    const expandedNamespace = get.mock.calls[0][1];
    await internals.handleSearch({ query: "db backup" });
    expect(expandedNamespace).not.toBe(get.mock.calls[1][1]);
    expect(get.mock.calls[1][1]).toBe("fallback");
  });

  it("validates the expansion switch", () => {
    expect(SearchSchema.parse({ query: "db", expand_query: true }).expand_query).toBe(true);
    expect(() => SearchSchema.parse({ query: "db", expand_query: "true" })).toThrow();
    expect(() => SearchSchema.parse({ query: "   ", expand_query: true })).toThrow();
  });
});
