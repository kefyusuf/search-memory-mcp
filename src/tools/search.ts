import { z } from "zod";
import { extractAnswerFromDocuments, formatSearchResults } from "../answer-extraction.js";
import type { CrossLingualEngine } from "../cache/crosslingual.js";
import type { SemanticCache } from "../cache/semantic-cache.js";
import type { SearchResultItem } from "../cache/types.js";
import { buildAnswerJson, buildSearchJson, formatToolResult, type OutputFormat } from "../format/structured-output.js";
import { formatTraceSummary, SearchTrace } from "../observability/search-trace.js";
import type { SearchProvider } from "../providers/base.js";
import type { ProviderHealthTracker } from "../providers/health.js";
import type { TokenBucket } from "../rate-limiter.js";
import { filterResultsByDate } from "../search/date-filter.js";
import { executeProviderSearch, executeSearchPlan, type ProviderAttempt } from "../search/executor.js";
import type { IntentDetector } from "../search/intent.js";
import { fuseQueryResults } from "../search/multi-query.js";
import { planSearch } from "../search/planner.js";
import { expandQuery } from "../search/query-rewrite.js";
import { rerankResults, type CrossEncoderReranker } from "../search/rerank.js";
import { filterSearchResultsByDomain, normalizeDomainFilter, resolveSearchLocale } from "../search-utils.js";
import { errorResult, rateLimitError, textResult, type ToolResult } from "./types.js";

export const SearchSchema = z.object({
  query: z.string().min(1).refine((query) => query.trim().length > 0, "Query must not be blank").describe("The search query to perform"),
  expand_query: z.boolean().optional().describe("If true, search the original query plus up to two rewritten variants and fuse results. Default false; increases provider requests."),
  deep: z.boolean().optional().describe("If true, fetch the top result pages and extract a direct answer. If false (default), return a ranked list of results quickly without page fetching."),
  max_results: z.number().int().min(1).max(10).optional().describe("Maximum number of results to return (1-10, default 5)."),
  domain: z.string().min(1).optional().describe("Optional domain filter, for example react.dev or github.com."),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive lower date bound (YYYY-MM-DD). Results without a detectable date are kept."),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive upper date bound (YYYY-MM-DD). Results without a detectable date are kept."),
  format: z.enum(["text", "json"]).optional().describe("Response format. text (default) for readable Markdown-like output, json for machine-readable structured results."),
  strategy: z.enum(["fallback", "aggregate", "auto"]).optional().describe("Search execution strategy. fallback tries providers in order and stops at the first success. aggregate queries all available providers and fuses results with Reciprocal Rank Fusion. auto detects search intent and selects a configured-provider plan before using the existing fallback or aggregate execution path."),
});

export type SearchTraceEntry = { query: string; totalMs: number; cache?: string; strategy?: string; resultCount?: number };

/** Bounded in-process history of recent searches, reported by server_status. */
export class SearchTraceHistory {
  private readonly entries: SearchTraceEntry[] = [];

  constructor(private readonly limit = 20) {}

  push(entry: SearchTraceEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
  }

  /** Newest first. */
  recent(count = this.limit): SearchTraceEntry[] {
    return [...this.entries].reverse().slice(0, count);
  }
}

export type FetchedPage = { url: string; title: string; content: string };

function describeAttempt(attempt: ProviderAttempt): string {
  switch (attempt.status) {
    case "error": return `${attempt.provider} failed (${attempt.error || "unknown error"})`;
    case "empty": return `${attempt.provider} returned no results`;
    case "backoff": return `${attempt.provider} skipped (temporarily disabled after repeated failures)`;
    default: return `${attempt.provider} returned ${attempt.resultCount} results`;
  }
}

/** A short note for text output when some providers did not contribute. */
function providerNotes(attempts: ProviderAttempt[]): string {
  const problems = attempts.filter((attempt) => attempt.status !== "ok");
  return problems.length > 0 ? `\n\nProvider notes: ${problems.map(describeAttempt).join("; ")}.` : "";
}

/** Getters are read per call so tests and runtime reconfiguration can swap them. */
export type SearchToolDeps = {
  searchLimiter: TokenBucket;
  cache: () => SemanticCache;
  providers: () => SearchProvider[];
  healthTracker: () => ProviderHealthTracker;
  intentDetector: IntentDetector;
  crossLingual: CrossLingualEngine | null;
  reranker: CrossEncoderReranker | null;
  fetchPage: (url: string) => Promise<FetchedPage | null>;
  traces: SearchTraceHistory;
};

