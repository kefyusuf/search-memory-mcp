#!/usr/bin/env node
/**
 * Hosted bootstrap end-to-end acceptance: spawns the REAL compiled hosted
 * server (build/hosted/server.js) on a loopback port with a disposable
 * PostgreSQL identity fixture and drives it with the MCP client. Asserts
 * the auth matrix, the memory tool chain with cross-tenant isolation, the
 * disabled-tool fence, and HTTP-layer revocation. Synthetic fixtures only;
 * no deployment, no real user data.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { generateKeyPair, SignJWT, exportSPKI } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createServer, request as httpRequest } from "node:http";

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_bootstrap_test_${suffix}`;
const role = `bootstrap_reader_${suffix}`;
const operatorRole = `bootstrap_operator_${suffix}`;
const ownerRole = `bootstrap_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/team/mcp";
const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp";
const GRANTS = ["memory:read", "memory:write", "search:read", "knowledge:read", "knowledge:write", "status:read", "content:read"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
let child; let childStderrLines = [];
let checks = 0;
const servers = [];
const clients = [];
const rawSend = (port, path, headers = {}, method = "POST", body = "") =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: "mcp.example.com", ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    }); req.on("error", reject); req.end(body);
  });
async function waitForPort(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await new Promise(resolve => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/team/mcp", method: "POST", headers: { host: "mcp.example.com" } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", () => resolve(null));
      req.end("");
    });
    if (probe !== null) return probe;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`hosted server did not open a port within ${timeoutMs} ms`);
}
async function callTool(port, token, workspaceId, name, args) {
  const client = new Client({ name: "bootstrap-e2e-client", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/team/mcp`), {
    requestInit: { headers: { authorization: token, "x-workspace-id": workspaceId } },
    fetch: async (_url, init) => {
      const result = await rawSend(port, "/team/mcp", Object.fromEntries(new Headers(init?.headers)), init?.method, init?.body);
      return new Response(result.text || null, { status: result.status, headers: result.headers });
    },
  }));
  return client.callTool({ name, arguments: args ?? {} });
}
async function listTools(port, token, workspaceId) {
  const client = new Client({ name: "bootstrap-e2e-client", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/team/mcp`), {
    requestInit: { headers: { authorization: token, "x-workspace-id": workspaceId } },
    fetch: async (_url, init) => {
      const result = await rawSend(port, "/team/mcp", Object.fromEntries(new Headers(init?.headers)), init?.method, init?.body);
      return new Response(result.text || null, { status: result.status, headers: result.headers });
    },
  }));
  return client.listTools();
}
async function stopChild() {
  if (!child) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => "exited"), new Promise(resolve => setTimeout(() => resolve("timeout"), 5000))]);
  if (result === "timeout") child.kill("SIGKILL");
  await exited;
  child = undefined;
}
try {
  // --- Fixture database: live identity authority (never restored) ---
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
  const operator = await operatorPool.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a1','tenant-a'),('workspace-b1','tenant-b') RETURNING workspace_id");
  assert.equal(operator.rowCount, 2);
  await operatorPool.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a1',$2),($1,'bob','workspace-b1',$2)", [issuer, GRANTS]);

  // --- Keys + key file for the child server ---
  const keys = await generateKeyPair("ES256");
  const scratch = mkdtempSync(join(tmpdir(), "bootstrap-e2e-"));
  const keyFile = join(scratch, "public.spki");
  writeFileSync(keyFile, await exportSPKI(keys.publicKey));
  const appDb = join(scratch, "app.db");
  const mint = async (subject, scope = GRANTS.join(" ")) => `Bearer ${await new SignJWT({ sub: subject, iss: issuer, aud: resource, exp: Math.floor(Date.now() / 1000) + 600, scope })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey)}`;
  const bobFull = await mint("bob");
  const aliceFull = await mint("alice");
  const bobReadOnly = await mint("bob", "memory:read");

  // --- Spawn the REAL compiled hosted server ---
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  child = spawn(process.execPath, [join(process.cwd(), "build/hosted/server.js")], {
    env: {
      ...process.env,
      HOSTED_HTTP_PORT: "0",
      HOSTED_BIND: "127.0.0.1",
      HOSTED_ISSUER: issuer,
      HOSTED_AUDIENCE: resource,
      HOSTED_ALLOWED_ORIGINS: "https://app.example.com",
      HOSTED_JWT_ALGORITHM: "ES256",
      HOSTED_PUBLIC_KEY_FILE: keyFile,
      HOSTED_MEMBERSHIP_DATABASE_URL: readerUrl.href,
      HOSTED_APP_DB: appDb,
      HOSTED_ADMIT_GLOBAL: "8",
      HOSTED_ADMIT_TENANT: "8",
      HOSTED_ADMIT_WORKSPACE: "8",
      HOSTED_ADMIT_PRINCIPAL: "8",
      HOSTED_LOOKUP_CONCURRENCY: "4",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  childStderrLines = [];
  const stderrLines = createInterface({ input: child.stderr });
  const portPromise = new Promise((resolve, reject) => {
    stderrLines.on("line", line => {
      childStderrLines.push(line);
      const match = line.match(/listening on [^\s]*:(\d+)/);
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", code => reject(new Error(`hosted server exited early (code ${code}): ${childStderrLines.slice(-6).join(" | ")}`)));
    setTimeout(() => reject(new Error(`hosted server never reported a port: ${childStderrLines.slice(-6).join(" | ")}`)), 15_000);
  });
  const port = await portPromise;

  // 1. Unauthenticated -> discoverable 401 challenge.
  const anonymous = await rawSend(port, "/team/mcp", { "x-workspace-id": "workspace-b1" });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers["www-authenticate"], `Bearer resource_metadata="${metadata}"`); checks++;

  // 2. Catalog: the MCP client sees all 12 advertised tools.
  const catalog = await listTools(port, bobFull, "workspace-b1");
  assert.equal(catalog.tools.length, 12); checks++;

  // 3. Full memory chain: bob writes and reads back only his scope.
  await callTool(port, bobFull, "workspace-b1", "remember", { text: "B1 bootstrap note", topic: "e2e" });
  const bobRecall = await callTool(port, bobFull, "workspace-b1", "recall", { query: "bootstrap" });
  assert.match(JSON.stringify(bobRecall.content), /B1 bootstrap note/); checks++;

  // 4. Alice's chain lands in a different tenant/workspace scope.
  await callTool(port, aliceFull, "workspace-a1", "remember", { text: "A1 bootstrap note", topic: "e2e" });
  const aliceRecall = await callTool(port, aliceFull, "workspace-a1", "recall", { query: "bootstrap" });
  assert.match(JSON.stringify(aliceRecall.content), /A1 bootstrap note/);
  assert.doesNotMatch(JSON.stringify(aliceRecall.content), /B1 bootstrap note/); checks++;
  const bobRecall2 = await callTool(port, bobFull, "workspace-b1", "recall", {});
  assert.doesNotMatch(JSON.stringify(bobRecall2.content), /A1 bootstrap note/); checks++;

  // 5. Scope insufficiency: memory:read token cannot drive memory:write — the
  // dispatcher rejection surfaces as a tool error carrying the code.
  const denied = await callTool(port, bobReadOnly, "workspace-b1", "remember", { text: "escalation" });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.content), /forbidden/); checks++;
  const stillOnly = await callTool(port, bobFull, "workspace-b1", "recall", {});
  assert.doesNotMatch(JSON.stringify(stillOnly.content), /escalation/); checks++;

  // 6. Rollout slice 2: web_search is hosted-enabled (no mode fence), while
  // the knowledge tools remain fenced.
  const webSearch = await callTool(port, aliceFull, "workspace-a1", "web_search", { query: "example" });
  assert.doesNotMatch(JSON.stringify(webSearch), /execution_mode_unavailable/); checks++;
  const fencedKnowledge = await callTool(port, aliceFull, "workspace-a1", "search_index", { query: "anything" });
  assert.equal(fencedKnowledge.isError, true);
  assert.match(JSON.stringify(fencedKnowledge.content), /execution_mode_unavailable/); checks++;

  // 7. HTTP-layer revocation: after the live authority revokes bob, 403 fail closed.
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id='bob' AND workspace_id='workspace-b1'", [issuer]);
  assert.equal((await rawSend(port, "/team/mcp", { authorization: bobFull, "x-workspace-id": "workspace-b1" })).status, 403); checks++;
  const aliceUnaffected = await callTool(port, aliceFull, "workspace-a1", "recall", {});
  assert.match(JSON.stringify(aliceUnaffected.content), /A1 bootstrap note/); checks++;

  console.log(`Hosted bootstrap verification passed: ${checks} checks (auth matrix, memory chain, isolation, disabled-tool fence, revocation)`);
} finally {
  await stopChild();
  for (const client of clients.splice(0)) { try { await client.close(); } catch { /* already closed */ } }
  for (const server of servers.splice(0)) { try { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); } catch { /* already closed */ } }
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
}
