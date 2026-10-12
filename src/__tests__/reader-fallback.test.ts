import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";

const READER_BODY = [
  "Title: Node.js — About Node.js®",
  "",
  "URL Source: https://example.com/about",
  "",
  "Markdown Content:",
  "About Node.js",
  "",
  "Node.js is a free, open-source, cross-platform JavaScript runtime environment that lets developers create servers, web apps, command line tools and scripts.",
].join("\n");

function createFetcher(readerFallbackUrl?: string, maxTextBytes?: number) {
  const cache = new SemanticCache({ getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true }, new InMemoryVectorStore());
  const failingBrowser = async () => { throw new Error("browser unavailable"); };
  return new ContentFetcher({
    cache,
    getBrowserContext: failingBrowser as unknown as () => Promise<BrowserContext>,
    fetchWaitUntil: "domcontentloaded",
    ...(readerFallbackUrl ? { readerFallbackUrl } : {}),
    ...(maxTextBytes !== undefined ? { maxTextBytes } : {}),
  });
}

describe("reader fallback", () => {
  beforeEach(() => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("asks the configured reader when direct fetching and the browser both fail", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      requested.push(String(input));
      return String(input).startsWith("https://markdown.new/")
        ? new Response(READER_BODY, { headers: { "content-type": "text/plain" } })
        : new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    const result = await createFetcher("https://markdown.new/").fetchContent("https://example.com/about");

    expect(requested).toContain("https://markdown.new/https://example.com/about");
    expect(result).toMatchObject({ kind: "content", source: "reader" });
    expect(result.kind === "content" && result.text).toMatch(/^# Node\.js — About Node\.js®\n\nAbout Node\.js\n\nNode\.js is a free/);
  });

  it("accepts a reader response exactly at the decoded-byte limit", async () => {
    const bytes = new TextEncoder().encode(READER_BODY).byteLength;
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.startsWith("https://markdown.new/")
        ? new Response(READER_BODY, {
          headers: { "content-type": "text/plain", "content-length": String(bytes) },
        })
        : new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    const result = await createFetcher("https://markdown.new/", bytes)
      .fetchContent("https://example.com/about", true);
    expect(result).toMatchObject({ kind: "content", source: "reader" });
    expect(urls.filter(url => url.startsWith("https://markdown.new/"))).toHaveLength(1);
  });

  it("cancels a declared-oversized reader response and returns fetch_failed", async () => {
    const readerResponse = new Response("small payload", {
      headers: { "content-type": "text/plain", "content-length": "999999" },
    });
    const cancelled = vi.spyOn(readerResponse.body!, "cancel");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.startsWith("https://markdown.new/")
        ? readerResponse
        : new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    await expect(createFetcher("https://markdown.new/", 256)
      .fetchContent("https://example.com/about", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(urls.filter(url => url.startsWith("https://markdown.new/"))).toHaveLength(1);
  });

  it("cancels a misleadingly small encoded reader stream after the actual byte cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(180));
        controller.enqueue(new Uint8Array(180));
      },
      cancel() { cancelled = true; },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.startsWith("https://markdown.new/")
        ? new Response(stream, {
          headers: { "content-type": "text/plain", "content-encoding": "gzip", "content-length": "24" },
        })
        : new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    await expect(createFetcher("https://markdown.new/", 256)
      .fetchContent("https://example.com/about", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toBe(true);
    expect(urls.filter(url => url.startsWith("https://markdown.new/"))).toHaveLength(1);
  });

  it("cancels an unsuccessful reader response without reading or retrying its body", async () => {
    const readerResponse = new Response("unused upstream error", {
      status: 503, headers: { "content-type": "text/plain" },
    });
    const cancel = vi.spyOn(readerResponse.body!, "cancel");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return url.startsWith("https://markdown.new/")
        ? readerResponse
        : new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    await expect(createFetcher("https://markdown.new/", 256)
      .fetchContent("https://example.com/about", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(urls.filter(url => url.startsWith("https://markdown.new/"))).toHaveLength(1);
  });

  it("does not follow a reader redirect into localhost", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith("https://markdown.new/")) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
      }
      return new Response("blocked", { status: 403, headers: { "content-type": "text/html" } });
    }));

    const result = await createFetcher("https://markdown.new/").fetchContent("https://example.com/about");
    expect(result).toMatchObject({ kind: "error", reason: "fetch_failed" });
    expect(requested.some((value) => value.includes("127.0.0.1"))).toBe(false);
  });

  it("is off unless configured", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createFetcher().fetchContent("https://example.com/about")).rejects.toThrow("browser unavailable");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("markdown.new"))).toBe(true);
  });
});
