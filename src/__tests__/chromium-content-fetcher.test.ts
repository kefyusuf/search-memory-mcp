import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";

const URL = "https://example.com/rendered";
const HTML = `<html><head><title>Bounded</title></head><body><article><p>${"bounded content ".repeat(75)}</p></article></body></html>`;

function setup(readChunks: Array<{ data: string; base64Encoded?: boolean; eof: boolean } | Error>,
  maxHtmlBytes: number, readerFallbackUrl?: string,
  waitUntil: "domcontentloaded" | "networkidle" = "domcontentloaded") {
  const events = new EventEmitter();
  const cache = new SemanticCache(
    { getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true },
    new InMemoryVectorStore(),
  );
  let reads = 0;
  const send = vi.fn(async (method: string): Promise<any> => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "top" } } };
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "s" };
    if (method === "IO.read") {
      const result = readChunks[reads++];
      if (!result) throw new Error("Unexpected read");
      if (result instanceof Error) throw result;
      return result;
    }
    return {};
  });
  const session = Object.assign(events, { send, detach: vi.fn(async () => {}) });
  const page = {
    route: vi.fn(async () => {}),
    goto: vi.fn(async () => {
      events.emit("Fetch.requestPaused", {
        requestId: "top-doc", frameId: "top", resourceType: "Document",
        responseStatusCode: 200,
        responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
      });
      // Navigation resolution and a CDP callback can race; fetcher must drain
      // its tracked response task before extracting or using reader fallback.
      return { status: () => 200 };
    }),
    close: vi.fn(async () => {}),
  };
  const context = {
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => session),
  } as unknown as BrowserContext;
  const fetcher = new ContentFetcher({
    cache,
    getBrowserContext: async () => context,
    fetchWaitUntil: waitUntil,
    forcePlaywright: () => true,
    maxHtmlBytes,
    ...(readerFallbackUrl ? { readerFallbackUrl } : {}),
  });
  return { page, session, send, cache, fetcher, context };
}

describe("ContentFetcher Chromium CDP integration (offline)", () => {
  beforeEach(() => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("extracts a small main-frame HTML response from CDP without Response.body()", async () => {
    const f = setup([{ data: Buffer.from(HTML).toString("base64"), base64Encoded: true, eof: true }],
      Buffer.byteLength(HTML));
    const result = await f.fetcher.fetchContent(URL, true);
    expect(result).toMatchObject({ kind: "content", source: "playwright" });
    if (result.kind === "content") expect(result.text).toContain("# Bounded");
    expect(f.send.mock.calls.some(([method]) => method === "Fetch.fulfillRequest")).toBe(true);
    expect(f.session.detach).toHaveBeenCalledOnce();
    expect(f.page.close).toHaveBeenCalledOnce();
    f.fetcher.close(); f.cache.close();
  });

  it("terminates over-budget HTML without invoking the opt-in reader or writing cache", async () => {
    const f = setup([
      { data: "a".repeat(200), eof: false },
      { data: "b".repeat(200), eof: true },
    ], 256, "https://markdown.new/");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const persist = vi.spyOn(f.cache, "setCachedContent");
    await expect(f.fetcher.fetchContent(URL, true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(network).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(f.send.mock.calls.some(([method]) => method === "Fetch.failRequest")).toBe(true);
    expect(f.send.mock.calls.some(([method]) => method === "Fetch.fulfillRequest")).toBe(false);
    expect(f.session.detach).toHaveBeenCalledOnce();
    expect(f.page.close).toHaveBeenCalledOnce();
    f.fetcher.close(); f.cache.close();
  });

  it("does not reuse an earlier captured HTML body after a networkidle timeout and retry", async () => {
    const f = setup([{ data: Buffer.from(HTML).toString("base64"), base64Encoded: true, eof: true }],
      Buffer.byteLength(HTML), "https://markdown.new/", "networkidle");
    const firstNavigation = f.page.goto.getMockImplementation()!;
    f.page.goto.mockImplementationOnce(async () => {
      await firstNavigation(); // First main frame was captured successfully.
      const error = new Error("networkidle timeout");
      error.name = "TimeoutError";
      throw error;
    }).mockImplementationOnce(async () => ({ status: () => 200 })); // No second Document!
    const reader = vi.spyOn(f.fetcher as never, "fetchViaReader" as never);
    const persist = vi.spyOn(f.cache, "setCachedContent");

    await expect(f.fetcher.fetchContent(URL, true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(f.page.goto).toHaveBeenCalledTimes(2);
    expect(reader).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    f.fetcher.close(); f.cache.close();
  });

  it("fails closed when the page's CDP session cannot be created, without reader fallback", async () => {
    const f = setup([], 2048, "https://markdown.new/");
    vi.spyOn(f.context, "newCDPSession").mockRejectedValue(new Error("CDP unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const reader = vi.spyOn(f.fetcher as never, "fetchViaReader" as never);
    const persist = vi.spyOn(f.cache, "setCachedContent");

    await expect(f.fetcher.fetchContent(URL, true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(f.context.newCDPSession).toHaveBeenCalledOnce();
    expect(f.page.goto).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(f.page.close).toHaveBeenCalledOnce();

    f.fetcher.close(); f.cache.close();
  });

  it("preserves interception_failed after a rejected CDP read, without reader fallback", async () => {
    const f = setup([new Error("IO.read failed")], 2048, "https://markdown.new/");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    const persist = vi.spyOn(f.cache, "setCachedContent");
    await expect(f.fetcher.fetchContent(URL, true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(network).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(f.session.detach).toHaveBeenCalledOnce();
    f.fetcher.close(); f.cache.close();
  });
});
