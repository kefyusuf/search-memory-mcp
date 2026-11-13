import type { SearchResultItem } from "../cache/types.js";

export type ProviderResultSet = {
  provider: string;
  results: SearchResultItem[];
};

const TRACKING_PARAM = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i;
const DEFAULT_RRF_K = 60;

export function normalizeSearchUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const routeFragment = parsed.hash.startsWith("#/") || parsed.hash.startsWith("#!") ? parsed.hash : "";
    const pathname = parsed.pathname === "/" ? (routeFragment ? "/" : "") : parsed.pathname.replace(/\/+$/, "");

    const params = Array.from(parsed.searchParams.entries())
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([keyA], [keyB]) => keyA.localeCompare(keyB));

    const search = new URLSearchParams();
    for (const [key, value] of params) {
      search.append(key, value);
    }

    const query = search.toString();
    return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}${pathname}${query ? `?${query}` : ""}${routeFragment}`;
  } catch {
    return rawUrl.trim();
  }
}

export function fuseSearchResults(
  providerResults: ProviderResultSet[],
  rrfK: number = DEFAULT_RRF_K,
): SearchResultItem[] {
  const fused = new Map<string, SearchResultItem>();

  for (const { provider, results } of providerResults) {
    const seenForProvider = new Set<string>();

    results.forEach((result, index) => {
      if (!result.url) return;

      const normalizedUrl = normalizeSearchUrl(result.url);
      if (!normalizedUrl || seenForProvider.has(normalizedUrl)) return;
      seenForProvider.add(normalizedUrl);

      const rank = index + 1;
      const contribution = 1 / (rrfK + rank);
      const existing = fused.get(normalizedUrl);

      if (!existing) {
        fused.set(normalizedUrl, {
          ...result,
          source: result.source || provider,
          sources: [provider],
          providerRanks: { [provider]: rank },
          fusionScore: contribution,
        });
        return;
      }

      const sources = existing.sources ?? [existing.source];
      if (!sources.includes(provider)) {
        sources.push(provider);
      }

      existing.sources = sources;
      existing.providerRanks = {
        ...(existing.providerRanks ?? {}),
        [provider]: rank,
      };
      existing.fusionScore = (existing.fusionScore ?? 0) + contribution;
    });
  }

  return Array.from(fused.values()).sort((a, b) => (b.fusionScore ?? 0) - (a.fusionScore ?? 0));
}
