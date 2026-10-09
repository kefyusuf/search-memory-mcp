import type { SearchResultItem } from "../cache/types.js";
import type { SearchProvider } from "../providers/base.js";
import type { ProviderHealthTracker } from "../providers/health.js";
import { filterSearchResultsByDomain, type SearchLocale } from "../search-utils.js";
import { fuseSearchResults } from "./fusion.js";
import type { SearchPlan } from "./planner.js";

export type SearchStrategy = "fallback" | "aggregate";
export type SearchResultFilter = (results: SearchResultItem[]) => SearchResultItem[];

/** One provider call, reported so responses can explain empty or partial results. */
export type ProviderAttempt = {
  provider: string;
  status: "ok" | "empty" | "error" | "backoff";
  resultCount: number;
  durationMs: number;
  error?: string;
};
export type ProviderAttemptListener = (attempt: ProviderAttempt) => void;

const MAX_ATTEMPT_ERROR_LENGTH = 160;

export type ExecuteProviderSearchOptions = {
  providers: SearchProvider[];
  query: string;
  locale: SearchLocale;
  strategy: SearchStrategy;
  healthTracker: ProviderHealthTracker;
  resultFilter?: SearchResultFilter;
  onAttempt?: ProviderAttemptListener;
};

export type ExecuteSearchPlanOptions = {
  providers: SearchProvider[];
  query: string;
  locale: SearchLocale;
  plan: SearchPlan;
  healthTracker: ProviderHealthTracker;
  resultFilter?: SearchResultFilter;
  onAttempt?: ProviderAttemptListener;
};

function dedupeProviderResults(results: SearchResultItem[]): SearchResultItem[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (!result.url || seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function uniqueProvidersByName(providers: SearchProvider[]): SearchProvider[] {
  const seen = new Set<string>();
  return providers.filter((provider) => {
    if (seen.has(provider.name)) return false;
    seen.add(provider.name);
    return true;
  });
}

function providersInPlanOrder(
  providers: SearchProvider[],
  providerNames: string[],
): SearchProvider[] {
  const byName = new Map<string, SearchProvider>();
  for (const provider of providers) {
    if (!byName.has(provider.name)) byName.set(provider.name, provider);
  }

  return providerNames
    .map((name) => byName.get(name))
    .filter((provider): provider is SearchProvider => provider !== undefined);
}

function applyResultFilter(
  results: SearchResultItem[],
  resultFilter?: SearchResultFilter,
): SearchResultItem[] {
  return resultFilter ? resultFilter(results) : results;
}

function inferSiteResultFilter(query: string): SearchResultFilter | undefined {
  const match = query.match(/(?:^|\s)site:([^\s]+)\s*$/i);
  const domain = match?.[1];
  return domain
    ? (results) => filterSearchResultsByDomain(results, domain)
    : undefined;
}

function attemptError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  return message.slice(0, MAX_ATTEMPT_ERROR_LENGTH);
}

async function runProvider(
  provider: SearchProvider,
  query: string,
  locale: SearchLocale,
  healthTracker: ProviderHealthTracker,
  onAttempt?: ProviderAttemptListener,
): Promise<SearchResultItem[]> {
  const startedAt = Date.now();
  const report = (status: ProviderAttempt["status"], resultCount: number, error?: string) => {
    onAttempt?.({
      provider: provider.name,
      status,
      resultCount,
      durationMs: Date.now() - startedAt,
      ...(error === undefined ? {} : { error }),
    });
  };

  if (!healthTracker.isAvailable(provider.name)) {
    console.error(`Skipping provider ${provider.name}: provider is in backoff window`);
    report("backoff", 0);
    return [];
  }

  try {
    const results = await provider.execute(query, locale);
    const deduped = dedupeProviderResults(results);

    if (deduped.length === 0) {
      healthTracker.record(provider.name, false);
      console.error(`Provider ${provider.name} returned 0 parsed results`);
      report("empty", 0);
      return [];
    }

    if (deduped.length < results.length) {
      console.error(`Deduplicated ${results.length - deduped.length} duplicate URLs from ${provider.name}`);
    }

    healthTracker.record(provider.name, true);
    console.error(`Provider ${provider.name} returned ${deduped.length} results`);
    report("ok", deduped.length);
    return deduped;
  } catch (error) {
    healthTracker.record(provider.name, false);
    console.error(
      `Provider ${provider.name} error:`,
      error instanceof Error ? error.message : String(error)
    );
    report("error", 0, attemptError(error));
    return [];
  }
}

export async function executeProviderSearch({
  providers,
  query,
  locale,
  strategy,
  healthTracker,
  resultFilter,
  onAttempt,
}: ExecuteProviderSearchOptions): Promise<SearchResultItem[]> {
  if (strategy === "fallback") {
    for (const provider of providers) {
      const results = applyResultFilter(
        await runProvider(provider, query, locale, healthTracker, onAttempt),
        resultFilter,
      );
      if (results.length > 0) return results;
    }
    return [];
  }

  const aggregateProviders = uniqueProvidersByName(providers);
  const settled = await Promise.all(
    aggregateProviders.map(async (provider) => ({
      provider: provider.name,
      results: applyResultFilter(
        await runProvider(provider, query, locale, healthTracker, onAttempt),
        resultFilter,
      ),
    }))
  );

  return fuseSearchResults(
    settled.filter(({ results }) => results.length > 0)
  );
}

export async function executeSearchPlan({
  providers,
  query,
  locale,
  plan,
  healthTracker,
  resultFilter,
  onAttempt,
}: ExecuteSearchPlanOptions): Promise<SearchResultItem[]> {
  const effectiveResultFilter = resultFilter ?? inferSiteResultFilter(query);
  const primaryProviders = providersInPlanOrder(providers, plan.primaryProviderNames);
  const primaryResults = await executeProviderSearch({
    providers: primaryProviders,
    query,
    locale,
    strategy: plan.strategy,
    healthTracker,
    resultFilter: effectiveResultFilter,
    onAttempt,
  });

  if (
    plan.strategy === "fallback" ||
    primaryResults.length > 0 ||
    plan.fallbackProviderNames.length === 0
  ) {
    return primaryResults;
  }

  const fallbackProviders = providersInPlanOrder(providers, plan.fallbackProviderNames);
  return executeProviderSearch({
    providers: fallbackProviders,
    query,
    locale,
    strategy: "fallback",
    healthTracker,
    resultFilter: effectiveResultFilter,
    onAttempt,
  });
}
