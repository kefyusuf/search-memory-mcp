import { describe, expect, it } from "vitest";
import {
  extractPublishDate,
  filterResultsByDate,
  isWithinDateRange,
} from "../search/date-filter.js";
import type { SearchResultItem } from "../cache/types.js";

function result(overrides: Partial<SearchResultItem> & { snippet: string }): SearchResultItem {
  return {
    title: "Title",
    url: "https://example.com/a",
    source: "test",
    ...overrides,
  };
}

describe("extractPublishDate", () => {
  it("parses ISO dates from snippets", () => {
    expect(extractPublishDate("Published 2024-03-15 about databases")).toBe("2024-03-15");
  });

  it("parses month-name dates", () => {
    expect(extractPublishDate("Updated Mar 15, 2024 with new API details")).toBe("2024-03-15");
    expect(extractPublishDate("Posted 15 March 2024")).toBe("2024-03-15");
  });

  it("parses relative dates like 3 days ago", () => {
    const date = extractPublishDate("Released 3 days ago");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns null when no date is present", () => {
    expect(extractPublishDate("Just a plain snippet without any date signal")).toBeNull();
  });
});

describe("isWithinDateRange", () => {
  it("includes dates inside the range", () => {
    expect(isWithinDateRange("2024-06-01", { from: "2024-01-01", to: "2024-12-31" })).toBe(true);
  });

  it("excludes dates outside the range", () => {
    expect(isWithinDateRange("2023-06-01", { from: "2024-01-01" })).toBe(false);
    expect(isWithinDateRange("2025-06-01", { to: "2024-12-31" })).toBe(false);
  });

  it("keeps undated results only when keepUndated is true", () => {
    expect(isWithinDateRange(null, { from: "2024-01-01" }, { keepUndated: false })).toBe(false);
    expect(isWithinDateRange(null, { from: "2024-01-01" }, { keepUndated: true })).toBe(true);
  });

  it("treats missing bounds as open-ended", () => {
    expect(isWithinDateRange("1999-01-01", {}, { keepUndated: true })).toBe(true);
  });
});

describe("filterResultsByDate", () => {
  it("filters search results by date range and keeps undated when asked", () => {
    const results = [
      result({ snippet: "Published 2024-05-01 about new features", title: "New" }),
      result({ snippet: "Published 2020-01-01 about old docs", title: "Old" }),
      result({ snippet: "No date here at all", title: "Undated" }),
    ];

    const kept = filterResultsByDate(results, { from: "2024-01-01" }, { keepUndated: true });

    expect(kept.map((r) => r.title)).toEqual(["New", "Undated"]);
  });

  it("can drop undated results", () => {
    const results = [
      result({ snippet: "Published 2024-05-01", title: "New" }),
      result({ snippet: "No date", title: "Undated" }),
    ];

    const kept = filterResultsByDate(results, { from: "2024-01-01" }, { keepUndated: false });
    expect(kept.map((r) => r.title)).toEqual(["New"]);
  });

  it("returns all results when no range is provided", () => {
    const results = [
      result({ snippet: "2020-01-01", title: "A" }),
      result({ snippet: "nothing", title: "B" }),
    ];
    expect(filterResultsByDate(results, undefined)).toHaveLength(2);
  });

  it("prefers a provider-supplied publishedAt over snippet date extraction", () => {
    const results = [
      result({ snippet: "Old post from 2019-05-05", title: "ActuallyRecent", publishedAt: "2024-06-01" }),
      result({ snippet: "Recent 2024-06-01 update", title: "ActuallyOld", publishedAt: "2019-01-01" }),
    ];

    const kept = filterResultsByDate(results, { from: "2024-01-01" });

    expect(kept.map((r) => r.title)).toEqual(["ActuallyRecent"]);
  });

  it("falls back to snippet extraction when publishedAt is malformed", () => {
    const results = [result({ snippet: "Written 2024-06-01", title: "Valid", publishedAt: "not-a-date" })];

    expect(filterResultsByDate(results, { from: "2024-01-01" })).toHaveLength(1);
  });

  it("treats results with publishedAt as dated for keepUndated purposes", () => {
    const results = [result({ snippet: "No date signal at all", title: "Dated", publishedAt: "2019-01-01" })];

    expect(filterResultsByDate(results, { from: "2024-01-01" }, { keepUndated: true })).toHaveLength(0);
  });
});
