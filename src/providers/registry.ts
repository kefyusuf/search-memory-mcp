import type { SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";
import type { SearchProvider } from "./base.js";
import { searchBing } from "./bing.js";
import { searchBrave } from "./brave.js";
import { searchDDG } from "./duckduckgo.js";
import { searchGoogle } from "./google.js";
import { searchMarginalia } from "./marginalia.js";
import { searchSearXng } from "./searxng.js";
import { searchYahoo } from "./yahoo.js";

type ProviderExecutor = (query: string, locale: SearchLocale) => Promise<SearchResultItem[]>;

export function buildProviders(order: string[]): SearchProvider[] {
  const registry: Partial<Record<string, ProviderExecutor>> = {
    duckduckgo: searchDDG,
    bing: searchBing,
    brave: searchBrave,
    google: searchGoogle,
    searxng: searchSearXng,
    yahoo: searchYahoo,
    marginalia: searchMarginalia,
  };

  const providers: SearchProvider[] = [];

  for (const name of order) {
    const execute = registry[name];
    if (execute) {
      providers.push({ name, execute });
      console.error(`Search provider registered: ${name}`);
    } else {
      console.error(`Unknown search provider in SEARCH_PROVIDERS: ${name}`);
    }
  }

  if (providers.length === 0) {
    console.error("No valid search providers configured. Defaulting to duckduckgo.");
    return [{ name: "duckduckgo", execute: searchDDG }];
  }

  return providers;
}
