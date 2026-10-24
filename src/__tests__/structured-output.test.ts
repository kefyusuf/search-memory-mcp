import { describe, expect, it } from "vitest";
import {
  buildSearchJson,
  buildIndexHitJson,
  buildAnswerJson,
  formatToolResult,
} from "../format/structured-output.js";
import type { SearchResultItem } from "../cache/types.js";
import type { KnowledgeChunkHit } from "../knowledge/index-store.js";

const results: SearchResultItem[] = [
  {
    title: "PgBouncer Guide",
    url: "https://example.com/pgbouncer",
    snippet: "Connection pooler for PostgreSQL",
    source: "duckduckgo",
    publishedAt: "2024-06-01",
    semanticScore: 0.91,
  },
  {
    title: "Gardening",
    url: "https://example.com/garden",
    snippet: "Water plants",
    source: "bing",
  },
];

describe("buildSearchJson", () => {
  it("returns a stable machine-readable search payload", () => {
    const payload = buildSearchJson("pg pooling", results, {
      strategy: "fallback",
      cache: "miss",
    });

    expect(payload.query).toBe("pg pooling");
    expect(payload.resultCount).toBe(2);
    expect(payload.results[0]).toMatchObject({
      title: "PgBouncer Guide",
      url: "https://example.com/pgbouncer",
      source: "duckduckgo",
    });
    expect(payload.results[0].semanticScore).toBeCloseTo(0.91);
    expect(payload.results[0].publishedAt).toBe("2024-06-01");
    expect(payload.meta.strategy).toBe("fallback");
  });

  it("omits undefined optional fields cleanly", () => {
    const payload = buildSearchJson("q", [results[1]]);
    expect(payload.results[0].semanticScore).toBeUndefined();
    expect(payload.results[0].publishedAt).toBeUndefined();
    expect(payload.meta).toEqual({});
  });
});

describe("buildIndexHitJson", () => {
  it("maps knowledge chunk hits to JSON", () => {
    const hit: KnowledgeChunkHit = {
      chunkId: "d1:0",
      docId: "d1",
      chunkIndex: 0,
      text: "PgBouncer multiplexes connections",
      title: "PgBouncer",
      source: "https://example.com/pgbouncer",
      score: 0.42,
      matchedBy: "hybrid",
    };

    const payload = buildIndexHitJson("pooling", [hit]);
    expect(payload.query).toBe("pooling");
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]).toMatchObject({
      title: "PgBouncer",
      source: "https://example.com/pgbouncer",
      matchedBy: "hybrid",
      score: 0.42,
    });
  });
});

describe("buildAnswerJson", () => {
  it("structures deep answers with citations", () => {
    const payload = buildAnswerJson("latest version?", "Node 22 is current", [
      { url: "https://example.com/releases", title: "Releases" },
    ]);

    expect(payload.answer).toContain("Node 22");
    expect(payload.sources[0].url).toBe("https://example.com/releases");
    expect(payload.sources[0].index).toBe(1);
  });
});

describe("formatToolResult", () => {
  it("returns pretty JSON when format=json", () => {
    const result = formatToolResult({ a: 1 }, "json");
    expect(result).toContain('"a": 1');
    expect(result).toContain("\n");
  });

  it("returns plain text when format=text", () => {
    const result = formatToolResult("hello", "text");
    expect(result).toBe("hello");
  });
});
