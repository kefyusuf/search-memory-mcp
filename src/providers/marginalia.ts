import { parseMarginaliaResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";

/** Marginalia: an independent index that favours non-commercial, text-heavy sites. */
export async function searchMarginalia(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const url = `https://marginalia-search.com/search?query=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`marginalia returned HTTP ${response.status}`);
  }

  return parseMarginaliaResults(await response.text());
}
