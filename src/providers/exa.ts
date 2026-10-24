import { normalizePublishedDate } from "../documents/dates.js";
import type { SearchResultItem } from "../cache/types.js";
import type { SearchLocale } from "../search-utils.js";
import { extractSiteFilter } from "./api-query.js";

type ExaApiResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    publishedDate?: string;
    highlights?: string[];
    text?: string;
  }>;
};

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, "").trim();
}

/**
 * Exa Search API (https://api.exa.ai), used when EXA_API_KEY is set. type:auto
 * mixes neural and keyword retrieval, which is the semantic-discovery path for
 * queries that keyword indexes answer poorly.
 */
async function searchExaApi(query: string, locale: SearchLocale, apiKey: string): Promise<SearchResultItem[]> {
  const { query: cleanQuery, includeDomain } = extractSiteFilter(query);
  const body: Record<string, unknown> = {
    query: cleanQuery,
    numResults: 10,
    type: "auto",
    contents: { highlights: { numSentences: 2 } },
  };
  if (includeDomain) body.includeDomains = [includeDomain];

  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "Accept-Language": locale.acceptLanguage,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    // 401: invalid key; 429: rate limit or quota exhausted.
    throw new Error(`exa api returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as ExaApiResponse;
  const items: SearchResultItem[] = [];
  for (const result of payload.results ?? []) {
    const resultUrl = (result.url ?? "").trim();
    const title = stripTags(result.title ?? "");
    if (!resultUrl || !title) continue;
    const publishedAt = normalizePublishedDate(result.publishedDate);
    items.push({
      title,
      url: resultUrl,
      snippet: stripTags(result.highlights?.[0] ?? result.text ?? ""),
      source: "exa",
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return items;
}

export async function searchExa(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const apiKey = (process.env.EXA_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("exa api key missing: set EXA_API_KEY");
  return searchExaApi(query, locale, apiKey);
}
