#!/usr/bin/env node
/**
 * Hosted MCP server bootstrap (ADR-0005). Composes the HTTP auth boundary,
 * a real PostgreSQL membership resolver (the live authority), shared
 * admission and the tenant-scoped store cache, then serves the MCP tools
 * that are enabled for hosted execution (memory slice first). The local
 * stdio server (src/index.ts) is untouched.
 *
 * Requires explicit configuration; on missing pieces it prints the exact
 * setup instructions and exits instead of guessing.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { importSPKI } from "jose";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PostgresMembershipResolver } from "../identity/postgres-membership.js";
import { InvocationError } from "../runtime/request-context.js";
import { createHostedHttpAuthHandler } from "../runtime/hosted-http-auth.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../runtime/invocation-admission.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";
import { MemorySchemas } from "../tools/memory.js";
import { textResult, type ToolResult } from "../tools/types.js";
import { TenantStoreCache } from "./tenant-stores.js";

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
const lookupConcurrency = Number(process.env.HOSTED_LOOKUP_CONCURRENCY ?? "8");
const lookupTimeoutMs = Number(process.env.HOSTED_LOOKUP_TIMEOUT_MS ?? "2000");

const verificationKey = await importSPKI(keyPem, algorithm).catch((error: unknown) => {
  console.error(`HOSTED_PUBLIC_KEY_FILE is not a valid SPKI public key: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

const resolver = new PostgresMembershipResolver({ connectionString: membershipUrl, issuer, maxConcurrentLookups: lookupConcurrency, lookupTimeoutMs });
const storeCache = new TenantStoreCache({ appDbPath: appDb, maxStores: maxTenantStores });
const admission = new InMemoryInvocationAdmission(admit);

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

// Hosted rollout slice 1: memory tools. The remaining nine names are
// registered but disabled (modes: []) so callers get a precise
// execution_mode_unavailable instead of an unknown-tool error.
const hostedHandlers = {
  remember: { permission: "memory:write" as const, modes: ["hosted"] as const, handler: memoryHandlers.remember },
  recall: { permission: "memory:read" as const, modes: ["hosted"] as const, handler: memoryHandlers.recall },
  forget: { permission: "memory:write" as const, modes: ["hosted"] as const, handler: memoryHandlers.forget },
};
const disabledHandler = async (): Promise<ToolResult> => textResult("");
const dispatcher = new ToolDispatcher({
  web_search: { permission: "search:read", modes: [], handler: disabledHandler },
  fetch_content: { permission: "content:read", modes: [], handler: disabledHandler },
  research: { permission: "knowledge:write", modes: [], handler: disabledHandler },
  server_status: { permission: "status:read", modes: [], handler: disabledHandler },
  ingest_document: { permission: "knowledge:write", modes: [], handler: disabledHandler },
  index_url: { permission: "knowledge:write", modes: [], handler: disabledHandler },
  search_index: { permission: "knowledge:read", modes: [], handler: disabledHandler },
  list_index: { permission: "knowledge:read", modes: [], handler: disabledHandler },
  find_related: { permission: "knowledge:read", modes: [], handler: disabledHandler },
  ...hostedHandlers,
}, { admission });

const server = createServer(createHostedHttpAuthHandler({
  authorization: { issuer, audience, algorithm: algorithm as "ES256" | "RS256" | "EdDSA", verificationKey, resolveMembership: resolver.resolveMembership },
  allowedOrigins,
  scopesSupported: ["memory:read", "memory:write"],
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

const shuttingDown = async () => {
  console.error("Hosted MCP server shutting down...");
  await new Promise<void>(resolve => server.close(() => resolve()));
  await resolver.close();
  storeCache.close();
  process.exit(0);
};
process.on("SIGINT", () => { void shuttingDown(); });
process.on("SIGTERM", () => { void shuttingDown(); });

server.listen(port, process.env.HOSTED_BIND ?? "0.0.0.0", () => {
  const bound = server.address();
  const boundPort = bound && typeof bound === "object" ? bound.port : port;
  console.error(`Hosted MCP server listening on ${process.env.HOSTED_BIND ?? "0.0.0.0"}:${boundPort}`);
  console.error(`Tools: ${TOOL_DEFINITIONS.length} advertised, ${Object.keys(hostedHandlers).length} hosted-enabled (memory slice).`);
  console.error(`Authority: ${issuer}; admission caps global=${admit.global} tenant=${admit.tenant} workspace=${admit.workspace} principal=${admit.principal}.`);
});
