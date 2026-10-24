import { afterEach, describe, expect, it, vi } from "vitest";
import { searchTavily } from "../providers/tavily.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TAVILY_API_KEY;
});

describe("tavily api provider", () => {
  it("posts the query with a bearer key and news topic for news-intent queries", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchTavily("latest ai announcements today", locale);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toBe("https://api.tavily.com/search");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.query).toBe("latest ai announcements today");
    expect(body.topic).toBe("news");
    expect(body.max_results).toBe(10);
  });

  it("omits the topic for non-news queries", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchTavily("postgres connection pooling", locale);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL | string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.topic).toBeUndefined();
  });

  it("moves a site: suffix into include_domains instead of the query text", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchTavily("server components reference site:react.dev", locale);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL | string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.query).toBe("server components reference");
    expect(body.include_domains).toEqual(["react.dev"]);
  });

  it("maps results with normalized publish dates and skips incomplete entries", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      results: [
        { title: "Release <b>notes</b>", url: "https://example.com/a", content: "Details <em>here</em>", published_date: "2026-10-24T08:30:00Z" },
        { title: "", url: "https://example.com/missing-title" },
        { title: "No url", url: "" },
      ],
    })));

    const results = await searchTavily("q", locale);

    expect(results).toEqual([
      {
        title: "Release notes",
        url: "https://example.com/a",
        snippet: "Details here",
        source: "tavily",
        publishedAt: "2026-10-24",
      },
    ]);
  });

  it("rejects with the HTTP status so blocking is not reported as empty", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "quota" }, 429)));

    await expect(searchTavily("q", locale)).rejects.toThrow("tavily api returned HTTP 429");
  });

  it("refuses to run without a key", async () => {
    delete process.env.TAVILY_API_KEY;
    await expect(searchTavily("q", locale)).rejects.toThrow("TAVILY_API_KEY");
  });
});
