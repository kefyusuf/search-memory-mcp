#!/usr/bin/env node
/**
 * Hosted MCP server bootstrap (ADR-0005). Composes the HTTP auth boundary,
 * a real PostgreSQL membership resolver (the live authority), shared
 * admission, shared search infrastructure and per-scope tenant caches, then
 * serves the MCP tools enabled for hosted execution. Rollout slice 2 adds
 * web_search and fetch_content next to the memory slice; the local stdio
 * server (src/index.ts) is untouched.
 *
 * Requires explicit configuration; on missing pieces it prints the exact
 * setup instructions and exits instead of guessing.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { importSPKI, importPKCS8, jwtVerify, SignJWT } from "jose";
import { chromium, Browser, BrowserContext } from "playwright";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PostgresMembershipResolver } from "../identity/postgres-membership.js";
import { InvocationError } from "../runtime/request-context.js";
import { createHostedHttpAuthHandler } from "../runtime/hosted-http-auth.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../runtime/invocation-admission.js";
import { TransformersEmbeddingProvider } from "../cache/embedding.js";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { EntityGraph } from "../graph/entity-graph.js";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { createFetchRateLimiter, createSearchRateLimiter } from "../rate-limiter.js";
import type { SearchProvider } from "../providers/base.js";
import { buildProviders } from "../providers/registry.js";
import { ProviderHealthTracker } from "../providers/health.js";
import { SearchIntentDetector } from "../search/intent.js";
import { SearchTraceHistory, createSearchHandler } from "../tools/search.js";
import { createFetchHandler } from "../tools/fetch.js";
import { createKnowledgeHandlers } from "../tools/knowledge.js";
import { createResearchHandler } from "../tools/research.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { MemorySchemas } from "../tools/memory.js";
import { textResult, type ToolResult } from "../tools/types.js";
import { launchWithAutoInstall } from "../browser-launcher.js";
import { openGuardedBrowserContext, type BrowserEgressProxy } from "../security/browser-egress-proxy.js";
import { TenantStoreCache, ScopeCache } from "./tenant-stores.js";
import { startProvisioningServer } from "./provisioning.js";
import { ContentFetcher } from "../fetch-module.js";

function requireEnv(name: string, validate?: (value: string) => boolean): string {
  const value = (process.env[name] ?? "").trim();
  if (!value || (validate && !validate(value))) {
    console.error(`Hosted bootstrap requires ${name}${validate ? " (value failed validation)" : ""}.`);
    process.exit(1);
  }
  return value;
}
function requireInt(name: string, min = 1): number {
  const value = Number(process.env[name] ?? "");
  if (!Number.isSafeInteger(value) || value < min) {
    console.error(`Hosted bootstrap requires ${name} to be a positive integer (>= ${min}).`);
    process.exit(1);
  }
  return value;
}

const port = Number(process.env.HOSTED_HTTP_PORT ?? "8080");
const bind = process.env.HOSTED_BIND ?? "0.0.0.0";
const issuer = requireEnv("HOSTED_ISSUER", v => v.startsWith("https://"));
const audience = requireEnv("HOSTED_AUDIENCE", v => v.startsWith("https://"));
const allowedOrigins = requireEnv("HOSTED_ALLOWED_ORIGINS").split(",").map(origin => origin.trim()).filter(Boolean);
const algorithm = process.env.HOSTED_JWT_ALGORITHM ?? "ES256";
if (!["ES256", "RS256", "EdDSA"].includes(algorithm)) {
  console.error("HOSTED_JWT_ALGORITHM must be one of ES256, RS256, EdDSA.");
  process.exit(1);
}
const keyPem = readFileSync(requireEnv("HOSTED_PUBLIC_KEY_FILE"), "utf8");
const membershipUrl = requireEnv("HOSTED_MEMBERSHIP_DATABASE_URL", v => v.startsWith("postgres://") || v.startsWith("postgresql://"));
const appDb = requireEnv("HOSTED_APP_DB");
const admit = {
  global: requireInt("HOSTED_ADMIT_GLOBAL"),
  tenant: requireInt("HOSTED_ADMIT_TENANT"),
  workspace: requireInt("HOSTED_ADMIT_WORKSPACE"),
  principal: requireInt("HOSTED_ADMIT_PRINCIPAL"),
};
const maxTenantStores = Number(process.env.HOSTED_MAX_TENANT_STORES ?? "64");
const maxScopeCaches = Number(process.env.HOSTED_MAX_SCOPE_CACHES ?? "64");
const lookupConcurrency = Number(process.env.HOSTED_LOOKUP_CONCURRENCY ?? "8");
const lookupTimeoutMs = Number(process.env.HOSTED_LOOKUP_TIMEOUT_MS ?? "2000");
const fetchWaitUntil = process.env.HOSTED_FETCH_WAIT_UNTIL === "domcontentloaded" ? "domcontentloaded" : "networkidle";
const readerFallbackUrl = process.env.HOSTED_READER_FALLBACK_URL;
const searchLimiter = createSearchRateLimiter();
const fetchLimiter = createFetchRateLimiter();
const healthTracker = new ProviderHealthTracker();
const traces = new SearchTraceHistory();
const intentDetector = new SearchIntentDetector();
const embeddingProvider = new TransformersEmbeddingProvider(undefined, { loadWaitMs: 0 });
const defaultProviders = (process.env.BRAVE_SEARCH_API_KEY ?? "").trim() ? "brave,duckduckgo,marginalia,bing" : "duckduckgo,marginalia,bing";
const sharedProviders: SearchProvider[] = buildProviders((process.env.SEARCH_PROVIDERS ?? defaultProviders).split(",").map(s => s.trim().toLowerCase()).filter(Boolean));

// Shared guarded browser, launched lazily only when a page needs it (same
// pattern as the local server): Chromium + loopback egress proxy, no
// direct-network fallback.
let browser: Browser | null = null;
let browserContext: BrowserContext | null = null;
let browserContextLaunch: Promise<BrowserContext> | null = null;
let browserLaunch: Promise<Browser> | null = null;
let browserShuttingDown = false;
let browserEgressProxy: BrowserEgressProxy | null = null;
async function getBrowserContext(): Promise<BrowserContext> {
  if (browserShuttingDown) throw new Error("Browser is shutting down");
  if (browserContext) return browserContext;
  browserLaunch ??= launchWithAutoInstall(() => chromium.launch({
    headless: true,
    args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  })).finally(() => { browserLaunch = null; });
  browser = await browserLaunch;
  browserContextLaunch ??= (async () => {
    const launched = await getBrowser();
    const { context, proxy } = await openGuardedBrowserContext(launched, {
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    });
    if (browserShuttingDown) {
      try { await context.close(); } finally { await proxy.close(); }
      throw new Error("Browser is shutting down");
    }
    browserEgressProxy = proxy;
    browserContext = context;
    return context;
  })().finally(() => { browserContextLaunch = null; });
  return browserContextLaunch;
}
async function getBrowser(): Promise<Browser> {
  return browser!;
}

// Extractable import is required by the key-pair match check below; the key
// is already process-readable from the PEM file, so this is not a weakening.
const verificationKey = await importSPKI(keyPem, algorithm, { extractable: true }).catch((error: unknown) => {
  console.error(`HOSTED_PUBLIC_KEY_FILE is not a valid SPKI public key: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const resolver = new PostgresMembershipResolver({ connectionString: membershipUrl, issuer, maxConcurrentLookups: lookupConcurrency, lookupTimeoutMs });
const storeCache = new TenantStoreCache({ appDbPath: appDb, maxStores: maxTenantStores });
const admission = new InMemoryInvocationAdmission(admit);

// Per-scope (tenant|workspace) search caches and content fetchers. The
// semantic cache and its vector store bind tenancy at construction; the
// browser, providers, health tracker and traces are process-wide by design.
const scopeCaches = new ScopeCache<SemanticCache>({
  maxEntries: maxScopeCaches,
  onClose: cache => cache.close(),
});
const scopeFetchers = new ScopeCache<ContentFetcher>({
  maxEntries: maxScopeCaches,
  onClose: fetcher => fetcher.close(),
});
const searchCacheFor = (context: Parameters<TenantStoreCache["memoryFor"]>[0]) => scopeCaches.get(`${context.tenantId}|${context.workspaceId}`, () =>
  new SemanticCache(embeddingProvider, new SQLiteVectorStore(appDb, { context }), 0.75, intentDetector));
const fetcherFor = (context: Parameters<TenantStoreCache["memoryFor"]>[0]) => scopeFetchers.get(`${context.tenantId}|${context.workspaceId}`, () =>
  new ContentFetcher({
    cache: searchCacheFor(context),
    getBrowserContext,
    fetchWaitUntil,
    readerFallbackUrl,
    detectIntent: null,
  }));

const memoryHandlers = {
  async remember(args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]): Promise<ToolResult> {
    const { text, topic, tags, session } = MemorySchemas.RememberSchema.parse(args);
    const note = storeCache.memoryFor(context).remember(text, { topic, tags, session });
    return textResult(`Remembered (id=${note.id}, topic=${note.topic}, session=${note.session}): ${note.text}`);
  },
  async recall(args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]): Promise<ToolResult> {
    const { query, topic, session, limit = 10 } = MemorySchemas.RecallSchema.parse(args ?? {});
    const mem = storeCache.memoryFor(context);
    const filter = { topic, session, limit };
    const notes = query && query.trim() ? mem.search(query, filter) : mem.list(filter);
    const stats = mem.getStats();
    if (notes.length === 0) return textResult(`No memory notes matched. (${stats.count} notes stored across ${stats.sessions} sessions)`);
    const lines = notes.map((note, index) => `${index + 1}. [${note.id}] (${note.topic}${note.tags.length ? `, ${note.tags.join(",")}` : ""}) ${note.text}`);
    return textResult(`Session memory (${stats.count} notes total):\n\n${lines.join("\n")}`);
  },
  async forget(args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]): Promise<ToolResult> {
    const { id } = MemorySchemas.ForgetSchema.parse(args);
    const deleted = storeCache.memoryFor(context).delete(id);
    return { content: [{ type: "text", text: deleted ? `Deleted note ${id}` : `No note found with id ${id}` }], isError: deleted ? undefined : true };
  },
};

// Hosted rollout slice 2: web_search and fetch_content join the memory
// slice. Per-request handlers resolve the caller's own per-scope cache and
// fetcher; provider health, rate buckets, traces, models and the browser
// stay process-wide by design (ADR-0005 split). server_status and the
// knowledge tools remain fenced until their hosted slices.
const searchTools = new ScopeCache<(args: unknown) => Promise<ToolResult>>({
  maxEntries: maxScopeCaches,
});
const searchToolFor = (context: Parameters<TenantStoreCache["memoryFor"]>[0]) => searchTools.get(`${context.tenantId}|${context.workspaceId}`, () =>
  createSearchHandler({
    searchLimiter,
    cache: () => searchCacheFor(context),
    providers: () => sharedProviders,
    healthTracker: () => healthTracker,
    intentDetector,
    crossLingual: null,
    reranker: null,
    fetchPage: (url: string) => fetcherFor(context).fetchPage(url),
    traces,
  }));
const fetchTools = new ScopeCache<(args: unknown) => Promise<ToolResult>>({
  maxEntries: maxScopeCaches,
});
const fetchToolFor = (context: Parameters<TenantStoreCache["memoryFor"]>[0]) => fetchTools.get(`${context.tenantId}|${context.workspaceId}`, () =>
  createFetchHandler({
    fetchLimiter,
    fetchContent: (url: string, forceRefresh: boolean) => fetcherFor(context).fetchContent(url, forceRefresh),
  }));

// Hosted rollout slice 3: the knowledge tools and research. Each scope gets
// its own KnowledgeIndex + EntityGraph (tenant-bound at construction); the
// filesystem branch of ingest_document is disabled (allowedDirs is empty),
// so hosted callers can only ingest inline content. Research reuses the
// caller's per-scope web_search and fetch pipeline.
const knowledgeScopes = new ScopeCache<{
  knowledgeIndex: KnowledgeIndex;
  entityGraph: EntityGraph;
  handlers: ReturnType<typeof createKnowledgeHandlers>;
  research: (args: unknown) => Promise<ToolResult>;
}>({
  maxEntries: maxScopeCaches,
  onClose: bundle => {
    try { bundle.knowledgeIndex.close(); } catch { /* already closed */ }
    try { bundle.entityGraph.close(); } catch { /* already closed */ }
  },
});
const knowledgeFor = (context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeScopes.get(`${context.tenantId}|${context.workspaceId}`, () => {
  const knowledgeIndex = new KnowledgeIndex(appDb, { context, embeddingProvider });
  const entityGraph = new EntityGraph(appDb, { context });
  const embed = (text: string) => embeddingProvider.getEmbedding(text);
  const handlers = createKnowledgeHandlers({
    knowledgeIndex,
    entityGraph,
    embed,
    fetchContent: (url: string, forceRefresh: boolean) => fetcherFor(context).fetchContent(url, forceRefresh),
    fetchLimiter,
    allowedDirs: () => [],
  });
  const research = createResearchHandler({
    search: async (innerArgs: unknown) => searchToolFor(context)(innerArgs),
    fetchContent: (url: string, forceRefresh: boolean) => fetcherFor(context).fetchContent(url, forceRefresh),
    fetchLimiter,
    knowledgeIndex,
    entityGraph,
    embed,
  });
  return { knowledgeIndex, entityGraph, handlers, research };
});

const hostedHandlers = {
  remember: { permission: "memory:write" as const, modes: ["hosted"] as const, handler: memoryHandlers.remember },
  recall: { permission: "memory:read" as const, modes: ["hosted"] as const, handler: memoryHandlers.recall },
  forget: { permission: "memory:write" as const, modes: ["hosted"] as const, handler: memoryHandlers.forget },
  web_search: { permission: "search:read" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => searchToolFor(context)(args) },
  fetch_content: { permission: "content:read" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => fetchToolFor(context)(args) },
  search_index: { permission: "knowledge:read" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).handlers.search_index(args) },
  list_index: { permission: "knowledge:read" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).handlers.list_index(args) },
  find_related: { permission: "knowledge:read" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).handlers.find_related(args) },
  ingest_document: { permission: "knowledge:write" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).handlers.ingest_document(args) },
  index_url: { permission: "knowledge:write" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).handlers.index_url(args) },
  research: { permission: "knowledge:write" as const, modes: ["hosted"] as const, handler: async (args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => knowledgeFor(context).research(args) },
  server_status: { permission: "status:read" as const, modes: ["hosted"] as const, handler: async (_args: unknown, context: Parameters<TenantStoreCache["memoryFor"]>[0]) => hostedStatus(context) },
};

