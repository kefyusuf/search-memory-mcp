import { parseDuckDuckGoResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";
import { BROWSER_USER_AGENT } from "./shared.js";

export async function searchDDG(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // A block (403/429) or outage must surface as an error, not as "no results".
    throw new Error(`duckduckgo returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseDuckDuckGoResults(html);
}
