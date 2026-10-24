import { normalizePublishedDate } from "../documents/dates.js";
import { detectHeuristicIntent } from "../search/heuristics.js";
import type { SearchResultItem } from "../cache/types.js";
import type { SearchLocale } from "../search-utils.js";
import { extractSiteFilter } from "./api-query.js";

type TavilyApiResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
  }>;
};

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

/**
 * Tavily Search API (https://api.tavily.com), used when TAVILY_API_KEY is set.
 * News-intent queries request the news topic so fresh reporting ranks first;
 * the heuristic check is pure text matching and never loads a model.
 */
async function searchTavilyApi(query: string, locale: SearchLocale, apiKey: string): Promise<SearchResultItem[]> {
  const { query: cleanQuery, includeDomain } = extractSiteFilter(query);
  const body: Record<string, unknown> = {
    query: cleanQuery,
    max_results: 10,
  };
  if (detectHeuristicIntent(cleanQuery) === "news") body.topic = "news";
  if (includeDomain) body.include_domains = [includeDomain];

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept-Language": locale.acceptLanguage,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // 401: invalid key; 429/432: rate limit or quota exhausted.
    throw new Error(`tavily api returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as TavilyApiResponse;
  const items: SearchResultItem[] = [];
  for (const result of payload.results ?? []) {
    const resultUrl = (result.url ?? "").trim();
    const title = stripTags(result.title ?? "");
    if (!resultUrl || !title) continue;
    const publishedAt = normalizePublishedDate(result.published_date);
    items.push({
      title,
      url: resultUrl,
      snippet: stripTags(result.content ?? ""),
      source: "tavily",
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return items;
}

export async function searchTavily(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const apiKey = (process.env.TAVILY_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("tavily api key missing: set TAVILY_API_KEY");
  return searchTavilyApi(query, locale, apiKey);
}
