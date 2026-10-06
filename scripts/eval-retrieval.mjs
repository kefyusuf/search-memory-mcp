#!/usr/bin/env node
/**
 * Offline FTS-only baseline over KnowledgeIndex (no model loading/downloads).
 * Usage: node scripts/eval-retrieval.mjs [path/to/cases.jsonl]
 */
import { createInterface } from "node:readline";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const { KnowledgeIndex } = await import(pathToFileURL(join(root, "build/knowledge/index-store.js")).href);
const { evaluateRetrieval, formatEvalReport } = await import(pathToFileURL(join(root, "build/eval/retrieval-eval.js")).href);

const casesPath = process.argv[2] || join(root, "evals/retrieval/cases.jsonl");
if (!existsSync(casesPath)) {
  console.error(`Cases file not found: ${casesPath}`);
  process.exit(1);
}

const lines = createInterface({ input: createReadStream(casesPath, "utf8") });
const evalCases = [];

for await (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const row = JSON.parse(trimmed);
  const index = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
  for (const doc of row.docs ?? []) {
    index.ingest({
      title: doc.title,
      source: doc.source,
      content: doc.content,
      category: "eval",
    });
  }

  const hits = await index.search(row.query, 5);
  evalCases.push({
    query: row.query,
    retrievedIds: hits.map((hit) => hit.source),
    relevantIds: row.relevant_sources ?? [],
  });
  await index.flush?.();
  index.close();
}

const report = evaluateRetrieval(evalCases, { ks: [1, 3, 5] });
console.log(formatEvalReport(report));
