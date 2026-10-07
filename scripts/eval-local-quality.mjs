#!/usr/bin/env node
// Synthetic offline characterization: FTS retrieval and heuristic entity extraction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KnowledgeIndex } from "../build/knowledge/index-store.js";
import { extractEntities } from "../build/graph/entity-graph.js";
import { evaluateRetrieval } from "../build/eval/retrieval-eval.js";

const fixture = JSON.parse(readFileSync(new URL("../evals/local-quality/cases.json", import.meta.url), "utf8"));
const sourceIds = new Set(fixture.documents.map(doc => doc.source));
assert.equal(sourceIds.size, fixture.documents.length, "Fixture sources must be unique.");
assert.equal(new Set(fixture.queries.map(row => row.id)).size, fixture.queries.length);
assert.equal(new Set(fixture.entities.map(row => row.id)).size, fixture.entities.length);
for (const row of fixture.queries) {
  assert.equal(new Set(row.relevantSources).size, row.relevantSources.length);
  for (const source of row.relevantSources) assert(sourceIds.has(source), `Unknown relevant source: ${source}`);
  assert.equal(row.group === "negative", row.relevantSources.length === 0);
}

const index = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
const retrievalCases = [];
try {
  for (const doc of fixture.documents) index.ingest({ ...doc, category: "eval" });
  for (const row of fixture.queries) {
    const hits = await index.search(row.query, 5);
    // Score sources once: multiple chunks from one source are not extra relevant documents.
    const retrievedIds = [...new Set(hits.map(hit => hit.source))];
    retrievalCases.push({ ...row, retrievedIds, relevantIds: row.relevantSources, chunkCount: hits.length });
  }
} finally {
  index.close();
}

const positive = retrievalCases.filter(row => row.group !== "negative");
const negative = retrievalCases.filter(row => row.group === "negative");
const retrieval = {
  positive: evaluateRetrieval(positive, { ks: [1, 3, 5] }),
  groups: Object.fromEntries([...new Set(positive.map(row => row.group))].map(group => [
    group, evaluateRetrieval(positive.filter(row => row.group === group), { ks: [1, 3, 5] }).metrics,
  ])),
  negatives: { count: negative.length, emptyResults: negative.filter(row => row.retrievedIds.length === 0).length },
  cases: retrievalCases.map(({ id, group, query, retrievedIds, relevantSources, chunkCount }) => ({
    id, group, query, retrievedSources: retrievedIds, relevantSources, chunkCount,
    duplicateSourceChunks: chunkCount - retrievedIds.length,
    missingSources: relevantSources.filter(source => !retrievedIds.includes(source)),
  })),
};

const entities = fixture.entities.map(row => {
  const extracted = extractEntities(row.text);
  const actual = new Map(extracted.map(entity => [entity.name, entity.count]));
  const expectedNames = Object.keys(row.expected);
  const matched = expectedNames.filter(name => actual.has(name));
  return {
    id: row.id, extracted, expected: row.expected, truePositive: matched.length,
    falsePositive: extracted.filter(entity => !(entity.name in row.expected)).map(entity => entity.name),
    falseNegative: expectedNames.filter(name => !actual.has(name)),
    countMismatches: matched.filter(name => actual.get(name) !== row.expected[name]).map(name => ({
      name, expected: row.expected[name], actual: actual.get(name),
    })),
  };
});
const truePositive = entities.reduce((sum, row) => sum + row.truePositive, 0);
const falsePositive = entities.reduce((sum, row) => sum + row.falsePositive.length, 0);
const falseNegative = entities.reduce((sum, row) => sum + row.falseNegative.length, 0);
const precision = truePositive / Math.max(1, truePositive + falsePositive);
const recall = truePositive / Math.max(1, truePositive + falseNegative);
console.log(JSON.stringify({
  mode: "synthetic-fts-only-no-model-no-network",
  documentCount: fixture.documents.length,
  retrieval,
  entities: {
    metrics: { precision, recall, f1: 2 * precision * recall / Math.max(Number.EPSILON, precision + recall),
      countMismatches: entities.reduce((sum, row) => sum + row.countMismatches.length, 0) },
    cases: entities,
  },
}, null, 2));
