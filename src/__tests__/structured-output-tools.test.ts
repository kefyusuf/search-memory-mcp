import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebSearchServer } from "../index.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";

type Internals = { cache: SemanticCache; embeddingProvider: { getEmbedding(text: string): Promise<number[]> } };

// The SDK client rejects a call when a tool with outputSchema returns no
// structuredContent or content that does not match the schema.
async function connect() {
  const server = new WebSearchServer();
  server.overrideSearchProvidersForTesting([{
    name: "mock",
    execute: async () => [
      { title: "First", url: "https://a.example/1", snippet: "first result", source: "mock" },
      { title: "Second", url: "https://b.example/2", snippet: "second result", source: "mock" },
    ],
  }]);
  // Keep model downloads out of the test: CI has network access, so the real
  // embedding provider would start downloading and exceed the test timeout.
  const internals = server as unknown as Internals;
  internals.cache.close();
  internals.cache = new SemanticCache({ getEmbedding: async () => [], isAvailable: () => false }, new InMemoryVectorStore());
  vi.spyOn(internals.embeddingProvider, "getEmbedding").mockResolvedValue([]);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "structured-output-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("structured tool output", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it("advertises object output schemas for search, index search and status", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const withSchema = tools.filter((tool) => tool.outputSchema).map((tool) => tool.name).sort();
    expect(withSchema).toEqual(["search_index", "server_status", "web_search"]);
    for (const tool of tools.filter((entry) => entry.outputSchema)) {
      expect(tool.outputSchema?.type).toBe("object");
    }
  });

  it("returns schema-valid web_search results in both text and json formats", async () => {
    const client = await connect();
    for (const format of ["text", "json"] as const) {
      const result = await client.callTool({ name: "web_search", arguments: { query: `example ${format}`, format } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        query: `example ${format}`,
        resultCount: 2,
        results: [{ url: "https://a.example/1" }, { url: "https://b.example/2" }],
      });
    }
  });

  it("keeps the existing text content for clients that ignore structured output", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "web_search", arguments: { query: "example" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("https://a.example/1");
    expect(() => JSON.parse(content[0].text)).toThrow();
  });

  it("returns schema-valid index hits, including an empty result", async () => {
    const client = await connect();
    const empty = await client.callTool({ name: "search_index", arguments: { query: "nothing" } });
    expect(empty.structuredContent).toEqual({ query: "nothing", hitCount: 0, hits: [] });

    await client.callTool({ name: "ingest_document", arguments: { content: "PgBouncer pools Postgres connections.", title: "Pooling", source: "notes.md" } });
    const hit = await client.callTool({ name: "search_index", arguments: { query: "PgBouncer" } });
    expect(hit.structuredContent).toMatchObject({ query: "PgBouncer", hitCount: 1, hits: [{ title: "Pooling", source: "notes.md" }] });
  });

  it("returns the server status as structured content", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "server_status", arguments: {} });
    const content = result.content as Array<{ text: string }>;
    expect(result.structuredContent).toEqual(JSON.parse(content[0].text));
    expect(result.structuredContent).toMatchObject({ config: { searchProviders: ["mock"] } });
  });

  it("does not attach structured content to errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "web_search", arguments: { query: "example", domain: "nomatch.example" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
  });
});