export function createSearchHandler(deps: SearchToolDeps) {
  const { searchLimiter, intentDetector, crossLingual, reranker, traces } = deps;

  const finalizeTrace = (trace: SearchTrace, resultCount: number): void => {
    const snapshot = trace.toJSON();
    traces.push({
      query: snapshot.query,
      totalMs: snapshot.totalMs,
      cache: String(snapshot.meta.cache ?? ""),
      strategy: String(snapshot.meta.strategy ?? ""),
      resultCount,
    });
    if (process.env.TRACE_SEARCHES === "true" || process.env.TRACE_SEARCHES === "1") {
      console.error(formatTraceSummary(trace));
    }
  };

  const rankResults = (query: string, results: SearchResultItem[], limit: number) => reranker
    ? rerankResults(query, results, { scorer: reranker.asScorer(), limit })
    : deps.cache().reRankResults(query, results, limit);

  const buildDeepResponse = async (query: string, results: SearchResultItem[], format: OutputFormat): Promise<ToolResult> => {
    const urls = results.slice(0, 2).map((result) => result.url).filter(Boolean);
    const pages = await Promise.all(urls.map((url) => deps.fetchPage(url)));
    const validPages = pages.filter((page) => page !== null);

    if (validPages.length > 0) {
      const answer = extractAnswerFromDocuments(
        query,
        validPages.map((page) => ({ title: page.title, url: page.url, content: page.content })),
      );
      const payload = buildAnswerJson(query, answer, validPages.map((page) => ({ url: page.url, title: page.title })));
      return textResult(format === "json" ? formatToolResult(payload, "json") : answer, payload);
    }

    const rankedResults = await deps.cache().reRankResults(query, results, results.length);
    const payload = buildSearchJson(query, rankedResults, { deep: true, pagesFetched: 0 });
    return textResult(format === "json"
      ? formatToolResult(payload, "json")
      : formatSearchResults(query, rankedResults), payload);
  };

  return async (args: unknown): Promise<ToolResult> => {
    const limited = rateLimitError(searchLimiter, "web_search", "RATE_LIMIT_SEARCH_PER_MIN", "10");
    if (limited) return limited;

    const { query, expand_query = false, deep = false, max_results = 5, domain, from_date, to_date, format = "text", strategy = "fallback" } = SearchSchema.parse(args);
    const outputFormat: OutputFormat = format;
    const cache = deps.cache();
    const providers = deps.providers();
    const normalizedDomain = normalizeDomainFilter(domain);
    const cacheKey = normalizedDomain ? `${query} domain:${normalizedDomain}` : query;
    const detectedLanguage = crossLingual
      ? await crossLingual.detectLanguage(query).catch(() => null)
      : null;
    const queryLocale = resolveSearchLocale(query, detectedLanguage);

    // Resolve auto planning up front so cache lookups can be namespaced by the
    // actual plan instead of bypassing the cache for non-fallback strategies.
    let searchPlan: ReturnType<typeof planSearch> | null = null;
    if (strategy === "auto") {
      const detection = await intentDetector.detect(query);
      searchPlan = planSearch({
        intent: detection.intent,
        configuredProviderNames: providers.map((provider) => provider.name),
      });
      console.error(`Auto search intent: ${detection.intent} (${detection.source})`);
      console.error(
        `Auto search plan: ${searchPlan.strategy} [${searchPlan.primaryProviderNames.join(", ")}]` +
        (searchPlan.fallbackProviderNames.length > 0
          ? `, fallback [${searchPlan.fallbackProviderNames.join(", ")}]`
          : "")
      );
    }

    const baseCacheNamespace = searchPlan
      ? `auto:${searchPlan.profileVersion}:${searchPlan.intent}:${searchPlan.primaryProviderNames.join(",")}`
      : strategy;
    const executionNamespace = expand_query ? `${baseCacheNamespace}:expand:v1` : baseCacheNamespace;
    // Filters are exact cache constraints, not semantic similarity signals.
    const cacheNamespace = normalizedDomain || from_date || to_date
      ? `${executionNamespace}:filters:v1:${JSON.stringify([normalizedDomain ?? "", from_date ?? "", to_date ?? ""])}`
      : executionNamespace;
    const applyFilters = (candidates: SearchResultItem[]) => filterResultsByDate(
      filterSearchResultsByDomain(candidates, normalizedDomain),
      from_date || to_date ? { from: from_date, to: to_date } : undefined,
      { keepUndated: true },
    );
    const queries = expand_query
      ? expandQuery(query, { maxVariants: 2, context: { intent: searchPlan?.intent } })
      : [query];

    const trace = new SearchTrace(query);
    trace.setMeta({
      strategy,
      domain: normalizedDomain ?? "",
      max_results,
      deep,
      cache_namespace: cacheNamespace,
      expand_query,
      query_variants: queries.length,
    });
    if (searchPlan) {
      trace.setMeta({ intent: searchPlan.intent, plan: searchPlan.strategy });
    }

    trace.startStage("cache.lookup");
    const cacheCandidates = await cache.get(cacheKey, cacheNamespace);
    const cached = cacheCandidates === null ? null : applyFilters(cacheCandidates);

    if (cached !== null && cached.length > 0) {
      trace.endStage("cache.lookup", { status: "ok", resultCount: cached.length });
      trace.setMeta({ cache: "hit" });
      finalizeTrace(trace, cached.length);
      console.error(`Semantic cache hit for query: ${query} [${cacheNamespace}]`);
      if (deep) {
        return buildDeepResponse(query, cached.slice(0, max_results), outputFormat);
      }
      const limitedResults = (await rankResults(query, cached, max_results)).slice(0, max_results);
      const payload = buildSearchJson(query, limitedResults, { strategy, cache: "hit" });
      return textResult(outputFormat === "json"
        ? formatToolResult(payload, "json")
        : formatSearchResults(query, limitedResults), payload);
    }

    trace.endStage("cache.lookup", { status: "empty", error: "miss" });
    trace.setMeta({ cache: "miss" });

    const resultSets: SearchResultItem[][] = [];
    const attempts: ProviderAttempt[] = [];
    const onAttempt = (attempt: ProviderAttempt) => { attempts.push(attempt); };
    trace.startStage("providers");
    for (const variant of queries) {
      const providerQuery = normalizedDomain ? `${variant} site:${normalizedDomain}` : variant;
      resultSets.push(searchPlan
        ? await executeSearchPlan({
            providers,
            query: providerQuery,
            locale: queryLocale,
            plan: searchPlan,
            healthTracker: deps.healthTracker(),
            onAttempt,
          })
        : await executeProviderSearch({
            providers,
            query: providerQuery,
            locale: queryLocale,
            strategy: strategy === "aggregate" ? "aggregate" : "fallback",
            healthTracker: deps.healthTracker(),
            onAttempt,
          }));
    }
    const rawResults = resultSets.length > 1 ? fuseQueryResults(resultSets) : resultSets[0];
    trace.endStage("providers", {
      status: rawResults.length > 0 ? "ok" : "empty",
      resultCount: rawResults.length,
    });

    const results = applyFilters(rawResults);

    if (results.length === 0) {
      trace.endStage("filters", { status: "empty", resultCount: 0 });
      finalizeTrace(trace, 0);
      return errorResult(normalizedDomain
        ? `No results matched the domain filter "${normalizedDomain}". Try a broader search or fetch_content with a direct URL.`
        : `Web search is currently unavailable (all providers returned no results${attempts.length > 0 ? `: ${attempts.map(describeAttempt).join("; ")}` : ""}). Try using fetch_content with a direct URL instead, or retry the search later.`);
    }

    trace.endStage("filters", { status: "ok", resultCount: results.length });
    // Preserve provider candidates; reapply filters on every hit before output/fetch.
    await cache.set(cacheKey, rawResults, cacheNamespace);

    if (!deep) {
      const ranked = await rankResults(query, results, max_results);
      finalizeTrace(trace, ranked.length);
      const limitedResults = ranked.slice(0, max_results);
      const payload = { ...buildSearchJson(query, limitedResults, { strategy, cache: "miss", resultCount: limitedResults.length }), providerAttempts: attempts };
      return textResult(outputFormat === "json"
        ? formatToolResult(payload, "json")
        : formatSearchResults(query, limitedResults) + providerNotes(attempts), payload);
    }

    finalizeTrace(trace, results.length);
    return buildDeepResponse(query, results.slice(0, max_results), outputFormat);
  };
}
