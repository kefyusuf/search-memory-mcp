import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { Pool } from "pg";
import { generateKeyPair, SignJWT } from "jose";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PostgresMembershipResolver } from "../build/identity/postgres-membership.js";
import { ToolDispatcher } from "../build/runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../build/runtime/invocation-admission.js";
import { createHostedHttpAuthHandler } from "../build/runtime/hosted-http-auth.js";
import { SessionMemory } from "../build/memory/session-memory.js";

// Hosted HTTP ingress end-to-end (synthetic): loopback HTTP auth boundary +
// real live PostgreSQL identity (never restored) + SDK MCP tool call through
// shared admission into tenant-scoped stores. Proves the auth -> admission ->
// handler -> scoped-store chain, HTTP-layer revocation, and fail-closed
// authority loss (D3-V3 evidence input). No deployment; no real user data.

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_ingress_test_${suffix}`;
const role = `ingress_reader_${suffix}`;
const operatorRole = `ingress_operator_${suffix}`;
const ownerRole = `ingress_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/team/mcp";
const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp";
const GRANTS = ["memory:read", "memory:write"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
const resolvers = [];
const servers = [];
const clients = [];
let appDir;
let checks = 0;
const rawSend = (port, path, headers = {}, method = "POST", body = "") =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: "mcp.example.com", ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    }); req.on("error", reject); req.end(body);
  });
