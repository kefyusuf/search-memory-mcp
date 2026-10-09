import { parseBraveResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";

type BraveApiResponse = {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
};

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

/** Brave Search API (https://api.search.brave.com), used when BRAVE_SEARCH_API_KEY is set. */
async function searchBraveApi(query: string, locale: SearchLocale, apiKey: string): Promise<SearchResultItem[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Language": locale.acceptLanguage,
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // 401/403: invalid key; 429: rate limit or monthly quota exhausted.
    throw new Error(`brave api returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as BraveApiResponse;
  const items: SearchResultItem[] = [];
  for (const result of payload.web?.results ?? []) {
    const resultUrl = (result.url ?? "").trim();
    const title = stripTags(result.title ?? "");
    if (!resultUrl || !title) continue;
    items.push({ title, url: resultUrl, snippet: stripTags(result.description ?? ""), source: "brave" });
  }
  return items;
}

export async function searchBrave(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const apiKey = (process.env.BRAVE_SEARCH_API_KEY ?? "").trim();
  if (apiKey) return searchBraveApi(query, locale, apiKey);

  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
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
    throw new Error(`brave returned HTTP ${response.status}`);
  }

  const html = await response.text();
  return parseBraveResults(html);
}