const dispatcher = new ToolDispatcher(hostedHandlers, { admission });

// Tenant-safe status: every store stat comes from the caller's own scope;
// process-wide fields (recent searches, cache path, browser internals) and
// any cross-tenant detail are deliberately absent. Provider availability is
// service-level information, reduced to name + available.
const startedAt = Date.now();
function hostedStatus(context: Parameters<TenantStoreCache["memoryFor"]>[0]): ToolResult {
  const bundle = knowledgeFor(context);
  const payload = {
    providers: sharedProviders.map(provider => ({ name: provider.name, available: healthTracker.getSnapshot(provider.name).available })),
    config: { mode: "hosted", tenantId: context.tenantId, workspaceId: context.workspaceId, principalId: context.principalId, hostedEnabledTools: Object.keys(hostedHandlers).length },
    memory: storeCache.memoryFor(context).getStats(),
    knowledgeIndex: bundle.knowledgeIndex.getStats(),
    entityGraph: bundle.entityGraph.getStats(),
    cache: searchCacheFor(context).getCacheStats(),
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  };
  const summary = `Hosted status for ${context.tenantId}/${context.workspaceId}: ${payload.memory.count} memory notes, ${payload.knowledgeIndex.docCount} knowledge docs, ${payload.entityGraph.linkCount} graph links; providers: ${payload.providers.map(p => `${p.name}=${p.available ? "up" : "down"}`).join(", ")}.`;
  return textResult(summary, payload);
}