async function startIngress({ connectionString, admission }) {
  const resolver = new PostgresMembershipResolver({ connectionString, issuer, maxConcurrentLookups: 2, lookupTimeoutMs: 2000 });
  resolvers.push(resolver);
  const dispatcher = new ToolDispatcher({
    remember_note: { permission: "memory:write", modes: ["hosted"], handler: async (args, context) => {
      const mem = new SessionMemory(appDb, { context });
      try { const note = mem.remember(String(args?.text ?? ""), { session: "e2e", topic: "ingress" }); return { content: [{ type: "text", text: note.id }] }; }
      finally { mem.close(); }
    } },
    recall_notes: { permission: "memory:read", modes: ["hosted"], handler: async (_args, context) => {
      const mem = new SessionMemory(appDb, { context });
      try { return { content: [{ type: "text", text: mem.list({ session: "e2e" }).map(n => n.text).join("|") || "(empty)" }] }; }
      finally { mem.close(); }
    } },
    slow_probe: { permission: "memory:read", modes: ["hosted"], handler: async () => {
      await new Promise(resolve => setTimeout(resolve, 300));
      return { content: [{ type: "text", text: "slow" }] };
    } },
  }, { admission });
  const server = createServer(createHostedHttpAuthHandler({
    authorization: { issuer, audience: resource, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: resolver.resolveMembership },
    allowedOrigins: ["https://app.example.com"], scopesSupported: ["memory:read", "memory:write"], requestTimeoutMs: 5000,
    onAuthorized: async (req, res, context) => {
      const mcp = new McpServer({ name: "ingress-e2e", version: "1.0.0" }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      mcp.setRequestHandler(CallToolRequestSchema, request => dispatcher.call(request.params.name, request.params.arguments, context));
      res.once("close", () => { void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(req, res);
    },
  }));
  servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function callTool(port, token, workspaceId, name, args) {
  const client = new Client({ name: "ingress-e2e-client", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/team/mcp`), {
    requestInit: { headers: { authorization: token, "x-workspace-id": workspaceId } },
    // Native loopback requests preserve the production Host without DNS/TLS changes.
    fetch: async (_url, init) => {
      const result = await rawSend(port, "/team/mcp", Object.fromEntries(new Headers(init?.headers)), init?.method, init?.body);
      return new Response(result.text || null, { status: result.status, headers: result.headers });
    },
  }));
  return client.callTool({ name, arguments: args ?? {} });
}
try {
  // --- Fixture database: live identity authority ---
  await admin.query(`CREATE DATABASE ${database}`); createdDatabase = true;
  const fixtureUrl = new URL(base); fixtureUrl.pathname = `/${database}`;
  fixture = new Pool({ connectionString: fixtureUrl.href, connectionTimeoutMillis: 2000 });
  await fixture.query(await readFile(new URL("../migrations/0001-hosted-membership.sql", import.meta.url), "utf8"));
  await fixture.query(await readFile(new URL("../migrations/0002-hosted-membership-audit.sql", import.meta.url), "utf8"));
  await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN`); createdOwner = true;
  await fixture.query(`ALTER SCHEMA mcp_identity OWNER TO ${ownerRole}`);
  for (const table of ["workspaces", "workspace_memberships", "membership_audit"])
    await fixture.query(`ALTER TABLE mcp_identity.${table} OWNER TO ${ownerRole}`);
  await fixture.query(`ALTER FUNCTION mcp_identity.record_membership_audit() OWNER TO ${ownerRole}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`); createdRole = true;
  await fixture.query(`GRANT USAGE ON SCHEMA mcp_identity TO ${role}`);
  await fixture.query(`GRANT SELECT ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO ${role}`);
  await admin.query(`CREATE ROLE ${operatorRole} LOGIN PASSWORD '${password}'`); createdOperator = true;
  await fixture.query(`GRANT USAGE ON SCHEMA mcp_identity TO ${operatorRole}`);
  await fixture.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO ${operatorRole}`);
  const operatorUrl = new URL(fixtureUrl); operatorUrl.username = operatorRole; operatorUrl.password = password;
  operatorPool = new Pool({ connectionString: operatorUrl.href, connectionTimeoutMillis: 2000 });
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;

  await fixture.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a1','tenant-a'),('workspace-b1','tenant-b')");
  await fixture.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a1',$2),($1,'bob','workspace-b1',$2)", [issuer, GRANTS]);

  appDir = mkdtempSync(join(tmpdir(), "ingress-e2e-"));
  const appDb = join(appDir, "app.db");
  const keys = await generateKeyPair("ES256");
  const mint = async (subject, scope = GRANTS.join(" ")) => `Bearer ${await new SignJWT({ sub: subject, iss: issuer, aud: resource, exp: Math.floor(Date.now() / 1000) + 600, scope })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey)}`;
  const bobFull = await mint("bob");
  const aliceFull = await mint("alice");
  const bobReadOnly = await mint("bob", "memory:read");

  const liveUrl = new URL(fixtureUrl); liveUrl.username = role; liveUrl.password = password;
  const port = await startIngress({ connectionString: liveUrl.href, admission: new InMemoryInvocationAdmission({ global: 8, tenant: 8, workspace: 8, principal: 8 }) });

  // 1. Unauthenticated -> discoverable 401 challenge; wrong audience -> 401.
  const anonymous = await rawSend(port, "/team/mcp", { "x-workspace-id": "workspace-b1" });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["www-authenticate"], `Bearer resource_metadata="${metadata}"`); checks++;
  const badAudience = `Bearer ${await new SignJWT({ sub: "bob", iss: issuer, aud: "https://other.example.com/mcp", exp: Math.floor(Date.now() / 1000) + 600, scope: GRANTS.join(" ") }).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey)}`;
  assert.equal((await rawSend(port, "/team/mcp", { authorization: badAudience, "x-workspace-id": "workspace-b1" })).status, 401); checks++;

  // 2. Full chain: bob writes and reads back only his scope through HTTP+admission.
  await callTool(port, bobFull, "workspace-b1", "remember_note", { text: "B1 ingress note" });
  const bobRecall = await callTool(port, bobFull, "workspace-b1", "recall_notes", {});
  assert.match(JSON.stringify(bobRecall.content), /B1 ingress note/); checks++;

  // 3. Alice's chain lands in a different tenant/workspace scope.
  await callTool(port, aliceFull, "workspace-a1", "remember_note", { text: "A1 ingress note" });
  const aliceRecall = await callTool(port, aliceFull, "workspace-a1", "recall_notes", {});
  assert.match(JSON.stringify(aliceRecall.content), /A1 ingress note/);
  assert.doesNotMatch(JSON.stringify(aliceRecall.content), /B1 ingress note/); checks++;
  const bobRecall2 = await callTool(port, bobFull, "workspace-b1", "recall_notes", {});
  assert.doesNotMatch(JSON.stringify(bobRecall2.content), /A1 ingress note/); checks++;

  // 4. Scope insufficiency: memory:read token cannot drive a memory:write tool.
  await assert.rejects(callTool(port, bobReadOnly, "workspace-b1", "remember_note", { text: "escalation" }), /forbidden/); checks++;
  const stillOnly = await callTool(port, bobFull, "workspace-b1", "recall_notes", {});
  assert.doesNotMatch(JSON.stringify(stillOnly.content), /escalation/); checks++;

  // 5. HTTP-layer revocation: after the live authority revokes bob, requests fail closed.
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id='bob' AND workspace_id='workspace-b1'", [issuer]);
  assert.equal((await rawSend(port, "/team/mcp", { authorization: bobFull, "x-workspace-id": "workspace-b1" })).status, 403); checks++;
  const aliceUnaffected = await callTool(port, aliceFull, "workspace-a1", "recall_notes", {});
  assert.match(JSON.stringify(aliceUnaffected.content), /A1 ingress note/); checks++;

  // 6. Unreachable authority -> 503 fail closed at the HTTP boundary (D3-V3 input).
  const deadUrl = new URL(fixtureUrl); deadUrl.hostname = "127.0.0.1"; deadUrl.port = "9";
  const deadPort = await startIngress({ connectionString: deadUrl.href, admission: new InMemoryInvocationAdmission({ global: 8, tenant: 8, workspace: 8, principal: 8 }) });
  const unreachable = await rawSend(deadPort, "/team/mcp", { authorization: aliceFull, "x-workspace-id": "workspace-a1" });
  assert.equal(unreachable.status, 503); checks++;

  // 7. Admission: principal concurrency cap rejects the third parallel slow call.
  const gatedPort = await startIngress({ connectionString: liveUrl.href, admission: new InMemoryInvocationAdmission({ global: 8, tenant: 8, workspace: 8, principal: 2 }) });
  const slow = [callTool(gatedPort, aliceFull, "workspace-a1", "slow_probe", {}), callTool(gatedPort, aliceFull, "workspace-a1", "slow_probe", {})];
  await new Promise(resolve => setTimeout(resolve, 80));
  await assert.rejects(callTool(gatedPort, aliceFull, "workspace-a1", "slow_probe", {}), /concurrency_exceeded/); checks++;
  assert.equal((await Promise.all(slow)).length, 2);

  console.log(`Hosted ingress end-to-end passed: ${checks} checks (auth matrix, tenant isolation, revocation, fail-closed authority, admission)`);
} finally {
  for (const client of clients.splice(0)) { try { await client.close(); } catch { /* already closed */ } }
  for (const server of servers.splice(0)) { try { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); } catch { /* already closed */ } }
  await Promise.all(resolvers.map(resolver => resolver.close()));
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
  if (appDir) rmSync(appDir, { recursive: true, force: true });
}
