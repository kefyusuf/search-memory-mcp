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
import { TransformersEmbeddingProvider } from "./cache/embedding.js";
import { SQLiteVectorStore } from "./cache/sqlite-store.js";
import { SemanticCache } from "./cache/semantic-cache.js";
import { CrossLingualEngine } from "./cache/crosslingual.js";
import { createSearchRateLimiter, createFetchRateLimiter, TokenBucket } from "./rate-limiter.js";
import type { SearchProvider } from "./providers/base.js";
import { ProviderHealthTracker } from "./providers/health.js";
import { buildProviders } from "./providers/registry.js";
import { SearchIntentDetector, type IntentDetector } from "./search/intent.js";
import { CrossEncoderReranker } from "./search/rerank.js";
import { ContentFetcher } from "./fetch-module.js";
import { KnowledgeIndex } from "./knowledge/index-store.js";
import { SessionMemory } from "./memory/session-memory.js";
import { EntityGraph } from "./graph/entity-graph.js";
import { createLocalRequestContext, InvocationError } from "./runtime/request-context.js";
import { ToolDispatcher } from "./runtime/tool-dispatcher.js";
import { launchWithAutoInstall } from "./browser-launcher.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { createFetchHandler } from "./tools/fetch.js";
import { createKnowledgeHandlers } from "./tools/knowledge.js";
import { createMemoryHandlers } from "./tools/memory.js";
import { createSearchHandler, SearchTraceHistory } from "./tools/search.js";
import { createStatusHandler } from "./tools/status.js";
import type { ToolResult } from "./tools/types.js";

// --- Types & Schemas ---

export { SearchSchema } from "./tools/search.js";

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
  private dispatcher: ToolDispatcher<ToolResult>;
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private browserLaunch: Promise<Browser> | null = null;
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
  private readonly traces = new SearchTraceHistory();
  private readonly searchTool: (args: unknown) => Promise<ToolResult>;
  private readonly statusTool: () => Promise<ToolResult>;
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
    const loadContent = (url: string, forceRefresh: boolean) => this.contentFetcher.fetchContent(url, forceRefresh);
    const fetchContent = createFetchHandler({ fetchLimiter: this.fetchLimiter, fetchContent: loadContent });
    const knowledge = createKnowledgeHandlers({
      knowledgeIndex: this.knowledgeIndex,
      entityGraph: this.entityGraph,
      embed: (text) => this.embeddingProvider.getEmbedding(text),
      fetchContent: loadContent,
      fetchLimiter: this.fetchLimiter,
    });
    const memory = createMemoryHandlers({ sessionMemory: this.sessionMemory });
    this.searchTool = createSearchHandler({
      searchLimiter: this.searchLimiter,
      cache: () => this.cache,
      providers: () => this.providers,
      healthTracker: () => this.healthTracker,
      intentDetector: this.intentDetector,
      crossLingual: this.crossLingual,
      reranker: this.reranker,
      fetchPage: (url) => this.contentFetcher.fetchPage(url),
      traces: this.traces,
    });
    this.statusTool = createStatusHandler({
      providers: () => this.providers,
      healthTracker: () => this.healthTracker,
      cacheStats: () => this.cache.getCacheStats(),
      knowledgeStats: () => this.knowledgeIndex.getStats(),
      memoryStats: () => this.sessionMemory.getStats(),
      graphStats: () => this.entityGraph.getStats(),
      traces: this.traces,
      browserRunning: () => this.browser !== null,
      crosslingualEnabled: this.enableCrosslingual,
      rerankerEnabled: this.reranker !== null,
      fetchWaitUntil: this.fetchWaitUntil,
      cacheDbPath: this.cacheDbPath,
      startedAt: this.startedAt,
    });
    // These stores and resource limits are process-local. Hosted execution stays
    // closed until each handler has tenant-scoped dependencies.
    this.dispatcher = new ToolDispatcher({
      web_search: { permission: "search:read", modes: ["local"], handler: (args) => this.handleSearch(args) },
      fetch_content: { permission: "content:read", modes: ["local"], handler: (args) => fetchContent(args) },
      server_status: { permission: "status:read", modes: ["local"], handler: () => this.handleStatus() },
      ingest_document: { permission: "knowledge:write", modes: ["local"], handler: (args) => knowledge.ingest_document(args) },
      index_url: { permission: "knowledge:write", modes: ["local"], handler: (args) => knowledge.index_url(args) },
      search_index: { permission: "knowledge:read", modes: ["local"], handler: (args) => knowledge.search_index(args) },
      list_index: { permission: "knowledge:read", modes: ["local"], handler: (args) => knowledge.list_index(args) },
      remember: { permission: "memory:write", modes: ["local"], handler: (args) => memory.remember(args) },
      recall: { permission: "memory:read", modes: ["local"], handler: (args) => memory.recall(args) },
      forget: { permission: "memory:write", modes: ["local"], handler: (args) => memory.forget(args) },
      find_related: { permission: "knowledge:read", modes: ["local"], handler: (args) => knowledge.find_related(args) },
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
      this.browserLaunch ??= launchWithAutoInstall(() => chromium.launch({ headless: true }))
        .finally(() => { this.browserLaunch = null; });
      this.browser = await this.browserLaunch;
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
      tools: TOOL_DEFINITIONS,
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
    return this.searchTool(args);
  }

  private async handleStatus() {
    return this.statusTool();
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
