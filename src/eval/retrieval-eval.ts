export type EvalCase = {
  query: string;
  retrievedIds: string[];
  /** Explicit relevant ids. Optional if judge is provided. */
  relevantIds?: string[];
  /** Predicate deciding whether a retrieved id is relevant. */
  judge?: (id: string) => boolean;
};

export type EvalOptions = {
  ks?: number[];
};

export type RetrievalReport = {
  queryCount: number;
  metrics: {
    recallAt1: number;
    recallAt3?: number;
    recallAt5?: number;
    recallAt10?: number;
    precisionAt1: number;
    precisionAt3?: number;
    precisionAt5?: number;
    mrr: number;
    [key: string]: number | undefined;
  };
  perQuery: Array<{
    query: string;
    recallAt1: number;
    precisionAt1: number;
    reciprocalRank: number;
    retrievedCount: number;
    relevantCount: number;
  }>;
};

function relevantSet(testCase: EvalCase): Set<string> {
  if (testCase.relevantIds && testCase.relevantIds.length > 0) {
    return new Set(testCase.relevantIds);
  }
  if (testCase.judge) {
    return new Set(testCase.retrievedIds.filter((id) => testCase.judge!(id)));
  }
  return new Set();
}

export function recallAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (relevantIds.length === 0 || k <= 0) return 0;
  const top = retrievedIds.slice(0, k);
  const relevant = new Set(relevantIds);
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

export function precisionAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (k <= 0) return 0;
  const top = retrievedIds.slice(0, k);
  if (top.length === 0) return 0;
  const relevant = new Set(relevantIds);
  const hits = top.filter((id) => relevant.has(id)).length;
  return hits / top.length;
}

export function meanReciprocalRank(retrievedIds: string[], relevantIds: string[]): number {
  const relevant = new Set(relevantIds);
  for (let i = 0; i < retrievedIds.length; i++) {
    if (relevant.has(retrievedIds[i])) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

/** Binary-relevance nDCG@k over unique retrieved ids. */
export function ndcgAtK(retrievedIds: string[], relevantIds: string[], k: number): number {
  if (k <= 0) return 0;
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) return 0;
  const seen = new Set<string>();
  const gains: number[] = [];
  for (const id of retrievedIds.slice(0, k)) {
    if (seen.has(id)) continue;
    seen.add(id);
    gains.push(relevant.has(id) ? 1 : 0);
  }
  const dcg = gains.reduce((sum, gain, index) => sum + gain / Math.log2(index + 2), 0);
  const idealLength = Math.min(relevant.size, k);
  const idcg = Array.from({ length: idealLength }, (_, index) => 1 / Math.log2(index + 2))
    .reduce((sum, value) => sum + value, 0);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function evaluateRetrieval(cases: EvalCase[], options?: EvalOptions): RetrievalReport {
  const ks = [...new Set(options?.ks ?? [1, 3, 5, 10])].sort((a, b) => a - b);
  const perQuery: RetrievalReport["perQuery"] = [];

  const sums: Record<string, number> = {};
  for (const k of ks) {
    sums[`recallAt${k}`] = 0;
    sums[`precisionAt${k}`] = 0;
  }
  sums.mrr = 0;

  for (const testCase of cases) {
    const relevant = [...relevantSet(testCase)];
    const retrieved = testCase.retrievedIds;

    const recallAt1 = recallAtK(retrieved, relevant, 1);
    const precisionAt1 = precisionAtK(retrieved, relevant, 1);
    const reciprocalRank = meanReciprocalRank(retrieved, relevant);

    for (const k of ks) {
      sums[`recallAt${k}`] += recallAtK(retrieved, relevant, k);
      sums[`precisionAt${k}`] += precisionAtK(retrieved, relevant, k);
    }
    sums.mrr += reciprocalRank;

    perQuery.push({
      query: testCase.query,
      recallAt1,
      precisionAt1,
      reciprocalRank,
      retrievedCount: retrieved.length,
      relevantCount: relevant.length,
    });
  }

  const count = Math.max(cases.length, 1);
  const metrics: RetrievalReport["metrics"] = {
    recallAt1: 0,
    precisionAt1: 0,
    mrr: 0,
  };

  for (const key of Object.keys(sums)) {
    metrics[key] = sums[key] / count;
  }

  return {
    queryCount: cases.length,
    metrics,
    perQuery,
  };
}

export function formatEvalReport(report: RetrievalReport): string {
  const formatKey = (key: string): string =>
    key
      .replace(/^recallAt(\d+)$/, "recall@$1")
      .replace(/^precisionAt(\d+)$/, "precision@$1");

  const metricLines = Object.entries(report.metrics)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([key, value]) => `  ${formatKey(key)}: ${value.toFixed(4)}`)
    .join("\n");

  return `Retrieval eval report\nqueries: ${report.queryCount}\n\nmetrics:\n${metricLines}`;
}
