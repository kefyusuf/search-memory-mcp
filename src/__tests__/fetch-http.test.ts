import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import type { IEmbeddingProvider } from "../cache/types.js";

function createMockEmbedding(): IEmbeddingProvider {
  return {
    getEmbedding: vi.fn(async () => new Array(384).fill(0.01)),
    isAvailable: vi.fn(() => true),
  };
}

function createFetcher(overrides?: {
  getBrowserContext?: () => Promise<BrowserContext>;
  forcePlaywright?: () => boolean;
  maxHtmlBytes?: number;
  maxTextBytes?: number;
  readerFallbackUrl?: string;
}) {
  const cache = new SemanticCache(createMockEmbedding(), new InMemoryVectorStore());
  const defaultContext = {
    newPage: async () => ({
      route: async () => undefined,
      goto: async () => undefined,
      close: async () => undefined,
    }),
  } as BrowserContext;

  return {
    cache,
    fetcher: new ContentFetcher({
      cache,
      getBrowserContext: overrides?.getBrowserContext ?? (async () => defaultContext),
      fetchWaitUntil: "networkidle",
      forcePlaywright: overrides?.forcePlaywright,
      maxHtmlBytes: overrides?.maxHtmlBytes,
      maxTextBytes: overrides?.maxTextBytes,
      readerFallbackUrl: overrides?.readerFallbackUrl,
    }),
  };
}

