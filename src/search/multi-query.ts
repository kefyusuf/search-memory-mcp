import type { SearchResultItem } from "../cache/types.js";
import { normalizeSearchUrl } from "./fusion.js";

/** RRF across query variants; provenance continues to name actual providers. */
export function fuseQueryResults(resultSets: SearchResultItem[][]): SearchResultItem[] {
  const fused = new Map<string, SearchResultItem>();
  for (const results of resultSets) {
    const seen = new Set<string>();
    results.forEach((result, index) => {
      if (!result.url) return;
      const key = normalizeSearchUrl(result.url);
      if (seen.has(key)) return;
      seen.add(key);
      const contribution = 1 / (60 + index + 1);
      const existing = fused.get(key);
      if (!existing) {
        fused.set(key, {
          ...result,
          sources: [...(result.sources ?? [result.source])],
          providerRanks: result.providerRanks ? { ...result.providerRanks } : undefined,
          fusionScore: contribution,
        });
        return;
      }
      existing.fusionScore = (existing.fusionScore ?? 0) + contribution;
      existing.sources = [...new Set([
        ...(existing.sources ?? [existing.source]),
        ...(result.sources ?? [result.source]),
      ])];
      for (const [provider, rank] of Object.entries(result.providerRanks ?? {})) {
        existing.providerRanks ??= {};
        existing.providerRanks[provider] = Math.min(existing.providerRanks[provider] ?? rank, rank);
      }
    });
  }
  return [...fused.values()].sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0));
}
