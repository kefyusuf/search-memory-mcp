import type { SearchIntent } from "../search/intent.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Entries cached before TTLs were stored keep the original one-hour limit. */
export const DEFAULT_SEARCH_CACHE_TTL_MS = HOUR;

const SEARCH_CACHE_TTL_MS: Record<SearchIntent, number> = {
  news: 15 * MINUTE,
  shopping: HOUR,
  local: HOUR,
  commercial: HOUR,
  general: DEFAULT_SEARCH_CACHE_TTL_MS,
  technical: 24 * HOUR,
  research: 24 * HOUR,
  navigational: 24 * HOUR,
};

/** How long cached search results stay valid: short for news, longer for reference queries. */
export function searchCacheTtlMs(intent: SearchIntent): number {
  return SEARCH_CACHE_TTL_MS[intent];
}
