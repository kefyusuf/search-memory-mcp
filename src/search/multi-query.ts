import type { SearchResultItem } from "../cache/types.js";
import { normalizeSearchUrl } from "./fusion.js";
import { rrfRank } from "./rrf.js";

/** RRF across query variants; provenance continues to name actual providers. */
export function fuseQueryResults(resultSets: SearchResultItem[][]): SearchResultItem[] {
  const lists = resultSets.map((results) =>
    results.map((result) => ({
      ...result,
      sources: [...(result.sources ?? [result.source])],
      providerRanks: result.providerRanks ? { ...result.providerRanks } : undefined,
    })),
  );

  const ranked = rrfRank(lists, {
    key: (result) => (result.url ? normalizeSearchUrl(result.url) : null),
    dedupeWithinList: true,
    merge: (existing, incoming) => {
      existing.sources = [
        ...new Set([...(existing.sources ?? [existing.source]), ...(incoming.sources ?? [incoming.source])]),
      ];
      for (const [provider, rank] of Object.entries(incoming.providerRanks ?? {})) {
        existing.providerRanks ??= {};
        existing.providerRanks[provider] = Math.min(existing.providerRanks[provider] ?? rank, rank);
      }
    },
  });

  return ranked.map(({ item, score }) => ({ ...item, fusionScore: score }));
}
