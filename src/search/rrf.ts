export type RrfRankOptions<T> = {
  /** null skips the item; an empty string is a valid key. */
  key: (item: T) => string | null;
  k?: number;
  dedupeWithinList?: boolean;
  merge?: (existing: T, incoming: T, rank: number) => void;
  limit?: number;
};

const DEFAULT_K = 60;

/**
 * Reciprocal Rank Fusion skeleton: accumulates 1/(k+rank) per key across lists
 * and returns entries sorted by fused score. Callers own first-occurrence shape
 * (pre-map items) and duplicate metadata semantics (merge callback).
 */
export function rrfRank<T extends object>(
  lists: ReadonlyArray<ReadonlyArray<T>>,
  options: RrfRankOptions<T>,
): Array<{ item: T; score: number }> {
  const k = options.k ?? DEFAULT_K;
  const entries = new Map<string, { item: T; score: number }>();

  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((item, index) => {
      const key = options.key(item);
      if (key === null) return;
      if (options.dedupeWithinList && seen.has(key)) return;
      seen.add(key);

      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = entries.get(key);
      if (!existing) {
        entries.set(key, { item: { ...item }, score: contribution });
        return;
      }
      existing.score += contribution;
      options.merge?.(existing.item, item, rank);
    });
  }

  const ranked = [...entries.values()].sort((a, b) => b.score - a.score);
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}
