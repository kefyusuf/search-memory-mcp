import { describe, expect, it } from "vitest";
import { rewriteQuery, expandQuery, stripSiteOperator, type QueryContext } from "../search/query-rewrite.js";

describe("stripSiteOperator", () => {
  it("removes trailing site: operator", () => {
    expect(stripSiteOperator("react hooks site:react.dev")).toBe("react hooks");
    expect(stripSiteOperator("site:github.com")).toBe("");
  });

  it("keeps queries without site operator", () => {
    expect(stripSiteOperator("postgres pooling")).toBe("postgres pooling");
  });
});

describe("rewriteQuery", () => {
  it("expands obvious abbreviations", () => {
    const rewritten = rewriteQuery("pg pooling best practices");
    expect(rewritten.toLowerCase()).toContain("postgres");
    expect(rewritten.toLowerCase()).toContain("pooling");
  });

  it("keeps already-clear queries unchanged", () => {
    const query = "connection pooling strategies for postgresql";
    expect(rewriteQuery(query)).toBe(query);
  });

  it("maps question prefixes to keyword form", () => {
    const rewritten = rewriteQuery("how to configure playwright networkidle wait");
    expect(rewritten.toLowerCase()).not.toMatch(/^how to /);
    expect(rewritten.toLowerCase()).toContain("playwright");
    expect(rewritten.toLowerCase()).toContain("networkidle");
  });

  it("handles empty and whitespace input safely", () => {
    expect(rewriteQuery("")).toBe("");
    expect(rewriteQuery("   ")).toBe("");
  });
});

describe("expandQuery", () => {
  it("returns the original plus synonym variants", () => {
    const variants = expandQuery("db backup strategy", { maxVariants: 3 });
    expect(variants[0]).toBe("db backup strategy");
    expect(variants.length).toBeGreaterThan(1);
    expect(variants.length).toBeLessThanOrEqual(4); // original + maxVariants
  });

  it("respects maxVariants", () => {
    const variants = expandQuery("js framework performance", { maxVariants: 1 });
    expect(variants).toHaveLength(2);
  });

  it("returns single query when no expansions apply", () => {
    expect(expandQuery("unique purple zebra xylophone")).toEqual(["unique purple zebra xylophone"]);
  });

  it("does not duplicate identical variants", () => {
    const variants = expandQuery("db migration", { maxVariants: 5 });
    expect(new Set(variants).size).toBe(variants.length);
  });

  it("can use context intent to bias expansion", () => {
    const context: QueryContext = { intent: "news" };
    const variants = expandQuery("ai regulation", { maxVariants: 2, context });
    expect(variants.length).toBeGreaterThanOrEqual(1);
  });
});
