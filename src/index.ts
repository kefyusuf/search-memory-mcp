#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { chromium, Browser, BrowserContext } from "playwright";
import { z } from "zod";
import { extractAnswerFromDocuments, formatSearchResults } from "./answer-extraction.js";
import { validatePublicHttpUrl } from "./ssrf.js";
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import type { SearchResultItem } from "./cache/types.js";
import { createSearchRateLimiter, createFetchRateLimiter, TokenBucket } from "./rate-limiter.js";
import type { SearchProvider } from "./providers/base.js";
import { ProviderHealthTracker } from "./providers/health.js";
import { buildProviders } from "./providers/registry.js";
import {
  executeProviderSearch as executeSearch,
  executeSearchPlan,
  type SearchStrategy,
} from "./search/executor.js";
import { SearchIntentDetector, type IntentDetector } from "./search/intent.js";
import { planSearch } from "./search/planner.js";
import { ROUTING_PROFILE_VERSION } from "./search/profiles.js";
import {
  filterSearchResultsByDomain,
  normalizeDomainFilter,
  resolveSearchLocale,
  type SearchLocale,
} from "./search-utils.js";
import { filterResultsByDate } from "./search/date-filter.js";
import { CrossEncoderReranker, rerankResults } from "./search/rerank.js";
import { ContentFetcher } from "./fetch-module.js";
import { KnowledgeIndex, type KnowledgeChunkHit } from "./knowledge/index-store.js";
import { SessionMemory } from "./memory/session-memory.js";
import { SearchTrace, formatTraceSummary } from "./observability/search-trace.js";
import { expandQuery, rewriteQuery } from "./search/query-rewrite.js";
import { fuseQueryResults } from "./search/multi-query.js";
import {
  buildAnswerJson,
  buildIndexHitJson,
  buildSearchJson,
  formatToolResult,
  type OutputFormat,
} from "./format/structured-output.js";
import { EntityGraph } from "./graph/entity-graph.js";
import { createLocalRequestContext, InvocationError } from "./runtime/request-context.js";
import { ToolDispatcher } from "./runtime/tool-dispatcher.js";

// --- Types & Schemas ---

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

const FetchSchema = z.object({
  url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
  force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});

const IngestDocumentSchema = z.object({
  content: z.string().min(1).describe("Document text to index (Markdown or plain text)."),
  title: z.string().optional().describe("Optional document title."),
  source: z.string().optional().describe("Optional source identifier, usually a URL or file path."),
  category: z.string().optional().describe("Optional category label, e.g. docs, notes, research."),
});

const IndexUrlSchema = z.object({
  url: z.string().url().describe("URL to fetch and index into the local knowledge base."),
  title: z.string().optional().describe("Optional title override for the indexed document."),
  force_refresh: z.boolean().optional().describe("If true, bypass content cache when fetching."),
});

const SearchIndexSchema = z.object({
  query: z.string().min(1).describe("Hybrid search query over the local knowledge index."),
  max_results: z.number().int().min(1).max(20).optional().describe("Maximum chunks to return (1-20, default 5)."),
  source: z.string().optional().describe("Optional source filter, usually a URL or file path."),
  format: z.enum(["text", "json"]).optional().describe("Response format: text (default) or json."),
});

const RememberSchema = z.object({
  text: z.string().min(1).describe("Short fact or note to remember for later turns."),
  topic: z.string().optional().describe("Optional topic label for grouping."),
  tags: z.array(z.string()).optional().describe("Optional tags for search."),
  session: z.string().optional().describe("Optional session id to scope the note."),
});

const RecallSchema = z.object({
  query: z.string().optional().describe("Optional search text. Omit to list recent notes."),
  topic: z.string().optional().describe("Optional topic filter."),
  session: z.string().optional().describe("Optional session filter."),
  limit: z.number().int().min(1).max(50).optional().describe("Maximum notes to return (default 10)."),
});

const ForgetSchema = z.object({
  id: z.string().min(1).describe("Note id to delete."),
});

// --- Env Configuration ---

