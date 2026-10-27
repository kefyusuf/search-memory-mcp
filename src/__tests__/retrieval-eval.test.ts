import { describe, expect, it } from "vitest";
import {
  evaluateRetrieval,
  recallAtK,
  precisionAtK,
  meanReciprocalRank,
  ndcgAtK,
  formatEvalReport,
} from "../eval/retrieval-eval.js";

describe("retrieval metrics", () => {
  it("computes recall@k against relevant ids", () => {
    // Relevant: a, c. Retrieved order: a, b, c, d
    const retrieved = ["a", "b", "c", "d"];
    expect(recallAtK(retrieved, ["a", "c"], 1)).toBeCloseTo(0.5); // only a
    expect(recallAtK(retrieved, ["a", "c"], 3)).toBeCloseTo(1.0); // a and c
    expect(recallAtK(retrieved, ["a", "c"], 10)).toBeCloseTo(1.0);
  });

  it("computes precision@k", () => {
    const retrieved = ["a", "b", "c", "d"];
    expect(precisionAtK(retrieved, ["a", "c"], 2)).toBeCloseTo(0.5); // 1 of top-2
    expect(precisionAtK(retrieved, ["a", "c"], 4)).toBeCloseTo(0.5); // 2 of top-4
  });

  it("computes MRR", () => {
    expect(meanReciprocalRank(["a", "b", "c"], ["c"])).toBeCloseTo(1 / 3);
    expect(meanReciprocalRank(["c", "b", "a"], ["c"])).toBeCloseTo(1);
    expect(meanReciprocalRank(["x", "y"], ["z"])).toBe(0);
  });

  it("handles empty inputs safely", () => {
    expect(recallAtK([], ["a"], 5)).toBe(0);
    expect(precisionAtK([], ["a"], 5)).toBe(0);
    expect(meanReciprocalRank([], ["a"])).toBe(0);
    expect(ndcgAtK([], ["a"], 5)).toBe(0);
    expect(ndcgAtK(["b"], [], 5)).toBe(0);
  });

  it("computes binary nDCG@k with duplicate-id deduplication", () => {
    // Both relevant found within k: binary gains make any order score 1.
    expect(ndcgAtK(["a", "b", "c"], ["a", "b"], 5)).toBeCloseTo(1.0);
    expect(ndcgAtK(["b", "a"], ["a", "b"], 5)).toBeCloseTo(1.0);
    // Duplicated ids count once: a, a, b ranks like a, b.
    expect(ndcgAtK(["a", "a", "b"], ["a", "b"], 5)).toBeCloseTo(1.0);
    // Order matters when only part of the relevant set is found:
    // relevant {a}: at rank 1 is ideal; at rank 2 loses to the ideal position.
    expect(ndcgAtK(["a", "x"], ["a"], 5)).toBeCloseTo(1.0);
    expect(ndcgAtK(["x", "a"], ["a"], 5)).toBeCloseTo(1 / Math.log2(3));
  });
});

describe("evaluateRetrieval", () => {
  it("aggregates metrics across queries", () => {
    const report = evaluateRetrieval(
      [
        {
          query: "postgres pooling",
          relevantIds: ["doc1", "doc2"],
          retrievedIds: ["doc1", "doc9", "doc2", "doc8"],
        },
        {
          query: "playwright fallback",
          relevantIds: ["doc3"],
          retrievedIds: ["doc9", "doc3"],
        },
      ],
      { ks: [1, 3] },
    );

    expect(report.queryCount).toBe(2);
    expect(report.metrics.recallAt1).toBeCloseTo(0.25); // (0.5 + 0) / 2
    expect(report.metrics.recallAt3).toBeCloseTo(1.0); // (1 + 1) / 2
    expect(report.metrics.precisionAt1).toBeCloseTo(0.5); // (1 + 0) / 2
    expect(report.metrics.mrr).toBeCloseTo((1 + 1 / 2) / 2);
  });

  it("supports a judge function that scores id relevance", () => {
    const report = evaluateRetrieval(
      [
        {
          query: "pooling",
          retrievedIds: ["https://a.example", "https://b.example"],
          // Judge: only a.example is relevant
          judge: (id) => id === "https://a.example",
        },
      ],
      { ks: [1] },
    );

    expect(report.metrics.recallAt1).toBe(1);
    expect(report.metrics.precisionAt1).toBe(1);
  });

  it("formats a readable report", () => {
    const report = evaluateRetrieval(
      [{ query: "q", relevantIds: ["a"], retrievedIds: ["a", "b"] }],
      { ks: [1, 2] },
    );

    const text = formatEvalReport(report);
    expect(text).toContain("recall@1");
    expect(text).toContain("mrr");
    expect(text).toContain("queries: 1");
  });
});
