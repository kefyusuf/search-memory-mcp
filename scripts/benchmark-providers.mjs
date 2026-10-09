#!/usr/bin/env node
/**
 * Live provider benchmark: runs each query against each configured provider
 * separately and prints success, empty, error and latency per provider.
 * It sends real requests to search engines; keep the query count small and
 * the delay polite.
 *
 * Usage: node scripts/benchmark-providers.mjs [--limit N] [--delay MS] [--json PATH] [--dump DIR] [cases.jsonl]
 * --dump saves the raw response of every empty or failed attempt, to check whether
 * a provider served a block page or its result markup changed.
 * Providers come from SEARCH_PROVIDERS (default: duckduckgo,bing,brave,google).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (path) => import(pathToFileURL(join(root, "build", path)).href);
const { buildProviders } = await load("providers/registry.js");
const { runProviderBenchmark, summarizeProviderBenchmark, formatProviderBenchmarkReport } = await load("eval/provider-benchmark.js");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: "string" },
    delay: { type: "string", default: "1500" },
    json: { type: "string" },
    dump: { type: "string" },
  },
});

const casesPath = positionals[0] ?? join(root, "evals/providers/queries.jsonl");
let queries = readFileSync(casesPath, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
if (values.limit) queries = queries.slice(0, Number(values.limit));

const providerNames = (process.env.SEARCH_PROVIDERS ?? "duckduckgo,bing,brave,google")
  .split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
const providers = buildProviders(providerNames);

// Provider logs go to stderr; keep them out of the report.
console.error = () => {};
// Providers make one request per search, so the last response belongs to the attempt just reported.
let lastResponse = null;
if (values.dump) {
  mkdirSync(values.dump, { recursive: true });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const body = await response.clone().text().catch(() => "");
    lastResponse = { url: String(input instanceof Request ? input.url : input), status: response.status, body };
    return response;
  };
}

let dumped = 0;
const onAttempt = values.dump
  ? (attempt, query) => {
      if (attempt.status === "ok" || !lastResponse) return;
      dumped += 1;
      const name = `${String(dumped).padStart(3, "0")}-${attempt.provider}-${attempt.status}.html`;
      const header = `<!-- provider: ${attempt.provider}\n     status: ${attempt.status}${attempt.error ? ` (${attempt.error})` : ""}\n     query: ${query}\n     url: ${lastResponse.url}\n     http: ${lastResponse.status} -->\n`;
      writeFileSync(join(values.dump, name), header + lastResponse.body);
      lastResponse = null;
    }
  : undefined;

const attempts = await runProviderBenchmark({ providers, queries, delayMs: Number(values.delay), onAttempt });
const summary = summarizeProviderBenchmark(attempts);
const date = new Date().toISOString().slice(0, 10);

process.stdout.write(`${formatProviderBenchmarkReport(summary, { queries: queries.length, date })}\n`);
if (values.dump) process.stdout.write(`\nSaved ${dumped} raw responses to ${values.dump}\n`);
if (values.json) {
  writeFileSync(values.json, `${JSON.stringify({ date, queries, attempts, summary }, null, 2)}\n`);
}
