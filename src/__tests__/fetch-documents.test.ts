import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import { docx, epub, pdf } from "./document-fixtures.js";
import { WebSearchServer } from "../index.js";
import { createLocalRequestContext } from "../runtime/request-context.js";

const PDF_TYPE = "application/pdf";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function createFetcher(options: { maxDocumentBytes?: number } = {}) {
  const cache = new SemanticCache({ getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true }, new InMemoryVectorStore());
  const newPage = vi.fn(async () => { throw new Error("browser should not be used for documents"); });
  const fetcher = new ContentFetcher({
    cache,
    getBrowserContext: async () => ({ newPage } as unknown as BrowserContext),
    fetchWaitUntil: "networkidle",
    ...options,
  });
  return { fetcher, newPage };
}

function respond(body: Uint8Array, contentType: string, headers: Record<string, string> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": contentType, ...headers } })));
}

describe("ContentFetcher documents", () => {
  beforeEach(() => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("extracts a PDF response without opening a browser", async () => {
    const { fetcher, newPage } = createFetcher();
    respond(pdf("Kubernetes uses PgBouncer"), PDF_TYPE);
    const result = await fetcher.fetchContent("https://example.com/paper");
    expect(result).toMatchObject({ kind: "content", source: "http" });
    expect(result.kind === "content" && result.text).toMatch(/^# Sample PDF\n\n[\s\S]*Kubernetes uses PgBouncer/);
    expect(newPage).not.toHaveBeenCalled();
  });

  it("sniffs a DOCX served as octet-stream and names it from the URL when untitled", async () => {
    const { fetcher } = createFetcher();
    respond(docx(["Pooling paragraph."]), "application/octet-stream");
    const result = await fetcher.fetchContent("https://example.com/files/pooling-notes.docx");
    expect(result.kind === "content" && result.text).toBe("# pooling-notes.docx\n\nPooling paragraph.");
  });

  it("keeps a malformed percent-escape in the document filename", async () => {
    const { fetcher } = createFetcher();
    respond(docx(["Escaped paragraph."]), "application/octet-stream");
    const result = await fetcher.fetchContent("https://example.com/files/100%25-%E0%A4%A.docx");
    expect(result.kind === "content" && result.text).toBe("# 100%25-%E0%A4%A.docx\n\nEscaped paragraph.");
  });

  it("extracts EPUB responses", async () => {
    const { fetcher } = createFetcher();
    respond(epub([{ id: "ch1", html: "<p>Chapter text.</p>" }], "Book"), "application/epub+zip");
    const result = await fetcher.fetchContent("https://example.com/book");
    expect(result.kind === "content" && result.text).toBe("# Book\n\nChapter text.");
  });

  it("rejects documents above the size limit", async () => {
    const { fetcher, newPage } = createFetcher({ maxDocumentBytes: 100 });
    respond(pdf("too big for the limit"), PDF_TYPE);
    await expect(fetcher.fetchContent("https://example.com/big.pdf")).resolves.toEqual({ kind: "error", reason: "fetch_failed" });

    respond(new Uint8Array(10), PDF_TYPE, { "content-length": "5000" });
    await expect(fetcher.fetchContent("https://example.com/declared-big.pdf")).resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(newPage).not.toHaveBeenCalled();
  });

  it("fails without a browser fallback when a document cannot be parsed", async () => {
    const { fetcher, newPage } = createFetcher();
    respond(new TextEncoder().encode("%PDF-1.4 broken"), PDF_TYPE);
    await expect(fetcher.fetchContent("https://example.com/broken.pdf")).resolves.toEqual({ kind: "error", reason: "parse_failed" });
    expect(newPage).not.toHaveBeenCalled();
  });

  it("caches extracted document text", async () => {
    const { fetcher } = createFetcher();
    respond(docx(["Cached once."], "Cache test"), DOCX_TYPE);
    await fetcher.fetchContent("https://example.com/cache.docx");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should use cache"); }));
    const cached = await fetcher.fetchContent("https://example.com/cache.docx");
    expect(cached).toEqual({ kind: "content", source: "content-cache", text: "# Cache test\n\nCached once.", fetchedAt: expect.any(String) });
  });

  it("lets index_url add a PDF to the knowledge base", async () => {
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("NODE_ENV", "test");
    const server = new WebSearchServer();
    // Keep model downloads out of the test.
    const internals = server as unknown as { embeddingProvider: { getEmbedding(text: string): Promise<number[]> } };
    vi.spyOn(internals.embeddingProvider, "getEmbedding").mockResolvedValue([]);
    respond(pdf("PgBouncer pools Postgres connections"), PDF_TYPE);

    const indexed = await server.callTool("index_url", { url: "https://example.com/pooling.pdf" }, createLocalRequestContext());
    expect(indexed.isError).toBeUndefined();
    expect(indexed.content[0].text).toMatch(/^Indexed https:\/\/example\.com\/pooling\.pdf\n/);

    const found = await server.callTool("search_index", { query: "PgBouncer", format: "json" }, createLocalRequestContext());
    expect(JSON.parse(found.content[0].text).hits[0]).toMatchObject({ source: "https://example.com/pooling.pdf" });
    vi.unstubAllEnvs();
  });
});
