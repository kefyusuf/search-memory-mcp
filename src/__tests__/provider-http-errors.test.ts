import { afterEach, describe, expect, it, vi } from "vitest";
import { searchBing } from "../providers/bing.js";
import { searchBrave } from "../providers/brave.js";
import { searchDDG } from "../providers/duckduckgo.js";
import { searchGoogle } from "../providers/google.js";
import { searchSearXng } from "../providers/searxng.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeProviderSearch, type ProviderAttempt } from "../search/executor.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };
const scrapers = { duckduckgo: searchDDG, bing: searchBing, brave: searchBrave, google: searchGoogle, searxng: searchSearXng };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe.each(Object.entries(scrapers))("%s provider", (name, search) => {
  it.each([403, 429, 503])("rejects with the HTTP status %d so blocking is not reported as empty", async (status) => {
    vi.stubEnv("SEARXNG_BASE_URL", "https://searxng.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status })));
    await expect(search("q", locale)).rejects.toThrow(`HTTP ${status}`);
  });

  it("still returns no results for a successful page without hits", async () => {
    vi.stubEnv("SEARXNG_BASE_URL", "https://searxng.example.com");
    const body = name === "searxng" ? JSON.stringify({ results: [] }) : "<html><body>No results</body></html>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    await expect(search("q", locale)).resolves.toEqual([]);
  });
});

it("reports a blocked provider as an error attempt", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("blocked", { status: 429 })));
  const attempts: ProviderAttempt[] = [];
  await executeProviderSearch({
    providers: [{ name: "bing", execute: searchBing }],
    query: "q", locale, strategy: "fallback", healthTracker: new ProviderHealthTracker(),
    onAttempt: (attempt) => attempts.push(attempt),
  });
  expect(attempts).toEqual([expect.objectContaining({ provider: "bing", status: "error", error: "bing returned HTTP 429" })]);
});
