import { describe, expect, it, vi } from "vitest";
import { CrossEncoderReranker, rerankResults } from "../search/rerank.js";
import type { SearchResultItem } from "../cache/types.js";

function result(title: string, snippet: string): SearchResultItem {
  return {
    title,
    snippet,
    url: `https://example.com/${title.toLowerCase().replace(/\s+/g, "-")}`,
    source: "test",
  };
}

describe("rerankResults", () => {
  it("reorders results by cross-encoder scores", async () => {
    const scorer = vi.fn(async (_query: string, texts: string[]) => {
      // Higher score for results that mention pooling.
      return texts.map((text) => (/pooling/i.test(text) ? 0.9 : 0.1));
    });

    const results = [
      result("Gardening tips", "How to water plants in summer"),
      result("PgBouncer pooling", "Connection pooling for PostgreSQL"),
    ];

    const reranked = await rerankResults("postgres connection pooling", results, {
      scorer,
    });

    expect(reranked[0].title).toBe("PgBouncer pooling");
    expect(reranked[1].title).toBe("Gardening tips");
    expect(scorer).toHaveBeenCalledOnce();
  });

  it("annotates each result with a rerank score", async () => {
    const scorer = async () => [0.42];
    const reranked = await rerankResults("q", [result("Only", "text")], { scorer });
    expect(reranked[0].semanticScore).toBeCloseTo(0.42);
  });

  it("returns original order when scorer fails", async () => {
    const scorer = vi.fn(async () => {
      throw new Error("model unavailable");
    });

    const results = [result("A", "alpha"), result("B", "beta")];
    const reranked = await rerankResults("q", results, { scorer });
    expect(reranked.map((r) => r.title)).toEqual(["A", "B"]);
  });

  it("handles empty result list", async () => {
    const scorer = vi.fn(async () => []);
    await expect(rerankResults("q", [], { scorer })).resolves.toEqual([]);
    expect(scorer).not.toHaveBeenCalled();
  });

  it("truncates to limit", async () => {
    const scorer = async (_q: string, texts: string[]) => texts.map((_, i) => i);
    const results = [result("A", "a"), result("B", "b"), result("C", "c")];
    const reranked = await rerankResults("q", results, { scorer, limit: 2 });
    expect(reranked).toHaveLength(2);
  });
});

describe("CrossEncoderReranker", () => {
  it("exposes availability before load", () => {
    const reranker = new CrossEncoderReranker({
      loadPipeline: async () => {
        throw new Error("no model");
      },
    });
    expect(reranker.isAvailable()).toBe(false);
  });

  it("marks unavailable after a failed load and returns empty scores", async () => {
    const reranker = new CrossEncoderReranker({
      loadPipeline: async () => {
        throw new Error("download failed");
      },
    });

    const scores = await reranker.score("query", ["doc a", "doc b"]);
    expect(scores).toEqual([0, 0]);
    expect(reranker.isAvailable()).toBe(false);
  });

  it("uses a loaded pipeline to score pairs", async () => {
    const fakePipeline = vi.fn(async () => {
      return async (pairs: Array<{ text: string; text_pair: string }>) => ({
        // Return higher scores for longer pairs so the test is deterministic.
        logits: pairs.map((pair) => [pair.text_pair.length, 0]),
      });
    });

    const reranker = new CrossEncoderReranker({ loadPipeline: fakePipeline });
    const scores = await reranker.score("query", ["short", "much longer document text"]);

    expect(scores).toHaveLength(2);
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(reranker.isAvailable()).toBe(true);
  });
});