const server = createServer(createHostedHttpAuthHandler({
  authorization: { issuer, audience, algorithm: algorithm as "ES256" | "RS256" | "EdDSA", verificationKey, resolveMembership: resolver.resolveMembership },
  allowedOrigins,
  scopesSupported: ["memory:read", "memory:write", "search:read", "content:read", "knowledge:read", "knowledge:write"],
  requestTimeoutMs: Number(process.env.HOSTED_REQUEST_TIMEOUT_MS ?? "30000"),
  onAuthorized: async (req, res, context) => {
    const mcp = new McpServer({ name: "search-memory-hosted", version: process.env.npm_package_version ?? "hosted" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));
    mcp.setRequestHandler(CallToolRequestSchema, async request => {
      // Mirror the local dispatcher UX: dispatcher rejections are tool errors
      // with the rejection code visible, not transport-level internal errors.
      try {
        return await dispatcher.call(request.params.name, request.params.arguments, context);
      } catch (error) {
        const code = error instanceof InvocationError ? error.code : "internal_error";
        return { content: [{ type: "text", text: `Request rejected: ${code}` }], isError: true };
      }
    });
    res.once("close", () => { void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  },
}));

const shuttingDownHooks: Array<() => Promise<void>> = [];
const shuttingDown = async () => {
  console.error("Hosted MCP server shutting down...");
  browserShuttingDown = true;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  try { await browserContextLaunch; } catch { /* in-flight launch failed */ }
  try { await browserLaunch; } catch { /* in-flight launch failed */ }
  if (browserContext) { try { await browserContext.close(); } catch { /* already closed */ } browserContext = null; }
  if (browserEgressProxy) { try { await browserEgressProxy.close(); } catch (error) { console.error("Error stopping browser egress proxy:", error); } browserEgressProxy = null; }
  if (browser) { try { await browser.close(); } catch { /* already closed */ } browser = null; }
  scopeFetchers.closeAll();
  scopeCaches.closeAll();
  for (const hook of shuttingDownHooks.splice(0)) { try { await hook(); } catch { /* already closed */ } }
  await resolver.close();
  storeCache.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shuttingDown(); });
process.on("SIGTERM", () => { void shuttingDown(); });

server.listen(port, bind, () => {
  const bound = server.address();
  const boundPort = bound && typeof bound === "object" ? bound.port : port;
  console.error(`Hosted MCP server listening on ${bind}:${boundPort}`);
  console.error(`Tools: ${TOOL_DEFINITIONS.length} advertised, ${Object.keys(hostedHandlers).length} hosted-enabled (all 12; tenant-safe server_status included).`);
  console.error(`Authority: ${issuer}; admission caps global=${admit.global} tenant=${admit.tenant} workspace=${admit.workspace} principal=${admit.principal}.`);
});

// Provisioning surface (Faz C, ADR-0006): a separate admin port with operator
// token auth; disabled entirely when HOSTED_ADMIN_PORT is unset. The admin API
// never accepts user JWTs and connects with the operator DSN (DML role).
const adminPort = process.env.HOSTED_ADMIN_PORT ? Number(process.env.HOSTED_ADMIN_PORT) : null;
if (adminPort !== null) {
  const adminToken = requireEnv("HOSTED_ADMIN_TOKEN");
  const adminDatabaseUrl = requireEnv("HOSTED_ADMIN_DATABASE_URL");
  const privatePemFile = requireEnv("HOSTED_TOKEN_PRIVATE_KEY_FILE");
  const tokenPrivateKey = await importPKCS8(readFileSync(privatePemFile, "utf8"), algorithm);
  // Key-pair probe: a token signed by the mint key must verify with the
  // hosted server's verification key; a mismatched pair is a startup error.
  const probe = await new SignJWT({ probe: true })
    .setProtectedHeader({ alg: algorithm, typ: "JWT" })
    .setIssuedAt()
    .setIssuer("keypair-probe")
    .setExpirationTime("5m")
    .sign(tokenPrivateKey);
  try {
    await jwtVerify(probe, verificationKey, { issuer: "keypair-probe", algorithms: [algorithm] });
  } catch {
    console.error("HOSTED_TOKEN_PRIVATE_KEY_FILE does not match HOSTED_PUBLIC_KEY_FILE.");
    process.exit(1);
  }
  const provisioning = await startProvisioningServer({ adminPort, adminToken, operatorDatabaseUrl: adminDatabaseUrl, issuer, audience, tokenPrivateKey, tokenAlgorithm: algorithm as "ES256" | "RS256" | "EdDSA", bind });
  shuttingDownHooks.push(async () => { try { await provisioning.close(); } catch { /* already closed */ } });
  console.error(`Provisioning API listening on ${bind}:${provisioning.port} (operator token auth).`);
}
