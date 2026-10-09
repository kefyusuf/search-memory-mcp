import { afterEach, describe, expect, it, vi } from "vitest";
import { searchBrave } from "../providers/brave.js";

const locale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("searchBrave with BRAVE_SEARCH_API_KEY", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRAVE_SEARCH_API_KEY;
  });

  it("uses the Brave Search API instead of scraping and maps web results", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-key";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
      expect(url.searchParams.get("q")).toBe("postgres pooling");
      expect(new Headers(init?.headers).get("x-subscription-token")).toBe("test-key");
      return jsonResponse({
        web: {
          results: [
            { title: "Pooling <strong>guide</strong>", url: "https://example.com/pool", description: "PgBouncer <strong>basics</strong>" },
            { title: "No URL" },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchBrave("postgres pooling", locale)).resolves.toEqual([
      { title: "Pooling guide", url: "https://example.com/pool", snippet: "PgBouncer basics", source: "brave" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports API errors such as an invalid key or exhausted quota", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "bad-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)));
    await expect(searchBrave("q", locale)).rejects.toThrow("brave api returned HTTP 401");
  });

  it("scrapes the website when no key is set", async () => {
    const fetchMock = vi.fn(async () => new Response("<html></html>", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await searchBrave("q", locale);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/search\.brave\.com\/search\?/);
  });
});
