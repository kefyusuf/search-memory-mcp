import { describe, expect, it } from "vitest";
import { fuseQueryResults } from "../search/multi-query.js";
import type { SearchResultItem } from "../cache/types.js";

function hit(url: string, source = "bing"): SearchResultItem {
  return { title: url, url, snippet: "Database guide", source };
}

describe("multi-query result fusion", () => {
  it("promotes cross-query matches, normalizes duplicates, and keeps real providers", () => {
    const results = fuseQueryResults([
      [hit("https://example.com/first"), hit("https://example.com/shared?utm_source=search")],
      [hit("https://example.com/shared", "brave"), hit("https://example.com/other")],
    ]);
    expect(results).toHaveLength(3);
    expect(results[0].url).toBe("https://example.com/shared?utm_source=search");
    expect(results[0].source).toBe("bing");
    expect(results[0].sources).toEqual(["bing", "brave"]);
    expect(results[0].fusionScore).toBeCloseTo(1 / 62 + 1 / 61);
  });

  it("counts a URL only once in each query result set", () => {
    const results = fuseQueryResults([
      [hit("https://example.com/a"), hit("https://example.com/a?utm_medium=duplicate")],
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].fusionScore).toBeCloseTo(1 / 61);
  });

  it("retains provider provenance from an aggregate result", () => {
    const result = { ...hit("https://example.com/a"), sources: ["bing", "google"], providerRanks: { bing: 2, google: 1 } };
    expect(fuseQueryResults([[result], []])[0]).toMatchObject({
      sources: ["bing", "google"], providerRanks: { bing: 2, google: 1 },
    });
  });
});
