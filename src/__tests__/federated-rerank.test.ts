import { describe, expect, it, vi } from "vitest";
import { SemanticCache } from "../cache/semantic-cache.js";
import type { IEmbeddingProvider } from "../cache/types.js";
import { InMemoryVectorStore } from "./helpers.js";

function makeVec(values: number[]): number[] {
  const vec = new Array(384).fill(0);
  values.forEach((value, index) => {
    vec[index] = value;
  });
  return vec;
}

describe("federated semantic reranking", () => {
  it("blends semantic relevance with RRF consensus for fused results", async () => {
    const vectors: Record<string, number[]> = {
      "postgres pooling": makeVec([1, 0]),
      "Consensus result Shared by providers": makeVec([0.8, 0.6]),
      "Single result Perfect semantic match": makeVec([1, 0]),
    };
    const embeddings: IEmbeddingProvider = {
      getEmbedding: vi.fn(async (text: string) => vectors[text] ?? makeVec([0, 1])),
      isAvailable: vi.fn(() => true),
    };
    const cache = new SemanticCache(embeddings, new InMemoryVectorStore());

    const ranked = await cache.reRankResults("postgres pooling", [
      {
        title: "Consensus result",
        snippet: "Shared by providers",
        url: "https://example.com/consensus",
        source: "brave",
        sources: ["brave", "google"],
        fusionScore: 2 / 61,
      },
      {
        title: "Single result",
        snippet: "Perfect semantic match",
        url: "https://example.com/single",
        source: "google",
        sources: ["google"],
        fusionScore: 1 / 61,
      },
    ]);

    expect(ranked[0].url).toBe("https://example.com/consensus");
  });
});
