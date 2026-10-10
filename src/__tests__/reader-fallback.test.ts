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

function createFetcher(readerFallbackUrl?: string) {
  const cache = new SemanticCache({ getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true }, new InMemoryVectorStore());
  const failingBrowser = async () => { throw new Error("browser unavailable"); };
  return new ContentFetcher({
    cache,
    getBrowserContext: failingBrowser as unknown as () => Promise<BrowserContext>,
    fetchWaitUntil: "domcontentloaded",
    ...(readerFallbackUrl ? { readerFallbackUrl } : {}),
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

  it("is off unless configured", async () => {
    const fetchMock = vi.fn(async () => new Response("blocked", { status: 403, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createFetcher().fetchContent("https://example.com/about")).rejects.toThrow("browser unavailable");
    expect(fetchMock.mock.calls.every(([input]) => !String(input).includes("markdown.new"))).toBe(true);
  });
});
