import { parseGoogleResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";

export async function searchGoogle(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // A block (403/429) or outage must surface as an error, not as "no results".
    throw new Error(`google returned HTTP ${response.status}`);
  }

  const html = await response.text();
  // Google now answers non-JavaScript clients with a redirect to an "enable JS"
  // page (HTTP 200). That is a block, not an empty result.
  if (html.includes("/httpservice/retry/enablejs")) {
    throw new Error("google returned a JavaScript-required page");
  }
  const results = parseGoogleResults(html);
  if (results.length === 0) {
    console.error("Warning: Google returned 0 parsed results; possible CAPTCHA or DOM change.");
  }

  return results;
}
