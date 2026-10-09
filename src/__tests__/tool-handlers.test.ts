import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { SessionMemory } from "../memory/session-memory.js";
import { EntityGraph } from "../graph/entity-graph.js";
import { TokenBucket } from "../rate-limiter.js";
import { createMemoryHandlers } from "../tools/memory.js";
import { createKnowledgeHandlers } from "../tools/knowledge.js";
import { createFetchHandler } from "../tools/fetch.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { WebSearchServer } from "../index.js";
import { createLocalRequestContext } from "../runtime/request-context.js";

const closers: Array<{ close(): void }> = [];
afterEach(() => {
  closers.splice(0).forEach((store) => store.close());
  vi.unstubAllEnvs();
});

function track<T extends { close(): void }>(store: T): T {
  closers.push(store);
  return store;
}

const text = (result: { content: Array<{ text: string }> }) => result.content[0].text;
const exhausted = () => new TokenBucket({ maxTokens: 0, refillRatePerSecond: 0 });
const open = () => new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 });
const publicUrl = async () => ({ ok: true as const });

function knowledge(overrides: Partial<Parameters<typeof createKnowledgeHandlers>[0]> = {}) {
  return createKnowledgeHandlers({
    knowledgeIndex: track(new KnowledgeIndex(":memory:", { enableEmbeddings: false })),
    entityGraph: track(new EntityGraph(":memory:")),
    embed: async () => [],
    fetchContent: async () => ({ kind: "content", text: "# Page\n\nKubernetes runs PgBouncer.", source: "http" }),
    fetchLimiter: open(),
    validateUrl: publicUrl,
    ...overrides,
  });
}

describe("memory tool handlers", () => {
  it("remembers, recalls and forgets notes", async () => {
    const tools = createMemoryHandlers({ sessionMemory: track(new SessionMemory(":memory:")) });
    const saved = await tools.remember({ text: "Prefers TypeScript", topic: "prefs", session: "s1" });
    expect(text(saved)).toMatch(/^Remembered \(id=.+, topic=prefs, session=s1\): Prefers TypeScript$/);
    const id = /id=([^,]+)/.exec(text(saved))![1];

    expect(text(await tools.recall({ query: "TypeScript" }))).toContain(`[${id}] (prefs) Prefers TypeScript`);
    expect(text(await tools.forget({ id }))).toBe(`Deleted note ${id}`);
    const missing = await tools.forget({ id });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toBe(`No note found with id ${id}`);
    expect(text(await tools.recall(undefined))).toBe("No memory notes matched. (0 notes stored across 0 sessions)");
  });
});

describe("knowledge tool handlers", () => {
  it("ingests, lists, searches and links documents", async () => {
    const tools = knowledge();
    const ingested = await tools.ingest_document({ content: "Kubernetes uses PgBouncer for pooling.", title: "Pooling", source: "notes.md" });
    expect(text(ingested)).toMatch(/^Indexed document "Pooling" \(.+…\)\nSource: notes\.md\nChunks: 1\nEntities: \d+\nCategory: /);

    expect(text(await tools.list_index({}))).toMatch(/^Knowledge index: 1 docs, 1 chunks, 0 vectors\n\n1\. Pooling \(notes\.md\)/);
    expect(text(await tools.search_index({ query: "PgBouncer" }))).toContain('[Source 1] "Pooling" (notes.md)');
    expect(text(await tools.find_related({ entity: "Kubernetes" }))).toContain("Pooling (notes.md)");
  });

  it("reports empty index states", async () => {
    const tools = knowledge();
    expect(text(await tools.list_index(undefined))).toBe("Knowledge index is empty. Use ingest_document or index_url to add content.");
    expect(text(await tools.search_index({ query: "nothing" }))).toBe('No knowledge-index chunks matched "nothing". Use ingest_document or index_url to add content first.');
    expect(text(await tools.find_related({ entity: "Nobody" }))).toContain('No graph links found for entity "Nobody"');
  });

  it("indexes a fetched URL", async () => {
    const tools = knowledge();
    const result = await tools.index_url({ url: "https://example.com/doc" });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toMatch(/^Indexed https:\/\/example\.com\/doc\nTitle: https:\/\/example\.com\/doc\nChunks: 1/);
  });

  it("rejects index_url when rate limited, blocked or unfetchable", async () => {
    expect(text(await knowledge({ fetchLimiter: exhausted() }).index_url({ url: "https://example.com" })))
      .toMatch(/^Rate limit exceeded: index_url allows 20 requests per minute/);
    expect(text(await knowledge({ validateUrl: async () => ({ ok: false, hostname: "10.0.0.1" }) }).index_url({ url: "https://example.com" })))
      .toBe("Access to unsupported or local/private resource is blocked for security reasons: 10.0.0.1");
    expect(text(await knowledge({ fetchContent: async () => ({ kind: "error", reason: "fetch_failed" }) }).index_url({ url: "https://example.com" })))
      .toBe("Could not fetch page for indexing: fetch_failed");
  });
});

describe("fetch_content handler", () => {
  it("returns content and maps failures", async () => {
    const ok = createFetchHandler({ fetchLimiter: open(), validateUrl: publicUrl, fetchContent: async () => ({ kind: "content", text: "Hello", source: "http" }) });
    expect(await ok({ url: "https://example.com" })).toEqual({ content: [{ type: "text", text: wrapUntrusted("Hello", "https://example.com") }] });

    const parse = createFetchHandler({ fetchLimiter: open(), validateUrl: publicUrl, fetchContent: async () => ({ kind: "error", reason: "parse_failed" }) });
    expect(text(await parse({ url: "https://example.com" }))).toBe("Could not parse article content from the page.");

    const limited = createFetchHandler({ fetchLimiter: exhausted(), validateUrl: publicUrl, fetchContent: async () => ({ kind: "content", text: "", source: "http" }) });
    expect(text(await limited({ url: "https://example.com" }))).toMatch(/^Rate limit exceeded: fetch_content allows 20 requests per minute/);
  });
});

describe("tool definitions", () => {
  it("advertise exactly the tools the server dispatches", async () => {
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    const server = new WebSearchServer();
    for (const name of names) {
      const result = await server.callTool(name, null, createLocalRequestContext());
      expect(text(result)).not.toMatch(/^Unknown tool/);
    }
    expect(names).toHaveLength(12);
  });
});
