import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSearXng } from "../providers/searxng.js";

const locale = {
  acceptLanguage: "en-US,en;q=0.9",
  market: "en-US",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("searchSearXng", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SEARXNG_BASE_URL;
  });

  it("returns [] when SEARXNG_BASE_URL is not configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchSearXng("postgres pooling", locale)).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("queries the JSON API and maps results", async () => {
    process.env.SEARXNG_BASE_URL = "https://searxng.example.com/";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/search");
      expect(url.searchParams.get("q")).toBe("postgres pooling");
      expect(url.searchParams.get("format")).toBe("json");
      return jsonResponse({
        results: [
          {
            title: "Postgres pooling guide",
            url: "https://example.com/pg-pool",
            content: "How to pool Postgres connections.",
            engine: "google",
          },
          {
            title: "",
            url: "https://example.com/missing-title",
            content: "Should be dropped",
          },
          {
            title: "No URL",
            content: "Should be dropped",
          },
          {
            title: "Second hit",
            url: "https://example.com/second",
            content: "Another result",
          },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchSearXng("postgres pooling", locale);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Postgres pooling guide",
      url: "https://example.com/pg-pool",
      snippet: "How to pool Postgres connections.",
      source: "searxng",
    });
  });

  it("rejects on non-OK HTTP status so the executor reports an error", async () => {
    process.env.SEARXNG_BASE_URL = "https://searxng.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 429 })));

    await expect(searchSearXng("q", locale)).rejects.toThrow("searxng returned HTTP 429");
  });

  it("returns [] on invalid JSON body", async () => {
    process.env.SEARXNG_BASE_URL = "https://searxng.example.com";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(searchSearXng("q", locale)).resolves.toEqual([]);
  });

  it("strips trailing slashes from the configured base URL", async () => {
    process.env.SEARXNG_BASE_URL = "https://searxng.example.com///";
    const fetchMock = vi.fn(async (input: string | URL) => {
      expect(String(input).startsWith("https://searxng.example.com/search?")).toBe(true);
      return jsonResponse({ results: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchSearXng("q", locale)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
