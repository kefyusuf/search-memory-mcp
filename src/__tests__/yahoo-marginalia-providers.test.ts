import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseMarginaliaResults, parseYahooResults } from "../search-utils.js";
import { searchMarginalia } from "../providers/marginalia.js";
import { searchYahoo } from "../providers/yahoo.js";
import { buildProviders } from "../providers/registry.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const locale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };

describe("parseYahooResults", () => {
  it("reads organic results from a saved Yahoo results page", () => {
    const results = parseYahooResults(fixture("yahoo-results.html"));
    expect(results.length).toBe(7);
    expect(results[0]).toMatchObject({ title: "Node.js — Node.js Releases", url: "https://nodejs.org/en/about/previous-releases", source: "yahoo" });
    expect(results[0].snippet).toMatch(/Starting with Node\.js 27/);
    expect(results.every((result) => !result.url.includes("yahoo.com"))).toBe(true);
  });

  it("unwraps r.search.yahoo.com redirect links", () => {
    const html = `<div class="algo"><div class="compTitle"><a href="https://r.search.yahoo.com/_ylt=x/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.com%2fpage/RK=2/RS=abc-"><h3 class="title">Example page</h3></a></div><div class="compText"><p>Snippet text</p></div></div>`;
    expect(parseYahooResults(html)).toEqual([{ title: "Example page", url: "https://example.com/page", snippet: "Snippet text", source: "yahoo" }]);
  });
});

describe("parseMarginaliaResults", () => {
  it("reads results from a saved Marginalia results page", () => {
    const results = parseMarginaliaResults(fixture("marginalia-results.html"));
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(results[0]).toMatchObject({
      title: "Node.js — Evolving the Node.js Release Schedule",
      url: "https://nodejs.org/en/blog/announcements/evolving-the-nodejs-release-schedule",
      source: "marginalia",
    });
    expect(results[0].snippet).toMatch(/^Release Schedule\. Node\.js Releasers/);
    expect(results.every((result) => !result.url.includes("marginalia-search.com"))).toBe(true);
  });
});

describe("yahoo and marginalia providers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("query the search pages and report HTTP errors", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "search.yahoo.com") {
        expect(url.searchParams.get("p")).toBe("node lts");
        return new Response(fixture("yahoo-results.html"));
      }
      expect(url.hostname).toBe("marginalia-search.com");
      expect(url.searchParams.get("query")).toBe("node lts");
      return new Response("blocked", { status: 429 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await searchYahoo("node lts", locale)).length).toBe(7);
    await expect(searchMarginalia("node lts", locale)).rejects.toThrow("marginalia returned HTTP 429");
  });

  it("are registered by name", () => {
    expect(buildProviders(["yahoo", "marginalia"]).map((provider) => provider.name)).toEqual(["yahoo", "marginalia"]);
  });
});
