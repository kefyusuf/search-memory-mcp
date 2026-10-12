import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import type { BrowserContext } from "playwright";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";

const PAGE_URL = "https://example.com/terminal-browser";
const READER_URL = "https://markdown.new/";
const READER_BODY = [
  "Title: Reader fallback",
  "Markdown Content:",
  "A sufficiently long readable page from the opt-in reader transport. ".repeat(3),
].join("\n");

/** Internal method stub: test routing without pretending CDP streaming is implemented. */
function setBrowserOutcome(fetcher: ContentFetcher, outcome: unknown) {
  const privateFetcher = fetcher as unknown as {
    fetchViaPlaywright: (url: string, options: unknown) => Promise<unknown>;
  };
  return vi.spyOn(privateFetcher, "fetchViaPlaywright").mockResolvedValue(outcome);
}

function createFetcher(withReader: boolean) {
  const cache = new SemanticCache(
    { getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true },
    new InMemoryVectorStore(),
  );
  const browserFactory = vi.fn(async (): Promise<BrowserContext> => {
    throw new Error("Browser must be stubbed before execution");
  });
  const fetcher = new ContentFetcher({
    cache,
    getBrowserContext: browserFactory,
    fetchWaitUntil: "domcontentloaded",
    forcePlaywright: () => true,
    ...(withReader ? { readerFallbackUrl: READER_URL } : {}),
  });
  return { fetcher, cache, browserFactory };
}

describe("P0-03C internal terminal browser routing (offline contract tests)", () => {
  beforeEach(() => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const cause of ["oversize", "interception_failed"] as const) {
    it(`returns fetch_failed without reader, second fetch or cache for terminal ${cause}`, async () => {
      const { fetcher, cache, browserFactory } = createFetcher(true);
      const fetchMock = vi.fn(async () => new Response(READER_BODY));
      vi.stubGlobal("fetch", fetchMock);
      const persist = vi.spyOn(cache, "setCachedContent").mockResolvedValue(undefined);
      const browser = setBrowserOutcome(fetcher, { kind: "terminal_browser_failure", cause });

      await expect(fetcher.fetchContent(PAGE_URL, true))
        .resolves.toEqual({ kind: "error", reason: "fetch_failed" });

      expect(browser).toHaveBeenCalledTimes(1);
      expect(browserFactory).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      fetcher.close();
      cache.close();
    });
  }

  it("does not leak the internal terminal kind when no reader is configured", async () => {
    const { fetcher, cache } = createFetcher(false);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setBrowserOutcome(fetcher, { kind: "terminal_browser_failure", cause: "interception_failed" });

    await expect(fetcher.fetchContent(PAGE_URL, true))
      .resolves.toEqual({ kind: "error", reason: "fetch_failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetcher.close();
    cache.close();
  });

  it("retains opt-in reader fallback for an ordinary navigation error", async () => {
    const { fetcher, cache } = createFetcher(true);
    setBrowserOutcome(fetcher, { kind: "error", reason: "fetch_failed" });
    const fetchMock = vi.fn(async () =>
      new Response(READER_BODY, { headers: { "content-type": "text/plain" } }));
    vi.stubGlobal("fetch", fetchMock);
    const persist = vi.spyOn(cache, "setCachedContent").mockResolvedValue(undefined);

    const result = await fetcher.fetchContent(PAGE_URL, true);
    expect(result).toMatchObject({ kind: "content", source: "reader" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    fetcher.close();
    cache.close();
  });

  it("preserves a thrown browser-initialization error when no reader is configured", async () => {
    const { fetcher, cache } = createFetcher(false);
    const privateFetcher = fetcher as unknown as {
      fetchViaPlaywright: (url: string, options: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateFetcher, "fetchViaPlaywright")
      .mockRejectedValue(new Error("browser unavailable"));

    await expect(fetcher.fetchContent(PAGE_URL, true)).rejects.toThrow("browser unavailable");
    fetcher.close();
    cache.close();
  });
});
