import { describe, expect, it, vi } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { TokenBucket } from "../rate-limiter.js";
import { executeProviderSearch, type ProviderAttempt } from "../search/executor.js";
import type { SearchLocale } from "../search-utils.js";
import { createSearchHandler, SearchTraceHistory } from "../tools/search.js";
import { InMemoryVectorStore } from "./helpers.js";

const locale: SearchLocale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };
const hit = (url: string) => ({ title: url, url, snippet: "snippet", source: "mock" });
const ok = (name: string): SearchProvider => ({ name, execute: async () => [hit(`https://${name}.example/1`)] });
const empty = (name: string): SearchProvider => ({ name, execute: async () => [] });
const failing = (name: string, message: string): SearchProvider => ({ name, execute: async () => { throw new Error(message); } });

function backedOff(name: string): ProviderHealthTracker {
  const tracker = new ProviderHealthTracker();
  for (let i = 0; i < 5; i++) tracker.record(name, false);
  return tracker;
}

describe("provider attempt reporting", () => {
  it("reports every provider tried in fallback order", async () => {
    const attempts: ProviderAttempt[] = [];
    const results = await executeProviderSearch({
      providers: [failing("bing", "HTTP 403\nCaptcha page"), empty("brave"), ok("duckduckgo"), ok("google")],
      query: "q", locale, strategy: "fallback", healthTracker: new ProviderHealthTracker(),
      onAttempt: (attempt) => attempts.push(attempt),
    });
    expect(results).toHaveLength(1);
    expect(attempts.map(({ provider, status, resultCount }) => ({ provider, status, resultCount }))).toEqual([
      { provider: "bing", status: "error", resultCount: 0 },
      { provider: "brave", status: "empty", resultCount: 0 },
      { provider: "duckduckgo", status: "ok", resultCount: 1 },
    ]);
    expect(attempts[0].error).toBe("HTTP 403 Captcha page");
    for (const attempt of attempts) expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports providers skipped during backoff and truncates long errors", async () => {
    const attempts: ProviderAttempt[] = [];
    await executeProviderSearch({
      providers: [ok("bing"), failing("brave", "x".repeat(500))],
      query: "q", locale, strategy: "aggregate", healthTracker: backedOff("bing"),
      onAttempt: (attempt) => attempts.push(attempt),
    });
    expect(attempts.find((attempt) => attempt.provider === "bing")).toMatchObject({ status: "backoff", resultCount: 0 });
    expect(attempts.find((attempt) => attempt.provider === "brave")?.error).toHaveLength(160);
  });
});

function handler(providers: SearchProvider[]) {
  const cache = new SemanticCache({ getEmbedding: async () => [1, ...new Array(383).fill(0)], isAvailable: () => true }, new InMemoryVectorStore());
  vi.spyOn(cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));
  return createSearchHandler({
    searchLimiter: new TokenBucket({ maxTokens: 100, refillRatePerSecond: 0 }),
    cache: () => cache,
    providers: () => providers,
    healthTracker: () => new ProviderHealthTracker(),
    intentDetector: { detect: async () => ({ intent: "general", source: "heuristic" }) },
    crossLingual: null,
    reranker: null,
    fetchPage: async () => null,
    traces: new SearchTraceHistory(),
  });
}

describe("web_search provider report", () => {
  it("includes attempts in structured content and notes failures in text", async () => {
    const result = await handler([failing("bing", "timeout"), ok("duckduckgo")])({ query: "example" });
    expect(result.structuredContent?.providerAttempts).toEqual([
      expect.objectContaining({ provider: "bing", status: "error", error: "timeout" }),
      expect.objectContaining({ provider: "duckduckgo", status: "ok", resultCount: 1 }),
    ]);
    expect(result.content[0].text).toMatch(/\n\nProvider notes: bing failed \(timeout\)\.$/);
  });

  it("adds no note when the first provider succeeds", async () => {
    const result = await handler([ok("duckduckgo"), ok("bing")])({ query: "example" });
    expect(result.content[0].text).not.toContain("Provider notes");
    expect(result.structuredContent?.providerAttempts).toEqual([expect.objectContaining({ provider: "duckduckgo", status: "ok" })]);
  });

  it("explains why every provider failed", async () => {
    const result = await handler([failing("bing", "HTTP 429"), empty("duckduckgo")])({ query: "example" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Web search is currently unavailable (all providers returned no results: bing failed (HTTP 429); duckduckgo returned no results). " +
      "Try using fetch_content with a direct URL instead, or retry the search later.",
    );
  });

  it("omits attempts on cache hits", async () => {
    const search = handler([ok("duckduckgo")]);
    await search({ query: "example" });
    const cached = await search({ query: "example" });
    expect(cached.structuredContent?.meta).toMatchObject({ cache: "hit" });
    expect(cached.structuredContent).not.toHaveProperty("providerAttempts");
  });
});
