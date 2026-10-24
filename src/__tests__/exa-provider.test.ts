import { afterEach, describe, expect, it, vi } from "vitest";
import { searchExa } from "../providers/exa.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EXA_API_KEY;
});

describe("exa api provider", () => {
  it("posts the query with an api key and auto retrieval type", async () => {
    process.env.EXA_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchExa("papers about attention-free transformers", locale);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL | string, RequestInit];
    expect(String(url)).toBe("https://api.exa.ai/search");
    expect(new Headers(init.headers).get("x-api-key")).toBe("test-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.query).toBe("papers about attention-free transformers");
    expect(body.type).toBe("auto");
    expect(body.numResults).toBe(10);
    expect(body.contents).toEqual({ highlights: { numSentences: 2 } });
  });

  it("moves a site: suffix into includeDomains instead of the query text", async () => {
    process.env.EXA_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await searchExa("connection pooler internals site:github.com", locale);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [URL | string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(body.query).toBe("connection pooler internals");
    expect(body.includeDomains).toEqual(["github.com"]);
  });

  it("maps highlights to snippets with normalized publish dates", async () => {
    process.env.EXA_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      results: [
        { title: "Semantic <b>search</b>", url: "https://example.com/a", publishedDate: "2026-10-01", highlights: ["Relevant passage <i>here</i>."] },
        { title: "No highlights", url: "https://example.com/b", text: "Fallback text." },
        { title: "", url: "https://example.com/c" },
      ],
    })));

    const results = await searchExa("q", locale);

    expect(results).toEqual([
      {
        title: "Semantic search",
        url: "https://example.com/a",
        snippet: "Relevant passage here.",
        source: "exa",
        publishedAt: "2026-10-01",
      },
      {
        title: "No highlights",
        url: "https://example.com/b",
        snippet: "Fallback text.",
        source: "exa",
      },
    ]);
  });

  it("rejects with the HTTP status so blocking is not reported as empty", async () => {
    process.env.EXA_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "blocked" }, 429)));

    await expect(searchExa("q", locale)).rejects.toThrow("exa api returned HTTP 429");
  });

  it("refuses to run without a key", async () => {
    delete process.env.EXA_API_KEY;
    await expect(searchExa("q", locale)).rejects.toThrow("EXA_API_KEY");
  });
});
