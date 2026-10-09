import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { EntityGraph } from "../graph/entity-graph.js";
import { TokenBucket } from "../rate-limiter.js";
import type { FetchContentResult } from "../fetch-module.js";
import { createResearchHandler } from "../tools/research.js";
import { textResult, errorResult, type ToolResult } from "../tools/types.js";

const stores: Array<{ close(): void }> = [];
afterEach(() => { stores.splice(0).forEach((store) => store.close()); });

const webResults = [
  { title: "PgBouncer docs", url: "https://pgbouncer.example/docs", snippet: "s", source: "mock" },
  { title: "Pooling guide", url: "https://guide.example/pooling", snippet: "s", source: "mock" },
  { title: "Third", url: "https://third.example/", snippet: "s", source: "mock" },
];

const pages: Record<string, string> = {
  "https://pgbouncer.example/docs": "# PgBouncer docs\n\nPgBouncer is a lightweight connection pooler for PostgreSQL.",
  "https://guide.example/pooling": "# Pooling guide\n\nTransaction pooling lets many clients share few PostgreSQL connections.",
};

function setup(overrides: { search?: (args: unknown) => Promise<ToolResult>; fetchLimiter?: TokenBucket } = {}) {
  const knowledgeIndex = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
  const entityGraph = new EntityGraph(":memory:");
  stores.push(knowledgeIndex, entityGraph);
  const search = vi.fn(overrides.search ?? (async () => textResult("ignored", { query: "q", resultCount: 3, results: webResults, meta: {} })));
  const fetchContent = vi.fn(async (url: string): Promise<FetchContentResult> =>
    pages[url]
      ? { kind: "content", text: pages[url], source: "http", fetchedAt: "2026-10-09T08:00:00.000Z", ...(url.includes("pgbouncer") ? { publishedAt: "2024-03-05" } : {}) }
      : { kind: "error", reason: "fetch_failed" });
  const research = createResearchHandler({
    search,
    fetchContent,
    fetchLimiter: overrides.fetchLimiter ?? new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 }),
    knowledgeIndex,
    entityGraph,
    embed: async () => [],
  });
  return { research, search, fetchContent, knowledgeIndex };
}

