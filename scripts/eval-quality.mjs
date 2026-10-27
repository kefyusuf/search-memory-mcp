#!/usr/bin/env node
/**
 * P1-03 offline quality harness: scores the labeled local-retrieval subset
 * of evals/quality/queries.jsonl against the shared fixture corpus
 * (evals/quality/local-corpus.jsonl) on one FTS-only in-memory
 * KnowledgeIndex - deterministic, no models, no network. The web subset is
 * structural only and is counted but not scored offline.
 * Usage: node scripts/eval-quality.mjs [--json PATH]
 */
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const { KnowledgeIndex } = await import(pathToFileURL(join(root, "build/knowledge/index-store.js")).href);
const { evaluateRetrieval, ndcgAtK } = await import(pathToFileURL(join(root, "build/eval/retrieval-eval.js")).href);

const jsonArg = process.argv.indexOf("--json");
const jsonPath = jsonArg >= 0 ? process.argv[jsonArg + 1] : null;

async function readJsonl(path) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(path, "utf8") });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed));
  }
  return rows;
}

const corpus = await readJsonl(join(root, "evals/quality/local-corpus.jsonl"));
const queries = await readJsonl(join(root, "evals/quality/queries.jsonl"));

const index = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
for (const doc of corpus) {
  index.ingest({ title: doc.title, source: `evals-quality://${doc.id}`, content: doc.content, category: "quality-eval" });
}
await index.flush();

const localQueries = queries.filter(q => q.kind === "local");
const webQueries = queries.filter(q => q.kind === "web");

const positiveCases = [];
const negativeFailures = [];
let negativesPassed = 0;
let top1Hits = 0;
let top1Total = 0;
const perQuery = [];

for (const q of localQueries) {
  const hits = await index.search(q.query, 5);
  const retrievedIds = [...new Set(hits.map(hit => hit.source))];
  if (q.expectEmpty) {
    if (hits.length === 0) negativesPassed++;
    else negativeFailures.push({ id: q.id, query: q.query, firstHit: hits[0]?.source });
    continue;
  }
  const relevantIds = (q.relevantDocIds ?? []).map(id => `evals-quality://${id}`);
  const ndcg = ndcgAtK(retrievedIds, relevantIds, 5);
  positiveCases.push({ query: q.query, retrievedIds, relevantIds });
  if (q.top1DocId) {
    top1Total++;
    if (retrievedIds[0] === `evals-quality://${q.top1DocId}`) top1Hits++;
  }
  perQuery.push({ id: q.id, locale: q.locale, split: q.split, ndcgAt5: ndcg, recallAt5: undefined, reciprocalRank: undefined });
}

const report = evaluateRetrieval(positiveCases, { ks: [1, 3, 5] });
// Attach nDCG@5 per query and aggregate manually (evaluateRetrieval has no nDCG).
const ndcgByQuery = positiveCases.map((c, i) => ndcgAtK(c.retrievedIds, c.relevantIds, 5));
const ndcgAt5 = ndcgByQuery.reduce((sum, v) => sum + v, 0) / Math.max(positiveCases.length, 1);
const byLocale = {};
for (let i = 0; i < positiveCases.length; i++) {
  const locale = perQuery[i].locale;
  byLocale[locale] ??= { count: 0, ndcgSum: 0 };
  byLocale[locale].count++;
  byLocale[locale].ndcgSum += ndcgByQuery[i];
}
for (const locale of Object.keys(byLocale)) {
  byLocale[locale].ndcgAt5 = byLocale[locale].ndcgSum / byLocale[locale].count;
  delete byLocale[locale].ndcgSum;
}
const top1Accuracy = top1Total > 0 ? top1Hits / top1Total : null;

const summary = {
  set: "P1-03 offline quality set",
  totals: { queries: queries.length, local: localQueries.length, webStructuralSkipped: webQueries.length, positive: positiveCases.length, negatives: localQueries.length - positiveCases.length },
  metrics: {
    ...report.metrics,
    ndcgAt5,
    top1Accuracy,
  },
  byLocale,
  negatives: { passed: negativesPassed, failed: negativeFailures.length, failures: negativeFailures },
  perQuery,
};

const formatKey = key => key.replace(/^recallAt(\d+)$/, "recall@$1").replace(/^precisionAt(\d+)$/, "precision@$1");
const metricLines = Object.entries(summary.metrics)
  .filter(([, value]) => typeof value === "number")
  .map(([key, value]) => `  ${formatKey(key)}: ${value.toFixed(4)}`)
  .join("\n");
console.log(`P1-03 offline quality report\nqueries: ${queries.length} (local ${localQueries.length}: ${positiveCases.length} labeled + ${localQueries.length - positiveCases.length} negatives; web-structural skipped: ${webQueries.length})\n\nmetrics:\n${metricLines}`);
for (const [locale, stats] of Object.entries(byLocale)) {
  console.log(`  ${locale}: nDCG@5 ${stats.ndcgAt5.toFixed(4)} over ${stats.count} queries`);
}
console.log(`  top1Accuracy: ${top1Accuracy === null ? "n/a" : top1Accuracy.toFixed(4)} (${top1Hits}/${top1Total})`);
console.log(`  negatives (expectEmpty): ${negativesPassed}/${negativesPassed + negativeFailures.length} returned zero hits`);
if (negativeFailures.length > 0) {
  for (const failure of negativeFailures) console.error(`  NEGATIVE FAIL ${failure.id}: first hit ${failure.firstHit}`);
}

if (jsonPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`report written: ${jsonPath}`);
}
index.close();
