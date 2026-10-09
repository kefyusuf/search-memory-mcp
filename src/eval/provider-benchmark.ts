import type { SearchProvider } from "../providers/base.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { executeProviderSearch, type ProviderAttempt } from "../search/executor.js";
import { resolveSearchLocale } from "../search-utils.js";

export type BenchmarkQuery = { query: string; locale?: string };

export type ProviderBenchmarkSummary = {
  provider: string;
  attempts: number;
  ok: number;
  empty: number;
  error: number;
  backoff: number;
  successRate: number;
  p50Ms: number;
  p95Ms: number;
  avgResults: number;
  topErrors: Array<{ error: string; count: number }>;
};

/**
 * Runs each query against each provider on its own, so one provider's failure
 * never hides another's. A fresh health tracker per call keeps backoff from
 * skipping providers mid-run; requests are paced by delayMs.
 */
export async function runProviderBenchmark({
  providers,
  queries,
  delayMs = 1500,
  sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  onAttempt,
}: {
  providers: SearchProvider[];
  queries: BenchmarkQuery[];
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each provider call, for example to save the raw page of an empty result. */
  onAttempt?: (attempt: ProviderAttempt, query: string) => void | Promise<void>;
}): Promise<ProviderAttempt[]> {
  const attempts: ProviderAttempt[] = [];
  let first = true;
  for (const { query, locale } of queries) {
    for (const provider of providers) {
      if (!first && delayMs > 0) await sleep(delayMs);
      first = false;
      await executeProviderSearch({
        providers: [provider],
        query,
        locale: resolveSearchLocale(query, locale ?? null),
        strategy: "fallback",
        healthTracker: new ProviderHealthTracker(),
        onAttempt: (attempt) => attempts.push(attempt),
      });
      if (onAttempt) await onAttempt(attempts[attempts.length - 1], query);
    }
  }
  return attempts;
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function summarizeProviderBenchmark(attempts: ProviderAttempt[]): ProviderBenchmarkSummary[] {
  const byProvider = new Map<string, ProviderAttempt[]>();
  for (const attempt of attempts) {
    byProvider.set(attempt.provider, [...(byProvider.get(attempt.provider) ?? []), attempt]);
  }

  return [...byProvider.entries()].map(([provider, rows]) => {
    const count = (status: ProviderAttempt["status"]) => rows.filter((row) => row.status === status).length;
    const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
    const errors = new Map<string, number>();
    for (const row of rows) {
      if (row.error) errors.set(row.error, (errors.get(row.error) ?? 0) + 1);
    }
    return {
      provider,
      attempts: rows.length,
      ok: count("ok"),
      empty: count("empty"),
      error: count("error"),
      backoff: count("backoff"),
      successRate: count("ok") / rows.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      avgResults: rows.reduce((sum, row) => sum + row.resultCount, 0) / rows.length,
      topErrors: [...errors.entries()]
        .map(([error, errorCount]) => ({ error, count: errorCount }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
}

export function formatProviderBenchmarkReport(
  summary: ProviderBenchmarkSummary[],
  { queries, date }: { queries: number; date: string },
): string {
  const rows = summary.map((row) => [
    row.provider,
    row.attempts,
    row.ok,
    row.empty,
    row.error,
    `${Math.round(row.successRate * 100)}%`,
    row.p50Ms,
    row.p95Ms,
    row.topErrors.map(({ error, count }) => `${error.replaceAll("|", "/")} (${count})`).join("; ") || "-",
  ].join(" | "));
  return [
    `Provider benchmark, ${date}: ${queries} queries per provider.`,
    "",
    "| Provider | Attempts | OK | Empty | Error | Success | p50 ms | p95 ms | Top errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}
