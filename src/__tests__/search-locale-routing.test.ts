import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import type { SearchProvider } from "../providers/base.js";

describe("search locale routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("infers Turkish market when cross-lingual detection is disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("ENABLE_CROSSLINGUAL", "false");

    const searchProvider: SearchProvider = {
      name: "mock",
      execute: vi.fn(async () => [
        {
          title: "Laravel Queue Rehberi",
          url: "https://example.com/laravel-queue",
          snippet: "Laravel queue retry ve worker yapılandırması.",
          source: "mock",
        },
      ]),
    };

    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([searchProvider]);

    const cache = (
      server as unknown as {
        cache: {
          get: (query: string) => Promise<unknown>;
          set: (...args: unknown[]) => Promise<void>;
          reRankResults: (query: string, results: unknown[], limit: number) => Promise<unknown[]>;
        };
      }
    ).cache;
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "set").mockResolvedValue();
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query, results, limit) => results.slice(0, limit));

    await callPrivate(server, "handleSearch", [
      {
        query: "Laravel için en iyi queue yapısı",
        strategy: "fallback",
      },
    ]);

    expect(searchProvider.execute).toHaveBeenCalledWith(
      "Laravel için en iyi queue yapısı",
      expect.objectContaining({
        market: "tr-TR",
        acceptLanguage: expect.stringContaining("tr-TR"),
      }),
    );
  });
});

async function callPrivate<T>(target: unknown, method: string, args: unknown[] = []): Promise<T> {
  const callable = (target as Record<string, (...params: unknown[]) => Promise<T>>)[method];
  return callable.apply(target, args);
}
