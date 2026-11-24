import { parseYahooResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";
import { BROWSER_USER_AGENT } from "./shared.js";

export async function searchYahoo(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const url = `https://search.yahoo.com/search?p=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // A block (403/429) or outage must surface as an error, not as "no results".
    throw new Error(`yahoo returned HTTP ${response.status}`);
  }

  return parseYahooResults(await response.text());
}