function getEnvArray(key: string, defaultVal: string): string[] {
  const raw = process.env[key] || defaultVal;
  return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function getEnv(key: string, defaultVal: string): string {
  return process.env[key] || defaultVal;
}

function getEnvBool(key: string, defaultVal: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultVal;
  return raw === "true" || raw === "1";
}

// --- Server Implementation ---

export class WebSearchServer {
  private server: Server;
  private dispatcher: ToolDispatcher<Awaited<ReturnType<WebSearchServer["handleSearch"]>>>;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private cache: SemanticCache;
  private crossLingual: CrossLingualEngine | null = null;
  private searchLimiter: TokenBucket;
  private fetchLimiter: TokenBucket;
  private providers: SearchProvider[] = [];
  private healthTracker = new ProviderHealthTracker();
  private enableCrosslingual: boolean;
  private fetchWaitUntil: "domcontentloaded" | "networkidle";
  private cacheDbPath: string;
  private contentFetcher: ContentFetcher;
  private intentDetector: IntentDetector;
  private knowledgeIndex: KnowledgeIndex;
  private embeddingProvider: TransformersEmbeddingProvider;
  private reranker: CrossEncoderReranker | null = null;
  private sessionMemory: SessionMemory;
  private entityGraph: EntityGraph;
  private readonly recentTraces: Array<{ query: string; totalMs: number; cache?: string; strategy?: string; resultCount?: number }> = [];
  private readonly maxTraceHistory = 20;
  private readonly startedAt = Date.now();

  constructor(intentDetector: IntentDetector = new SearchIntentDetector()) {
    this.server = new Server(
      {
        name: "search-memory-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.enableCrosslingual = getEnvBool("ENABLE_CROSSLINGUAL", false);
    this.fetchWaitUntil = getEnv("FETCH_WAIT_UNTIL", "networkidle") === "domcontentloaded" ? "domcontentloaded" : "networkidle";
    this.cacheDbPath = getEnv("CACHE_DB_PATH", "websearch_cache.db");
    this.intentDetector = intentDetector;

    // Initialize Semantic Cache with SQLite for persistence. The router and content
    // cache share one detector so ambiguous requests do not create duplicate models.
    const embeddingProvider = new TransformersEmbeddingProvider();
    this.embeddingProvider = embeddingProvider;
    const vectorStore = new SQLiteVectorStore(this.cacheDbPath);
    this.cache = new SemanticCache(embeddingProvider, vectorStore, 0.75, this.intentDetector);
    this.knowledgeIndex = new KnowledgeIndex(this.cacheDbPath);
    this.sessionMemory = new SessionMemory(this.cacheDbPath, {
      maxNotes: parseInt(getEnv("MEMORY_MAX_NOTES", "500"), 10) || 500,
    });
    this.entityGraph = new EntityGraph(this.cacheDbPath);

    if (getEnvBool("ENABLE_RERANKER", false)) {
      this.reranker = new CrossEncoderReranker();
      console.error("Cross-encoder reranker enabled (models download on first use).");
    }
    const cleanupIntervalHours = parseInt(getEnv("CACHE_CLEANUP_INTERVAL_HOURS", "24"), 10);
    const cleanupIntervalMs = (isNaN(cleanupIntervalHours) || cleanupIntervalHours <= 0 ? 24 : cleanupIntervalHours) * 60 * 60 * 1000;
    setInterval(() => {
      const deleted = this.cache.deleteExpiredContent();
      if (deleted > 0) console.error(`Cache cleanup: removed ${deleted} expired content entries`);
    }, cleanupIntervalMs).unref();

    if (this.enableCrosslingual) {
      this.crossLingual = new CrossLingualEngine();
    }

    this.searchLimiter = createSearchRateLimiter();
    this.fetchLimiter = createFetchRateLimiter();
    this.contentFetcher = new ContentFetcher({
      cache: this.cache,
      getBrowserContext: () => this.getBrowserContext(),
      fetchWaitUntil: this.fetchWaitUntil,
      detectIntent: this.enableCrosslingual
        ? (text) => this.cache.detectIntent(text)
        : null,
    });

    this.setupProviders();
    // These stores and resource limits are process-local. Hosted execution stays
    // closed until each handler has tenant-scoped dependencies.
    this.dispatcher = new ToolDispatcher({
      web_search: { permission: "search:read", modes: ["local"], handler: (args) => this.handleSearch(args) },
      fetch_content: { permission: "content:read", modes: ["local"], handler: (args) => this.handleFetch(args) },
      server_status: { permission: "status:read", modes: ["local"], handler: () => this.handleStatus() },
      ingest_document: { permission: "knowledge:write", modes: ["local"], handler: (args) => this.handleIngestDocument(args) },
      index_url: { permission: "knowledge:write", modes: ["local"], handler: (args) => this.handleIndexUrl(args) },
      search_index: { permission: "knowledge:read", modes: ["local"], handler: (args) => this.handleSearchIndex(args) },
      list_index: { permission: "knowledge:read", modes: ["local"], handler: (args) => this.handleListIndex(args) },
      remember: { permission: "memory:write", modes: ["local"], handler: (args) => this.handleRemember(args) },
      recall: { permission: "memory:read", modes: ["local"], handler: (args) => this.handleRecall(args) },
      forget: { permission: "memory:write", modes: ["local"], handler: (args) => this.handleForget(args) },
      find_related: { permission: "knowledge:read", modes: ["local"], handler: (args) => this.handleFindRelated(args) },
    });
    this.setupTools();
    this.setupShutdownHandlers();
  }

  private setupProviders() {
    const order = getEnvArray("SEARCH_PROVIDERS", "duckduckgo,bing");
    this.providers = buildProviders(order);
  }

  private async getBrowser() {
    if (!this.browser) {
      console.error("Launching persistent browser instance...");
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  private async getBrowserContext(): Promise<BrowserContext> {
    if (!this.browserContext) {
      const browser = await this.getBrowser();
      this.browserContext = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
      console.error("Persistent browser context created.");
    }
    return this.browserContext;
  }

  private setupShutdownHandlers() {
    const shutdown = async () => {
      console.error("Shutting down Search Memory MCP Server...");
      if (this.browserContext) {
        try { await this.browserContext.close(); } catch {}
        this.browserContext = null;
      }
      if (this.browser) {
        try { await this.browser.close(); } catch {}
        this.browser = null;
      }
      this.contentFetcher.close();
      this.cache.close();
      this.knowledgeIndex.close();
      this.sessionMemory.close();
      this.entityGraph.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("SIGHUP", shutdown);
  }

  private setupTools() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "web_search",
          description: "Search the web and return results. Use domain to restrict results to a site. Use strategy=aggregate for all configured providers, or strategy=auto for intent-aware provider planning. Use deep=true to fetch pages and extract a direct answer (slower). Use deep=false (default) for a quick ranked list of URLs and snippets.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "The search query" },
              expand_query: { type: "boolean", description: "Search up to two extra query variants and fuse results (default: false; increases provider requests)" },
              deep: { type: "boolean", description: "Fetch pages and extract answer (default: false)" },
              max_results: { type: "number", description: "Number of results to return, 1-10 (default: 5)" },
              domain: { type: "string", description: "Optional domain filter, for example react.dev or github.com" },
              from_date: { type: "string", description: "Optional inclusive lower date bound YYYY-MM-DD" },
              to_date: { type: "string", description: "Optional inclusive upper date bound YYYY-MM-DD" },
              format: { type: "string", enum: ["text", "json"], description: "Response format (default: text)" },
              strategy: {
                type: "string",
                enum: ["fallback", "aggregate", "auto"],
                description: "fallback tries providers in order; aggregate queries all configured providers; auto detects intent and selects a configured-provider plan (default: fallback)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "fetch_content",
          description: "Fetch a webpage and return its content as clean Markdown. Uses smart caching based on content type.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              force_refresh: { type: "boolean" },
            },
            required: ["url"],
          },
        },
        {
          name: "server_status",
          description: "Returns the current status of the MCP server: active search providers, cache statistics, model load state, and uptime. Use this to check if the server is healthy before issuing search requests.",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "ingest_document",
          description: "Index a document into the local knowledge base for later hybrid search (FTS + vectors). Use this to remember reference material the agent will cite later.",
          inputSchema: {
            type: "object",
            properties: {
              content: { type: "string", description: "Document text (Markdown or plain text)" },
              title: { type: "string", description: "Optional title" },
              source: { type: "string", description: "Optional source URL or path" },
              category: { type: "string", description: "Optional category label" },
            },
            required: ["content"],
          },
        },
        {
          name: "index_url",
          description: "Fetch a URL and index its clean Markdown into the local knowledge base for later hybrid search.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch and index" },
              title: { type: "string", description: "Optional title override" },
              force_refresh: { type: "boolean", description: "Bypass content cache when fetching" },
            },
            required: ["url"],
          },
        },
        {
          name: "search_index",
          description: "Hybrid search (keyword + semantic) over the local knowledge base. Returns matching chunks with source citations.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              max_results: { type: "number", description: "Maximum chunks to return, 1-20 (default 5)" },
              source: { type: "string", description: "Optional source filter (URL or path)" },
              format: { type: "string", enum: ["text", "json"], description: "Response format (default: text)" },
            },
            required: ["query"],
          },
        },
        {
          name: "list_index",
          description: "List documents currently stored in the local knowledge base.",
          inputSchema: {
            type: "object",
            properties: {
              limit: { type: "number", description: "Maximum documents to return (default 50)" },
            },
            required: [],
          },
        },
        {
          name: "remember",
          description: "Store a short fact or note in session memory for later turns. Keep notes concise and specific.",
          inputSchema: {
            type: "object",
            properties: {
              text: { type: "string", description: "Fact or note to remember" },
              topic: { type: "string", description: "Optional topic label" },
              tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
              session: { type: "string", description: "Optional session id" },
            },
            required: ["text"],
          },
        },
        {
          name: "recall",
          description: "Recall notes from session memory. Pass a query to search, or omit it to list recent notes.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Optional search text" },
              topic: { type: "string", description: "Optional topic filter" },
              session: { type: "string", description: "Optional session filter" },
              limit: { type: "number", description: "Maximum notes to return, 1-50 (default 10)" },
            },
            required: [],
          },
        },
        {
          name: "forget",
          description: "Delete a note from session memory by id.",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Note id returned by remember" },
            },
            required: ["id"],
          },
        },
        {
          name: "find_related",
          description: "Explore the entity graph built from indexed documents. Returns documents and co-occurring entities for a given entity name.",
          inputSchema: {
            type: "object",
            properties: {
              entity: { type: "string", description: "Entity name, e.g. Kubernetes" },
              limit: { type: "number", description: "Maximum related items, 1-20 (default 10)" },
            },
            required: ["entity"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      return this.callTool(name, args, createLocalRequestContext({
        requestId: String(extra.requestId), signal: extra.signal,
      }));
    });
  }

  overrideSearchProvidersForTesting(providers: SearchProvider[]): void {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("overrideSearchProvidersForTesting is only available during tests");
    }
    this.providers = providers;
    this.healthTracker = new ProviderHealthTracker();
  }

  async callTool(name: string, args: unknown, context: unknown) {
    try {
      return await this.dispatcher.call(name, args, context);
    } catch (error: unknown) {
      let text: string;
      if (error instanceof InvocationError) {
        text = error.code === "unknown_tool" ? `Unknown tool: ${name}` : `Request rejected: ${error.code}`;
      } else if (error instanceof z.ZodError) {
        text = `Invalid arguments: ${error.issues.map((issue) => issue.message).join("; ")}`;
      } else {
        text = `Internal error: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  private async handleSearch(args: unknown) {
    const { allowed, retryAfterMs } = this.searchLimiter.tryConsume();
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        content: [{ type: "text", text: `Rate limit exceeded: web_search allows ${process.env.RATE_LIMIT_SEARCH_PER_MIN || "10"} requests per minute. Retry in ${seconds} seconds.` }],
        isError: true,
      };
    }

    const { query, expand_query = false, deep = false, max_results = 5, domain, from_date, to_date, format = "text", strategy = "fallback" } = SearchSchema.parse(args);
    const outputFormat: OutputFormat = format;
    const normalizedDomain = normalizeDomainFilter(domain);
    const cacheKey = normalizedDomain ? `${query} domain:${normalizedDomain}` : query;
    const detectedLanguage = this.crossLingual
      ? await this.crossLingual.detectLanguage(query).catch(() => null)
      : null;
    const queryLocale = resolveSearchLocale(query, detectedLanguage);

    // Resolve auto planning up front so cache lookups can be namespaced by the
    // actual plan instead of bypassing the cache for non-fallback strategies.
    let searchPlan: ReturnType<typeof planSearch> | null = null;
    if (strategy === "auto") {
      const detection = await this.intentDetector.detect(query);
      searchPlan = planSearch({
        intent: detection.intent,
        configuredProviderNames: this.providers.map((provider) => provider.name),
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
    const cacheCandidates = await this.cache.get(cacheKey, cacheNamespace);
    const cached = cacheCandidates === null ? null : applyFilters(cacheCandidates);

    if (cached !== null && cached.length > 0) {
      trace.endStage("cache.lookup", { status: "ok", resultCount: cached.length });
      trace.setMeta({ cache: "hit" });
      this.finalizeTrace(trace, cached.length);
      console.error(`Semantic cache hit for query: ${query} [${cacheNamespace}]`);
      if (deep) {
        return this.buildSearchResponse(query, cached.slice(0, max_results), outputFormat);
      }
      const ranked = this.reranker
        ? await rerankResults(query, cached, { scorer: this.reranker.asScorer(), limit: max_results })
        : await this.cache.reRankResults(query, cached, max_results);
      const limited = ranked.slice(0, max_results);
      return {
        content: [{
          type: "text",
          text: outputFormat === "json"
            ? formatToolResult(buildSearchJson(query, limited, { strategy, cache: "hit" }), "json")
            : formatSearchResults(query, limited),
        }],
      };
    }

    trace.endStage("cache.lookup", { status: "empty", error: "miss" });
    trace.setMeta({ cache: "miss" });

    const resultSets: SearchResultItem[][] = [];
    trace.startStage("providers");
    for (const variant of queries) {
      const providerQuery = normalizedDomain ? `${variant} site:${normalizedDomain}` : variant;
      resultSets.push(searchPlan
        ? await executeSearchPlan({
            providers: this.providers,
            query: providerQuery,
            locale: queryLocale,
            plan: searchPlan,
            healthTracker: this.healthTracker,
          })
        : await this.executeProviderSearch(
            providerQuery,
            queryLocale,
            strategy === "aggregate" ? "aggregate" : "fallback",
          ));
    }
    const rawResults = resultSets.length > 1 ? fuseQueryResults(resultSets) : resultSets[0];
    trace.endStage("providers", {
      status: rawResults.length > 0 ? "ok" : "empty",
      resultCount: rawResults.length,
    });

    const results = applyFilters(rawResults);

    if (results.length === 0) {
      trace.endStage("filters", { status: "empty", resultCount: 0 });
      this.finalizeTrace(trace, 0);
      return {
        content: [{ type: "text", text: normalizedDomain
          ? `No results matched the domain filter "${normalizedDomain}". Try a broader search or fetch_content with a direct URL.`
          : "Web search is currently unavailable (all providers returned no results). Try using fetch_content with a direct URL instead, or retry the search later." }],
        isError: true,
      };
    }

    trace.endStage("filters", { status: "ok", resultCount: results.length });
    // Preserve provider candidates; reapply filters on every hit before output/fetch.
    await this.cache.set(cacheKey, rawResults, cacheNamespace);

    if (!deep) {
      const ranked = this.reranker
        ? await rerankResults(query, results, {
            scorer: this.reranker.asScorer(),
            limit: max_results,
          })
        : await this.cache.reRankResults(query, results, max_results);
      this.finalizeTrace(trace, ranked.length);
      const limited = ranked.slice(0, max_results);
      return {
        content: [{
          type: "text",
          text: outputFormat === "json"
            ? formatToolResult(buildSearchJson(query, limited, { strategy, cache: "miss", resultCount: limited.length }), "json")
            : formatSearchResults(query, limited),
        }],
      };
    }

    this.finalizeTrace(trace, results.length);
    return this.buildSearchResponse(query, results.slice(0, max_results), outputFormat);
  }

  private finalizeTrace(trace: SearchTrace, resultCount: number): void {
    const snapshot = trace.toJSON();
    this.recentTraces.push({
      query: snapshot.query,
      totalMs: snapshot.totalMs,
      cache: String(snapshot.meta.cache ?? ""),
      strategy: String(snapshot.meta.strategy ?? ""),
      resultCount,
    });
    if (this.recentTraces.length > this.maxTraceHistory) {
      this.recentTraces.shift();
    }

    if (getEnvBool("TRACE_SEARCHES", false)) {
      console.error(formatTraceSummary(trace));
    }
  }

  private async buildSearchResponse(query: string, results: SearchResultItem[], format: OutputFormat = "text") {
    const urls = results.slice(0, 2).map((result) => result.url).filter(Boolean);
    const pages = await Promise.all(urls.map((url) => this.contentFetcher.fetchPage(url)));
    const validPages = pages.filter((page) => page !== null);

    if (validPages.length > 0) {
      const answer = extractAnswerFromDocuments(
        query,
        validPages.map((page) => ({
          title: page.title,
          url: page.url,
          content: page.content,
        })),
      );

      if (format === "json") {
        return {
          content: [{
            type: "text",
            text: formatToolResult(
              buildAnswerJson(
                query,
                answer,
                validPages.map((page) => ({ url: page.url, title: page.title })),
              ),
              "json",
            ),
          }],
        };
      }

      return {
        content: [{ type: "text", text: answer }],
      };
    }

    const rankedResults = await this.cache.reRankResults(query, results, results.length);
    return {
      content: [{
        type: "text",
        text: format === "json"
          ? formatToolResult(buildSearchJson(query, rankedResults, { deep: true, pagesFetched: 0 }), "json")
          : formatSearchResults(query, rankedResults),
      }],
    };
  }

  private async executeProviderSearch(
    query: string,
    locale: SearchLocale,
    strategy: SearchStrategy = "fallback"
  ): Promise<SearchResultItem[]> {
    return executeSearch({
      providers: this.providers,
      query,
      locale,
      strategy,
      healthTracker: this.healthTracker,
    });
  }

  private async handleFetch(args: unknown) {
    const { allowed, retryAfterMs } = this.fetchLimiter.tryConsume();
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        content: [{ type: "text", text: `Rate limit exceeded: fetch_content allows ${process.env.RATE_LIMIT_FETCH_PER_MIN || "20"} requests per minute. Retry in ${seconds} seconds.` }],
        isError: true,
      };
    }

    const { url, force_refresh } = FetchSchema.parse(args);

    // SSRF Protection: Block local/private resources via DNS resolution
    const validation = await validatePublicHttpUrl(url);

    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `Access to unsupported or local/private resource is blocked for security reasons: ${validation.hostname ?? url}` }],
        isError: true,
      };
    }

    const result = await this.contentFetcher.fetchContent(url, force_refresh ?? false);
    if (result.kind === "error") {
      return {
        content: [{
          type: "text",
          text: result.reason === "parse_failed"
            ? "Could not parse article content from the page."
            : result.reason === "blocked_url"
              ? "Access to unsupported or local/private resource is blocked for security reasons."
              : "Could not fetch page content.",
        }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: result.text }],
    };
  }

  private async handleIngestDocument(args: unknown) {
    try {
      const { content, title, source, category } = IngestDocumentSchema.parse(args);
      const doc = this.knowledgeIndex.ingest({ content, title, source, category });
      const entityCount = this.entityGraph.indexDocument({
        docId: doc.id,
        source: doc.source,
        title: doc.title,
        content: doc.content,
      });
      return {
        content: [{
          type: "text",
          text: `Indexed document "${doc.title}" (${doc.id.slice(0, 12)}…)\nSource: ${doc.source}\nChunks: ${doc.chunkCount}\nEntities: ${entityCount}\nCategory: ${doc.category}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to ingest document: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleIndexUrl(args: unknown) {
    const { allowed, retryAfterMs } = this.fetchLimiter.tryConsume();
    if (!allowed) {
      const seconds = Math.ceil(retryAfterMs / 1000);
      return {
        content: [{ type: "text", text: `Rate limit exceeded: index_url allows ${process.env.RATE_LIMIT_FETCH_PER_MIN || "20"} requests per minute. Retry in ${seconds} seconds.` }],
        isError: true,
      };
    }

    const { url, title, force_refresh } = IndexUrlSchema.parse(args);
    const validation = await validatePublicHttpUrl(url);
    if (!validation.ok) {
      return {
        content: [{ type: "text", text: `Access to unsupported or local/private resource is blocked for security reasons: ${validation.hostname ?? url}` }],
        isError: true,
      };
    }

    const result = await this.contentFetcher.fetchContent(url, force_refresh ?? false);
    if (result.kind === "error") {
      return {
        content: [{ type: "text", text: `Could not fetch page for indexing: ${result.reason}` }],
        isError: true,
      };
    }

    try {
      const doc = this.knowledgeIndex.ingest({
        content: result.text,
        title: title || url,
        source: url,
        category: "web",
      });
      const entityCount = this.entityGraph.indexDocument({
        docId: doc.id,
        source: doc.source,
        title: doc.title,
        content: doc.content,
      });
      return {
        content: [{
          type: "text",
          text: `Indexed ${url}\nTitle: ${doc.title}\nChunks: ${doc.chunkCount}\nEntities: ${entityCount}\nDoc ID: ${doc.id.slice(0, 12)}…`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to index page: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleFindRelated(args: unknown) {
    const schema = z.object({
      entity: z.string().min(1).describe("Entity name, e.g. Kubernetes or PgBouncer"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum related items (default 10)"),
    });
    const { entity, limit = 10 } = schema.parse(args);

    const docs = this.entityGraph.docsForEntity(entity, limit);
    const neighbors = this.entityGraph.relatedEntities(entity, limit);

    if (docs.length === 0 && neighbors.length === 0) {
      return {
        content: [{ type: "text", text: `No graph links found for entity "${entity}". Ingest documents first with ingest_document or index_url.` }],
      };
    }

    const lines: string[] = [`Entity graph for "${entity}":`];
    if (docs.length > 0) {
      lines.push("", "Documents:");
      docs.forEach((doc, index) => {
        lines.push(`  ${index + 1}. ${doc.title} (${doc.source}) — mentions=${doc.count}`);
      });
    }
    if (neighbors.length > 0) {
      lines.push("", "Related entities:");
      neighbors.forEach((neighbor, index) => {
        lines.push(`  ${index + 1}. ${neighbor.name} — cooccurrence=${neighbor.cooccurrence}`);
      });
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }

  private async handleSearchIndex(args: unknown) {
    const { query, max_results = 5, source, format = "text" } = SearchIndexSchema.parse(args);
    const effectiveQuery = rewriteQuery(query) || query;

    const hits = await this.knowledgeIndex.search(effectiveQuery, max_results, {
      source,
      embed: (text) => this.embeddingProvider.getEmbedding(text),
    });

    if (format === "json") {
      return {
        content: [{
          type: "text",
          text: formatToolResult(buildIndexHitJson(query, hits), "json"),
        }],
      };
    }

    if (hits.length === 0) {
      return {
        content: [{ type: "text", text: `No knowledge-index chunks matched "${query}". Use ingest_document or index_url to add content first.` }],
      };
    }

    const lines = hits.map((hit: KnowledgeChunkHit, index: number) => {
      const excerpt = hit.text.length > 400 ? `${hit.text.slice(0, 400)}…` : hit.text;
      return `${index + 1}. [Source ${index + 1}] "${hit.title}" (${hit.source})\n   match=${hit.matchedBy} score=${hit.score.toFixed(4)} chunk=${hit.chunkIndex}\n   ${excerpt}`;
    });

    const sources = hits.map((hit: KnowledgeChunkHit, index: number) => `Source ${index + 1}: ${hit.source} — ${hit.title}`).join("\n");

    return {
      content: [{
        type: "text",
        text: `Knowledge index hits for "${query}":\n\n${lines.join("\n\n")}\n\nSources:\n${sources}`,
      }],
    };
  }

  private async handleListIndex(args: unknown) {
    const limit = typeof args === "object" && args !== null && "limit" in args
      ? Number((args as { limit?: unknown }).limit) || 50
      : 50;

    const docs = this.knowledgeIndex.listDocs(limit);
    const stats = this.knowledgeIndex.getStats();

    if (docs.length === 0) {
      return {
        content: [{ type: "text", text: "Knowledge index is empty. Use ingest_document or index_url to add content." }],
      };
    }

    const lines = docs.map((doc, index) =>
      `${index + 1}. ${doc.title} (${doc.source}) — ${doc.chunkCount} chunks, ${doc.category}, id=${doc.id.slice(0, 12)}…`
    );

    return {
      content: [{
        type: "text",
        text: `Knowledge index: ${stats.docCount} docs, ${stats.chunkCount} chunks, ${stats.vectorCount} vectors\n\n${lines.join("\n")}`,
      }],
    };
  }

  private async handleRemember(args: unknown) {
    try {
      const { text, topic, tags, session } = RememberSchema.parse(args);
      const note = this.sessionMemory.remember(text, { topic, tags, session });
      return {
        content: [{
          type: "text",
          text: `Remembered (id=${note.id}, topic=${note.topic}, session=${note.session}): ${note.text}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed to remember: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleRecall(args: unknown) {
    const { query, topic, session, limit = 10 } = RecallSchema.parse(args ?? {});
    const filter = { topic, session, limit };

    const notes = query && query.trim()
      ? this.sessionMemory.search(query, filter)
      : this.sessionMemory.list(filter);

    const stats = this.sessionMemory.getStats();
    if (notes.length === 0) {
      return {
        content: [{ type: "text", text: `No memory notes matched. (${stats.count} notes stored across ${stats.sessions} sessions)` }],
      };
    }

    const lines = notes.map((note, index) =>
      `${index + 1}. [${note.id}] (${note.topic}${note.tags.length ? `, ${note.tags.join(",")}` : ""}) ${note.text}`
    );

    return {
      content: [{
        type: "text",
        text: `Session memory (${stats.count} notes total):\n\n${lines.join("\n")}`,
      }],
    };
  }

  private async handleForget(args: unknown) {
    const { id } = ForgetSchema.parse(args);
    const deleted = this.sessionMemory.delete(id);
    return {
      content: [{
        type: "text",
        text: deleted ? `Deleted note ${id}` : `No note found with id ${id}`,
      }],
      isError: deleted ? undefined : true,
    };
  }

  private async handleStatus() {
    const cacheStats = this.cache.getCacheStats();
    const knowledgeStats = this.knowledgeIndex.getStats();
    const memoryStats = this.sessionMemory.getStats();
    const status = {
      providers: this.providers.map((provider) => ({
        name: provider.name,
        ...this.healthTracker.getSnapshot(provider.name),
      })),
      cache: cacheStats,
      knowledgeIndex: knowledgeStats,
      memory: memoryStats,
      entityGraph: this.entityGraph.getStats(),
      recentSearches: [...this.recentTraces].reverse().slice(0, 10),
      browser: this.browser ? "running" : "idle",
      crosslingual: this.enableCrosslingual ? "enabled" : "disabled",
      config: {
        searchProviders: this.providers.map((provider) => provider.name),
        searchStrategyDefault: "fallback",
        autoRouting: "available",
        routingProfileVersion: ROUTING_PROFILE_VERSION,
        fetchWaitUntil: this.fetchWaitUntil,
        forcePlaywright: getEnvBool("FORCE_PLAYWRIGHT", false),
        cacheDbPath: this.cacheDbPath,
        reranker: this.reranker ? "enabled" : "disabled",
      },
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Search Memory MCP Server running on stdio");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = new WebSearchServer();
  server.run().catch(console.error);
}
