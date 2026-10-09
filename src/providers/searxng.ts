import type { SearchResultItem } from "../cache/types.js";
import type { SearchLocale } from "../search-utils.js";

type SearXngJsonResult = {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
  engines?: string[];
};

type SearXngJsonResponse = {
  results?: SearXngJsonResult[];
};

function resolveBaseUrl(): string | null {
  const raw = (process.env.SEARXNG_BASE_URL || "").trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

function parseSearXngResults(payload: SearXngJsonResponse): SearchResultItem[] {
  const results = payload.results ?? [];
  const items: SearchResultItem[] = [];

  for (const result of results) {
    const url = (result.url || "").trim();
    const title = (result.title || "").trim();
    if (!url || !title) continue;

    items.push({
      title,
      url,
      snippet: (result.content || "").trim(),
      source: "searxng",
    });
  }

  return items;
}

/**
 * SearXNG meta-search via its JSON API. Requires SEARXNG_BASE_URL and a
 * SearXNG instance with the JSON format enabled (self-hosted or a trusted
 * public instance). No API key is needed.
 */
export async function searchSearXng(query: string, locale: SearchLocale): Promise<SearchResultItem[]> {
  const baseUrl = resolveBaseUrl();
  if (!baseUrl) {
    console.error("SearXNG provider skipped: SEARXNG_BASE_URL is not set");
    return [];
  }

  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", locale.market.split("-")[0] || "en");

  const response = await fetch(url, {
    headers: {
      "User-Agent": "search-memory-mcp/1.0",
      "Accept": "application/json",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`searxng returned HTTP ${response.status}`);
  }

  let payload: SearXngJsonResponse;
  try {
    payload = (await response.json()) as SearXngJsonResponse;
  } catch (error) {
    console.error("SearXNG response was not valid JSON:", error);
    return [];
  }

  return parseSearXngResults(payload);
}
