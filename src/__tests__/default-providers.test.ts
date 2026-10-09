import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import { createLocalRequestContext } from "../runtime/request-context.js";

async function configuredProviders(): Promise<string[]> {
  vi.stubEnv("CACHE_DB_PATH", ":memory:");
  const result = await new WebSearchServer().callTool("server_status", {}, createLocalRequestContext());
  return (result.structuredContent as { config: { searchProviders: string[] } }).config.searchProviders;
}

describe("default search providers", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("uses duckduckgo and bing without configuration", async () => {
    vi.stubEnv("SEARCH_PROVIDERS", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    expect(await configuredProviders()).toEqual(["duckduckgo", "bing"]);
  });

  it("puts the Brave Search API first when a key is set", async () => {
    vi.stubEnv("SEARCH_PROVIDERS", "");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "key");
    expect(await configuredProviders()).toEqual(["brave", "duckduckgo", "bing"]);
  });

  it("keeps an explicit SEARCH_PROVIDERS order", async () => {
    vi.stubEnv("SEARCH_PROVIDERS", "duckduckgo");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "key");
    expect(await configuredProviders()).toEqual(["duckduckgo"]);
  });
});
