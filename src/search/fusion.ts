import type { SearchResultItem } from "../cache/types.js";
import { rrfRank } from "./rrf.js";

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
  const lists = providerResults.map(({ provider, results }) =>
    results.map((result, index) => ({
      ...result,
      source: result.source || provider,
      sources: [provider],
      providerRanks: { [provider]: index + 1 },
    })),
  );

  const ranked = rrfRank(lists, {
    key: (result) => (result.url ? normalizeSearchUrl(result.url) || null : null),
    k: rrfK,
    dedupeWithinList: true,
    merge: (existing, incoming) => {
      const provider = incoming.sources?.[0];
      const sources = existing.sources ?? [existing.source];
      if (provider && !sources.includes(provider)) {
        sources.push(provider);
      }
      existing.sources = sources;
      existing.providerRanks = {
        ...(existing.providerRanks ?? {}),
        ...incoming.providerRanks,
      };
    },
  });

  return ranked.map(({ item, score }) => ({ ...item, fusionScore: score }));
}