describe("research tool", () => {
  it("searches, reads the top pages, answers with citations and indexes what it read", async () => {
    const { research, search, fetchContent, knowledgeIndex } = setup();
    const result = await research({ query: "what is pgbouncer connection pooling", max_sources: 3, domain: "example" });

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "what is pgbouncer connection pooling", domain: "example", format: "json" }));
    expect(fetchContent.mock.calls.map(([url]) => url)).toEqual(webResults.map((r) => r.url));
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PgBouncer is a lightweight connection pooler");
    expect(result.structuredContent).toMatchObject({
      query: "what is pgbouncer connection pooling",
      indexedCount: 2,
      sources: [
        { origin: "web", url: "https://pgbouncer.example/docs", title: "PgBouncer docs", status: "indexed" },
        { origin: "web", url: "https://guide.example/pooling", title: "Pooling guide", status: "indexed" },
        { origin: "web", url: "https://third.example/", status: "fetch_failed" },
      ],
    });
    expect(knowledgeIndex.listDocs().map((doc) => doc.source).sort()).toEqual(["https://guide.example/pooling", "https://pgbouncer.example/docs"]);
    expect(knowledgeIndex.listDocs()[0].category).toBe("research");
  });

  it("does not index the same source twice", async () => {
    const { research, knowledgeIndex } = setup();
    await research({ query: "pgbouncer pooling" });
    const second = await research({ query: "pgbouncer pooling" });

    expect(knowledgeIndex.getStats().docCount).toBe(2);
    expect(second.structuredContent).toMatchObject({ indexedCount: 0 });
    const sources = second.structuredContent?.sources as Array<{ origin: string; status: string }>;
    // Local hits for pages the web search also returned are not listed twice.
    expect(sources.map((source) => `${source.origin}:${source.status}`)).toEqual(["web:already_indexed", "web:already_indexed", "web:fetch_failed"]);
  });

  it("brings back what an earlier research call read", async () => {
    let call = 0;
    const { research } = setup({
      search: async () => textResult("ignored", { query: "q", resultCount: 1, results: call++ === 0 ? webResults : [webResults[2]], meta: {} }),
    });
    await research({ query: "pgbouncer connection pooler" });
    const later = await research({ query: "pgbouncer connection pooler" });

    expect(later.content[0].text).toContain("PgBouncer is a lightweight connection pooler");
    expect(later.structuredContent?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: "local", url: "https://pgbouncer.example/docs", title: "PgBouncer docs", status: "already_indexed" }),
    ]));
  });

  it("does not write when index=false", async () => {
    const { research, knowledgeIndex } = setup();
    const result = await research({ query: "pgbouncer pooling", index: false });
    expect(knowledgeIndex.getStats().docCount).toBe(0);
    expect((result.structuredContent?.sources as Array<{ status: string }>)[0].status).toBe("not_indexed");
  });

  it("answers from local knowledge when web search fails", async () => {
    const { research, knowledgeIndex } = setup({ search: async () => errorResult("Web search is currently unavailable") });
    knowledgeIndex.ingest({ content: "PgBouncer keeps a pool of server connections.", title: "Local note", source: "notes.md" });
    const result = await research({ query: "pgbouncer pool" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("PgBouncer keeps a pool of server connections.");
    expect(result.content[0].text).toContain("Web search is currently unavailable");
    expect(result.structuredContent).toMatchObject({ sources: [{ origin: "local", url: "notes.md", status: "already_indexed" }] });
  });

  it("returns the search error when there is nothing local either", async () => {
    const { research } = setup({ search: async () => errorResult("Web search is currently unavailable") });
    const result = await research({ query: "pgbouncer" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Web search is currently unavailable");
  });

  it("stops fetching when the fetch rate limit is used up", async () => {
    const { research, fetchContent } = setup({ fetchLimiter: new TokenBucket({ maxTokens: 1, refillRatePerSecond: 0 }) });
    const result = await research({ query: "pgbouncer", max_sources: 3 });
    expect(fetchContent).toHaveBeenCalledTimes(1);
    expect((result.structuredContent?.sources as Array<{ status: string }>).map((source) => source.status)).toEqual(["indexed", "rate_limited", "rate_limited"]);
  });
});

describe("research source dates", () => {
  it("shows when each web page was published and fetched", async () => {
    const { research } = setup();
    const result = await research({ query: "what is pgbouncer connection pooling" });
    const sources = result.structuredContent?.sources as Array<Record<string, unknown>>;
    expect(sources[0]).toMatchObject({ url: "https://pgbouncer.example/docs", publishedAt: "2024-03-05", fetchedAt: "2026-10-09T08:00:00.000Z" });
    expect(sources[1]).not.toHaveProperty("publishedAt");
    expect(sources[1]).toMatchObject({ fetchedAt: "2026-10-09T08:00:00.000Z" });
    expect(result.content[0].text).toContain("PgBouncer docs — https://pgbouncer.example/docs (added to knowledge base; published 2024-03-05; fetched 2026-10-09)");
  });

  it("shows when local knowledge was indexed", async () => {
    const { research, knowledgeIndex } = setup({ search: async () => errorResult("offline") });
    knowledgeIndex.ingest({ content: "PgBouncer keeps a pool of server connections.", title: "Local note", source: "notes.md" });
    const result = await research({ query: "pgbouncer pool" });
    const local = (result.structuredContent?.sources as Array<Record<string, unknown>>)[0];
    expect(local).toMatchObject({ origin: "local", fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(result.content[0].text).toMatch(/Local note — notes\.md \(already in knowledge base; indexed \d{4}-\d{2}-\d{2}\)/);
  });
});

describe("KnowledgeIndex.findDocBySource", () => {
  it("returns the newest document for a source", () => {
    const index = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
    stores.push(index);
    expect(index.findDocBySource("a.md")).toBeNull();
    index.ingest({ content: "first", source: "a.md", title: "First" });
    index.ingest({ content: "second", source: "a.md", title: "Second" });
    expect(index.findDocBySource("a.md")?.title).toBe("Second");
  });
});
