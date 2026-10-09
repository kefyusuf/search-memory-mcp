import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeSearchPlan } from "../search/executor.js";
import type { SearchPlan } from "../search/planner.js";
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

function plan(overrides: Partial<SearchPlan> = {}): SearchPlan {
  return {
    intent: "technical",
    strategy: "aggregate",
    primaryProviderNames: ["brave", "google"],
    fallbackProviderNames: ["bing", "duckduckgo"],
    profileVersion: "v1",
    ...overrides,
  };
}

describe("planned search execution", () => {
  it("does not call secondary providers when any aggregate primary succeeds", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);
    const google = provider("google", []);
    const bing = provider("bing", ["https://example.com/bing"]);

    const results = await executeSearchPlan({
      providers: [brave, google, bing],
      query: "postgres pooling",
      locale,
      plan: plan(),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/brave"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).not.toHaveBeenCalled();
  });

  it("falls back in planned order when all aggregate primaries fail", async () => {
    const brave = provider("brave", []);
    const google = provider("google", []);
    const bing = provider("bing", []);
    const duckduckgo = provider("duckduckgo", ["https://example.com/ddg"]);

    const results = await executeSearchPlan({
      providers: [duckduckgo, bing, brave, google],
      query: "postgres pooling",
      locale,
      plan: plan(),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/ddg"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).toHaveBeenCalledTimes(1);
    expect(duckduckgo.execute).toHaveBeenCalledTimes(1);
  });

  it("continues through secondary providers when site filtering rejects earlier results", async () => {
    const brave = provider("brave", ["https://example.com/brave"]);
    const google = provider("google", ["https://example.org/google"]);
    const bing = provider("bing", ["https://example.net/bing"]);
    const duckduckgo = provider("duckduckgo", ["https://react.dev/reference"]);

    const results = await executeSearchPlan({
      providers: [duckduckgo, bing, brave, google],
      query: "react reference site:react.dev",
      locale,
      plan: plan(),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://react.dev/reference"]);
    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).toHaveBeenCalledTimes(1);
    expect(duckduckgo.execute).toHaveBeenCalledTimes(1);
  });

  it("uses plan order for fallback plans and stops after first success", async () => {
    const google = provider("google", []);
    const bing = provider("bing", ["https://example.com/bing"]);
    const duckduckgo = provider("duckduckgo", ["https://example.com/ddg"]);

    const results = await executeSearchPlan({
      providers: [duckduckgo, bing, google],
      query: "postgres docs",
      locale,
      plan: plan({
        intent: "navigational",
        strategy: "fallback",
        primaryProviderNames: ["google", "bing", "duckduckgo"],
        fallbackProviderNames: [],
      }),
      healthTracker: new ProviderHealthTracker(),
    });

    expect(results.map((result) => result.url)).toEqual(["https://example.com/bing"]);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).toHaveBeenCalledTimes(1);
    expect(duckduckgo.execute).not.toHaveBeenCalled();
  });
});

describe("WebSearchServer auto routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("classifies the original query, routes primary providers, and uses plan-aware cache", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("ENABLE_CROSSLINGUAL", "false");

    const duckduckgo = provider("duckduckgo", ["https://react.dev/ddg"]);
    const bing = provider("bing", ["https://react.dev/bing"]);
    const brave = provider("brave", ["https://react.dev/brave"]);
    const google = provider("google", ["https://react.dev/google"]);
    const detector = {
      detect: vi.fn(async () => ({ intent: "technical" as const, source: "classifier" as const })),
    };

    const server = new WebSearchServer(detector);
    server.overrideSearchProvidersForTesting([duckduckgo, bing, brave, google]);

    const cache = (server as unknown as { cache: {
      get: (...args: unknown[]) => Promise<unknown>;
      set: (...args: unknown[]) => Promise<void>;
      reRankResults: (query: string, results: unknown[], limit: number) => Promise<unknown[]>;
    } }).cache;
    const cacheGet = vi.spyOn(cache, "get").mockResolvedValue(null);
    const cacheSet = vi.spyOn(cache, "set").mockResolvedValue(undefined as never);
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));

    const response = await callPrivate<{ content: Array<{ text: string }> }>(server, "handleSearch", [{
      query: "react server components",
      domain: "react.dev",
      strategy: "auto",
      max_results: 5,
    }]);

    expect(response.content[0].text).toContain("react.dev");
    expect(detector.detect).toHaveBeenCalledWith("react server components");

    // Cache is now plan-aware: lookups/stores are namespaced by intent + profile + providers.
    expect(cacheGet).toHaveBeenCalledWith(
      "react server components domain:react.dev",
      expect.stringContaining("auto:v1:technical:"),
    );
    expect(cacheSet).toHaveBeenCalledWith(
      "react server components domain:react.dev",
      expect.any(Array),
      expect.stringContaining("auto:v1:technical:"),
      { ttlMs: 24 * 60 * 60 * 1000 },
    );

    expect(brave.execute).toHaveBeenCalledWith("react server components site:react.dev", expect.any(Object));
    expect(google.execute).toHaveBeenCalledWith("react server components site:react.dev", expect.any(Object));
    expect(duckduckgo.execute).not.toHaveBeenCalled();
    expect(bing.execute).not.toHaveBeenCalled();
  });

  it("bypasses intent detection for explicit fallback", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");

    const bing = provider("bing", ["https://example.com/bing"]);
    const detector = {
      detect: vi.fn(async () => ({ intent: "news" as const, source: "classifier" as const })),
    };
    const server = new WebSearchServer(detector);
    server.overrideSearchProvidersForTesting([bing]);

    const cache = (server as unknown as { cache: {
      get: (query: string) => Promise<unknown>;
      set: (...args: unknown[]) => Promise<void>;
      reRankResults: (query: string, results: unknown[], limit: number) => Promise<unknown[]>;
    } }).cache;
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "set").mockResolvedValue();
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));

    await callPrivate(server, "handleSearch", [{ query: "plain query", strategy: "fallback" }]);

    expect(detector.detect).not.toHaveBeenCalled();
    expect(bing.execute).toHaveBeenCalledTimes(1);
  });
});

async function callPrivate<T>(target: unknown, method: string, args: unknown[] = []): Promise<T> {
  const callable = (target as Record<string, (...params: unknown[]) => Promise<T>>)[method];
  return callable.apply(target, args);
}