describe("ContentFetcher", () => {
  const originalForcePlaywright = process.env.FORCE_PLAYWRIGHT;

  beforeEach(() => {
    // HTTP is mocked below; DNS must also be offline while URL safety stays real.
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });

  afterEach(() => {
    if (originalForcePlaywright === undefined) {
      delete process.env.FORCE_PLAYWRIGHT;
    } else {
      process.env.FORCE_PLAYWRIGHT = originalForcePlaywright;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns fetch_failed for non-HTML responses", async () => {
    const { fetcher } = createFetcher();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/data")).resolves.toBeNull();
  });

  it("returns null for failed HTTP responses", async () => {
    const { fetcher } = createFetcher();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>failure</body></html>", {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/failure")).resolves.toBeNull();
  });

  it("returns null for very short html responses", async () => {
    const { fetcher } = createFetcher();
    const html = `<html><body>${"a".repeat(450)}</body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    await expect(fetcher.fetchPage("https://example.com/short")).resolves.toBeNull();
  });

  it("returns parsed article content for valid html responses", async () => {
    const { fetcher } = createFetcher();
    const html = `<html><head><title>Test</title></head><body><article><p>${"content ".repeat(80)}</p></article></body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await fetcher.fetchPage("https://example.com/article");

    expect(result).not.toBeNull();
    expect(result?.title).toBe("Test");
    expect(result?.content).toContain("content");
    expect(result?.fullText).toContain("# Test");
  });

  it("accepts valid HTML under the streaming byte limit", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser, maxHtmlBytes: 2048 });
    const html = `<html><head><title>Bounded</title></head><body><article><p>${"content ".repeat(80)}</p></article></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      headers: { "content-type": "text/html" },
    })));

    const result = await fetcher.fetchContent("https://example.com/bounded", true);
    expect(result).toMatchObject({ kind: "content", source: "http" });
    if (result.kind === "content") expect(result.text).toContain("# Bounded");
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects a declared-oversized HTML body before reading or browser retry", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser, maxHtmlBytes: 256 });
    const response = new Response("<html><body>untrusted</body></html>", {
      headers: { "content-type": "text/html", "content-length": "100000" },
    });
    const cancelled = vi.spyOn(response.body!, "cancel");
    const mock = vi.fn(async () => response);
    vi.stubGlobal("fetch", mock);

    await expect(fetcher.fetchContent("https://example.com/declared-over-limit", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("stops an unknown-length HTML stream at the byte limit without browser fallback", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser, maxHtmlBytes: 256 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(160));
        controller.enqueue(new Uint8Array(160));
      },
      cancel() { cancelled = true; },
    });
    const mock = vi.fn(async () => new Response(stream, {
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", mock);

    await expect(fetcher.fetchContent("https://example.com/chunked-over-limit", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toBe(true);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("accepts a valid HTML body exactly at the configured byte limit", async () => {
    const html = `<html><head><title>Exact limit</title></head><body><article><p>${"within bounds ".repeat(70)}</p></article></body></html>`;
    const bytes = new TextEncoder().encode(html).byteLength;
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ maxHtmlBytes: bytes, getBrowserContext: browser });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      headers: { "content-type": "text/html", "content-length": String(bytes) },
    })));

    const result = await fetcher.fetchContent("https://example.com/exact-limit", true);
    expect(result).toMatchObject({ kind: "content", source: "http" });
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects a falsely small Content-Length without retrying through the reader", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({
      getBrowserContext: browser,
      maxHtmlBytes: 256,
      readerFallbackUrl: "https://markdown.new/",
    });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(180));
        controller.enqueue(new Uint8Array(180));
      },
      cancel() { cancelled = true; },
    });
    const fetchMock = vi.fn(async () => new Response(stream, {
      headers: { "content-type": "text/html", "content-length": "10" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetcher.fetchContent("https://example.com/misreported-length", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("does not reject a decoded HTML body using an encoded Content-Length", async () => {
    const html = `<html><head><title>Compressed</title></head><body><article><p>${"decoded content ".repeat(60)}</p></article></body></html>`;
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ maxHtmlBytes: 2048, getBrowserContext: browser });
    // Model Node fetch: the response body is already decoded, but these
    // original wire headers may remain and describe a different byte count.
    const response = new Response(html, {
      headers: {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "content-length": "99999",
      },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const result = await fetcher.fetchContent("https://example.com/decoded-small", true);
    expect(result).toMatchObject({ kind: "content", source: "http" });
    if (result.kind === "content") expect(result.text).toContain("# Compressed");
    expect(cancel).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects an oversized decoded HTML stream despite a small encoded Content-Length", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({
      getBrowserContext: browser, maxHtmlBytes: 256, readerFallbackUrl: "https://markdown.new/",
    });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(180));
        controller.enqueue(new Uint8Array(180));
      },
      cancel() { cancelled = true; },
    });
    const network = vi.fn(async () => new Response(stream, {
      headers: {
        "content-type": "text/html",
        "content-encoding": "gzip",
        "content-length": "24",
      },
    }));
    vi.stubGlobal("fetch", network);

    await expect(fetcher.fetchContent("https://example.com/decoded-large", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("accepts GitHub Raw text exactly at its decoded byte limit", async () => {
    const markdown = "# Within budget\n\nThis document remains safely readable and contains useful text.";
    const bytes = new TextEncoder().encode(markdown).byteLength;
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser, maxTextBytes: bytes });
    const network = vi.fn(async () => new Response(markdown, {
      headers: { "content-type": "text/markdown", "content-length": String(bytes) },
    }));
    vi.stubGlobal("fetch", network);

    const result = await fetcher.fetchContent("https://raw.githubusercontent.com/o/r/main/README.md", true);
    expect(result).toMatchObject({ kind: "content", source: "github-raw" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects declared-oversized GitHub Raw text without HTTP/browser/reader fallback", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({
      getBrowserContext: browser, maxTextBytes: 256, readerFallbackUrl: "https://markdown.new/",
    });
    const response = new Response("# tiny\n\nshould never parse", {
      headers: { "content-type": "text/plain", "content-length": "100000" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const network = vi.fn(async () => response);
    vi.stubGlobal("fetch", network);

    await expect(fetcher.fetchContent("https://raw.githubusercontent.com/o/r/main/README.md", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects an oversized RSS text stream despite a misleading small length", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({
      getBrowserContext: browser, maxTextBytes: 256, readerFallbackUrl: "https://markdown.new/",
    });
    let cancelled = false;
    const network = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(160));
        controller.enqueue(new Uint8Array(160));
      },
      cancel() { cancelled = true; },
    }), {
      headers: { "content-type": "application/rss+xml", "content-length": "10" },
    }));
    vi.stubGlobal("fetch", network);

    await expect(fetcher.fetchContent("https://example.com/blog", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(cancelled).toBe(true);
    expect(network).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("stops GitHub root README candidate probing after the first oversize response", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({
      getBrowserContext: browser, maxTextBytes: 256, readerFallbackUrl: "https://markdown.new/",
    });
    const network = vi.fn(async () => new Response("# unused", {
      headers: { "content-type": "text/markdown", "content-length": "999999" },
    }));
    vi.stubGlobal("fetch", network);

    await expect(fetcher.fetchContent("https://github.com/owner/repo", true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]?.[0])).toContain("raw.githubusercontent.com/owner/repo/main/README");
    expect(browser).not.toHaveBeenCalled();
  });

  it("cancels a GitHub Raw redirect body before requesting the redirected document", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser });
    const redirect = new Response("unused redirect body", {
      status: 302, headers: { location: "https://raw.githubusercontent.com/owner/repo/main/OTHER.md" },
    });
    const cancel = vi.spyOn(redirect.body!, "cancel");
    const markdown = "# Redirect target\n\nUseful content after the redirected response.";
    const network = vi.fn(async () => network.mock.calls.length === 1
      ? redirect
      : new Response(markdown, { headers: { "content-type": "text/markdown" } }));
    vi.stubGlobal("fetch", network);

    const result = await fetcher.fetchContent("https://raw.githubusercontent.com/owner/repo/main/README.md", true);
    expect(result).toMatchObject({ kind: "content", source: "github-raw" });
    expect(network).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(browser).not.toHaveBeenCalled();
  });

  it("fetches GitHub blob URLs through raw Markdown before browser fallback", async () => {
    const { fetcher } = createFetcher({
      getBrowserContext: async () => {
        throw new Error("Playwright should not be used for GitHub raw content");
      },
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://raw.githubusercontent.com/owner/repo/main/README.md");
      return new Response("# Project Title\n\nThis package provides local web search tools.", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetcher.fetchContent("https://github.com/owner/repo/blob/main/README.md", true);

    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.source).toBe("github-raw");
      expect(result.text).toContain("# Project Title");
      expect(result.text).toContain("local web search tools");
    }
  });

  it("fetches RSS feeds as Markdown lists before browser fallback", async () => {
    const { fetcher } = createFetcher({
      getBrowserContext: async () => {
        throw new Error("Playwright should not be used for RSS content");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <rss>
        <channel>
          <title>Example Feed</title>
          <item>
            <title>First Post</title>
            <link>https://example.com/first</link>
            <description>First post summary.</description>
          </item>
        </channel>
      </rss>
    `, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    })));

    const result = await fetcher.fetchContent("https://example.com/blog", true);

    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.source).toBe("rss");
      expect(result.text).toContain("# Example Feed");
      expect(result.text).toContain("1. First Post");
      expect(result.text).toContain("https://example.com/first");
    }
  });

  it("treats FORCE_PLAYWRIGHT=false as HTTP-first mode", async () => {
    process.env.FORCE_PLAYWRIGHT = "false";
    const { fetcher } = createFetcher({
      getBrowserContext: async () => {
        throw new Error("Playwright should not be used");
      },
    });
    const html = `<html><head><title>HTTP</title></head><body><article><p>${"content ".repeat(80)}</p></article></body></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await fetcher.fetchContent("https://example.com/http");

    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.source).toBe("http");
      expect(result.text).toContain("# HTTP");
    }
  });

  it("does not fall back to the browser after a guarded socket denies a private peer", async () => {
    const browser = vi.fn(async () => { throw new Error("browser must not be used"); });
    const { fetcher } = createFetcher({ getBrowserContext: browser });
    const denial = Object.assign(new Error("Blocked non-public outbound address"), { code: "EACCES" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: denial });
    }));

    await expect(fetcher.fetchContent("https://example.com/guarded", true)).resolves.toEqual({
      kind: "error", reason: "blocked_url",
    });
    expect(browser).not.toHaveBeenCalled();
  });

  it("blocks HTTP redirects to private network targets", async () => {
    const { fetcher } = createFetcher({
      getBrowserContext: async () => {
        throw new Error("Playwright should not be used after a blocked redirect");
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      })
    ));

    const result = await fetcher.fetchContent("https://example.com/redirect", true);

    expect(result).toEqual({
      kind: "error",
      reason: "blocked_url",
    });
  });

  it("prefers content cache when force_refresh is false", async () => {
    const { cache, fetcher } = createFetcher();
    await cache.setCachedContent("https://example.com/cached", "# Cached\n\nBody", "Cached");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetcher.fetchContent("https://example.com/cached", false);

    expect(result).toEqual({
      kind: "content",
      text: "# Cached\n\nBody",
      source: "content-cache",
      fetchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to Playwright when HTTP fetch cannot produce an article", async () => {
    const page = {
      route: vi.fn().mockResolvedValue(undefined),
      goto: vi.fn().mockResolvedValue({
        body: async () => Buffer.from(`<html><head><title>Rendered</title></head><body><article><p>${"rendered ".repeat(80)}</p></article></body></html>`),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browserContext = {
      newPage: vi.fn().mockResolvedValue(page),
    } as unknown as BrowserContext;
    const { fetcher } = createFetcher({
      getBrowserContext: async () => browserContext,
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("<html><body>tiny</body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      })
    ));

    const result = await fetcher.fetchContent("https://example.com/rendered");

    expect(result.kind).toBe("content");
    if (result.kind === "content") {
      expect(result.source).toBe("playwright");
      expect(result.text).toContain("# Rendered");
    }
    expect(page.goto).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
  });
});
