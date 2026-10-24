import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeProviderSearch } from "../search/executor.js";
import { fuseSearchResults, normalizeSearchUrl } from "../search/fusion.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = {
  acceptLanguage: "en-US,en;q=0.9",
  market: "en-US",
};

function provider(name: string, urls: string[]): SearchProvider {
  return {
    name,
    execute: vi.fn(async () => urls.map((url, index) => ({
      title: `${name} result ${index + 1}`,
      url,
      snippet: `${name} snippet ${index + 1}`,
      source: name,
    }))),
  };
}

describe("federated search", () => {
  it("keeps the first provider-reported publishedAt when fusing duplicate URLs", () => {
    const fused = fuseSearchResults([
      {
        provider: "tavily",
        results: [{ title: "Guide", url: "https://example.com/guide", snippet: "s", source: "tavily", publishedAt: "2026-10-01" }],
      },
      {
        provider: "bing",
        results: [{ title: "Guide", url: "https://example.com/guide", snippet: "s", source: "bing" }],
      },
    ]);

    expect(fused).toHaveLength(1);
    expect(fused[0].publishedAt).toBe("2026-10-01");
    expect(fused[0].sources).toEqual(["tavily", "bing"]);
  });

  it("normalizes tracking parameters, fragments, www, and trailing slashes for deduplication", () => {
    expect(normalizeSearchUrl("https://www.Example.com/docs/?utm_source=test&b=2&a=1#intro"))
      .toBe("https://example.com/docs?a=1&b=2");
  });

  it("preserves SPA route fragments while dropping ordinary document anchors", () => {
    expect(normalizeSearchUrl("https://example.com/#/article-a"))
      .toBe("https://example.com/#/article-a");
    expect(normalizeSearchUrl("https://example.com/#!/article-b"))
      .toBe("https://example.com/#!/article-b");
    expect(normalizeSearchUrl("https://example.com/docs#intro"))
      .toBe("https://example.com/docs");
  });

  it("preserves repeated query-parameter value order while sorting distinct keys", () => {
    expect(normalizeSearchUrl("https://example.com/search?b=2&id=primary&id=fallback&a=1"))
      .toBe("https://example.com/search?a=1&b=2&id=primary&id=fallback");
    expect(normalizeSearchUrl("https://example.com/search?b=2&id=fallback&id=primary&a=1"))
      .toBe("https://example.com/search?a=1&b=2&id=fallback&id=primary");
  });

  it("fuses duplicate URLs across providers, preserves the representative URL, and records provider ranks", () => {
    const fused = fuseSearchResults([
      {
        provider: "brave",
        results: [
          { title: "Brave A", url: "https://example.com/a?utm_source=brave", snippet: "A", source: "brave" },
          { title: "Brave B", url: "https://example.com/b", snippet: "B", source: "brave" },
        ],
      },
      {
        provider: "google",
        results: [
          { title: "Google A", url: "https://www.example.com/a#section", snippet: "A2", source: "google" },
          { title: "Google C", url: "https://example.com/c", snippet: "C", source: "google" },
        ],
      },
    ]);

    expect(fused).toHaveLength(3);
    expect(fused[0]).toMatchObject({
      url: "https://example.com/a?utm_source=brave",
      sources: ["brave", "google"],
      providerRanks: { brave: 1, google: 1 },
    });
    expect(fused[0].fusionScore).toBeGreaterThan(fused[1].fusionScore ?? 0);
  });

  it("keeps fallback behavior by stopping after the first successful provider", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);
    const google = provider("google", ["https://example.com/google"]);

    const results = await executeProviderSearch({
      providers: [brave, google],
      query: "postgres pooling",
      locale,
      strategy: "fallback",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/brave"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).not.toHaveBeenCalled();
  });

  it("aggregates successful providers and ranks consensus URLs first", async () => {
    const brave = provider("brave", [
      "https://example.com/shared?utm_source=brave",
      "https://example.com/brave-only",
    ]);
    const google = provider("google", [
      "https://www.example.com/shared#top",
      "https://example.com/google-only",
    ]);

    const results = await executeProviderSearch({
      providers: [brave, google],
      query: "postgres pooling",
      locale,
      strategy: "aggregate",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      url: "https://example.com/shared?utm_source=brave",
      sources: ["brave", "google"],
      providerRanks: { brave: 1, google: 1 },
    });
  });

  it("executes each provider name only once in aggregate mode", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);

    const results = await executeProviderSearch({
      providers: [brave, brave],
      query: "postgres pooling",
      locale,
      strategy: "aggregate",
      healthTracker: new ProviderHealthTracker(),
    });

    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0].sources).toEqual(["brave"]);
    expect(results[0].fusionScore).toBeCloseTo(1 / 61);
  });
});
