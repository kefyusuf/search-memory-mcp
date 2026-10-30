#!/usr/bin/env node
/**
 * Faz C provisioning end-to-end acceptance: spawns the REAL compiled hosted
 * server with BOTH surfaces (MCP ingress + admin provisioning API) against a
 * disposable PostgreSQL identity fixture, then proves the operator workflow:
 * admin auth, workspace creation, membership grant, pilot token mint, the
 * minted token driving hosted tools end-to-end, revocation propagating to a
 * 403 at the MCP boundary, and automatic audit coverage. Synthetic fixtures
 * only; no deployment, no real user data.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Pool } from "pg";
import { generateKeyPair, exportSPKI, exportPKCS8 } from "jose";
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
const database = `websearch_provision_test_${suffix}`;
const role = `prov_reader_${suffix}`;
const operatorRole = `prov_operator_${suffix}`;
const ownerRole = `prov_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/team/mcp";
const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp";
const GRANTS = ["memory:read", "memory:write", "search:read", "content:read", "knowledge:read", "knowledge:write", "status:read"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
let child;
const clients = [];
let checks = 0;
const rawSend = (port, path, headers = {}, method = "POST", body = "") =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: { host: "mcp.example.com", ...headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    }); req.on("error", reject); req.end(body);
  });
const adminSend = (port, path, token, method, body) =>
  rawSend(port, path, { authorization: `Bearer ${token}`, "content-type": "application/json" }, method ?? "POST", body ? JSON.stringify(body) : "");
async function callTool(port, token, workspaceId, name, args) {
  const client = new Client({ name: "provision-e2e-client", version: "1.0.0" });
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
async function stopChild() {
  if (!child) return;
  if (childExited) return;
  const exited = new Promise(resolve => child.once("exit", () => { childExited = true; resolve(); }));
  child.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => "exited"), new Promise(resolve => setTimeout(() => resolve("timeout"), 5000))]);
  if (result === "timeout") child.kill("SIGKILL");
  await exited;
  child = undefined;
}
async function waitForLine(stderr, pattern, message) {
  const existing = childStderrLines.find(line => pattern.test(line));
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const onLine = line => { childStderrLines.push(line); if (pattern.test(line)) { cleanup(); resolve(line); } };
    const onExit = code => { cleanup(); reject(new Error(`${message} (server exited, code ${code}): ${childStderrLines.slice(-14).join(String.fromCharCode(10))}`)); };
    const cleanup = () => { stderr.off("line", onLine); child.off("exit", onExit); clearTimeout(timer); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`${message} (timeout): ${childStderrLines.slice(-6).join(" | ")}`)); }, 15_000);
    stderr.on("line", onLine);
    child.once("exit", onExit);
  });
}
let childStderrLines = [];
let childExited = false;
try {
  // --- Fixture database ---
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
  await fixture.query(`GRANT SELECT ON mcp_identity.workspaces, mcp_identity.workspace_memberships, mcp_identity.membership_audit TO ${role}`);
  await admin.query(`CREATE ROLE ${operatorRole} LOGIN PASSWORD '${password}'`); createdOperator = true;
  await fixture.query(`GRANT USAGE ON SCHEMA mcp_identity TO ${operatorRole}`);
  await fixture.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO ${operatorRole}`);
  const operatorUrl = new URL(fixtureUrl); operatorUrl.username = operatorRole; operatorUrl.password = password;
  operatorPool = new Pool({ connectionString: operatorUrl.href, connectionTimeoutMillis: 2000 });

  // --- Keys: the operator's key pair (mint + verify) ---
  const keys = await generateKeyPair("ES256", { extractable: true });
  const scratch = mkdtempSync(join(tmpdir(), "provision-e2e-"));
  const publicFile = join(scratch, "public.spki");
  const privateFile = join(scratch, "private.pkcs8");
  writeFileSync(publicFile, await exportSPKI(keys.publicKey));
  writeFileSync(privateFile, await exportPKCS8(keys.privateKey));

  // --- Spawn the real server with BOTH surfaces ---
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  const adminToken = randomBytes(32).toString("hex");
  child = spawn(process.execPath, [join(process.cwd(), "build/hosted/server.js")], {
    env: {
      ...process.env,
      HOSTED_HTTP_PORT: "0",
      HOSTED_ADMIN_PORT: "0",
      HOSTED_BIND: "127.0.0.1",
      HOSTED_ISSUER: issuer,
      HOSTED_AUDIENCE: resource,
      HOSTED_ALLOWED_ORIGINS: "https://app.example.com",
      HOSTED_JWT_ALGORITHM: "ES256",
      HOSTED_PUBLIC_KEY_FILE: publicFile,
      HOSTED_TOKEN_PRIVATE_KEY_FILE: privateFile,
      HOSTED_ADMIN_TOKEN: adminToken,
      HOSTED_ADMIN_DATABASE_URL: operatorUrl.href,
      HOSTED_MEMBERSHIP_DATABASE_URL: readerUrl.href,
      HOSTED_APP_DB: join(scratch, "app.db"),
      HOSTED_ADMIT_GLOBAL: "8",
      HOSTED_ADMIT_TENANT: "8",
      HOSTED_ADMIT_WORKSPACE: "8",
      HOSTED_ADMIT_PRINCIPAL: "8",
      SEARCH_PROVIDERS: "duckduckgo",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.once("exit", () => { childExited = true; });
  childStderrLines = [];
  const stderrLines = createInterface({ input: child.stderr });
  const mainPort = Number((await waitForLine(stderrLines, /Hosted MCP server listening on [^\s]*:(\d+)/, "main port")).match(/:(\d+)/)[1]);
  const adminPort = Number((await waitForLine(stderrLines, /Provisioning API listening on [^\s]*:(\d+)/, "admin port")).match(/:(\d+)/)[1]);

  // 1. Admin auth: missing and wrong tokens are rejected before any work.
  assert.equal((await rawSend(adminPort, "/admin/workspaces", {})).status, 401); checks++;
  assert.equal((await adminSend(adminPort, "/admin/workspaces", "wrong-token", "GET")).status, 401); checks++;

  // 2. Provision: create workspace + grant membership via the admin API.
  const created = await adminSend(adminPort, "/admin/workspaces", adminToken, "POST", { workspaceId: "ws-pilot", tenantId: "tenant-pilot" });
  assert.equal(created.status, 200); checks++;
  const granted = await adminSend(adminPort, "/admin/memberships", adminToken, "POST", { principalId: "carol", workspaceId: "ws-pilot" });
  assert.equal(granted.status, 200); checks++;

  // 3. Mint a pilot user token and drive the hosted tools end-to-end with it.
  const minted = await adminSend(adminPort, "/admin/tokens", adminToken, "POST", { principalId: "carol", workspaceId: "ws-pilot" });
  assert.equal(minted.status, 200);
  const mintPayload = JSON.parse(minted.text);
  assert.ok(mintPayload.token?.split(".").length === 3, "minted a compact JWT");
  assert.equal(mintPayload.mcpEndpoint, resource); checks++;
  await callTool(mainPort, `Bearer ${mintPayload.token}`, "ws-pilot", "remember", { text: "Carol pilot note", topic: "pilot" });
  const carolRecall = await callTool(mainPort, `Bearer ${mintPayload.token}`, "ws-pilot", "recall", { query: "pilot" });
  assert.match(JSON.stringify(carolRecall.content), /Carol pilot note/); checks++;

  // 4. Revocation via the admin API propagates to the MCP boundary.
  const revoked = await adminSend(adminPort, "/admin/memberships/revoke", adminToken, "POST", { principalId: "carol", workspaceId: "ws-pilot" });
  assert.equal(revoked.status, 200); checks++;
  assert.equal((await rawSend(mainPort, "/team/mcp", { authorization: `Bearer ${mintPayload.token}`, "x-workspace-id": "ws-pilot" })).status, 403); checks++;
  const mintAfterRevoke = await adminSend(adminPort, "/admin/tokens", adminToken, "POST", { principalId: "carol", workspaceId: "ws-pilot" });
  assert.equal(mintAfterRevoke.status, 404); checks++;

  // 5. The listing shows the workspace and the revoked membership state.
  const listed = JSON.parse((await adminSend(adminPort, "/admin/workspaces", adminToken, "GET")).text);
  assert.ok(listed.workspaces.some(ws => ws.workspace_id === "ws-pilot")); checks++;
  assert.ok(listed.memberships.some(m => m.principal_id === "carol" && m.workspace_id === "ws-pilot" && m.revoked_at !== null)); checks++;

  // 6. Audit coverage: the provisioning operations wrote membership events.
  const auditRows = (await fixture.query("SELECT action, count(*)::int AS count FROM mcp_identity.membership_audit WHERE entity_type='membership' GROUP BY action")).rows;
  const auditByAction = Object.fromEntries(auditRows.map(row => [row.action, row.count]));
  assert.ok((auditByAction.INSERT ?? 0) >= 1, "membership grant is audited"); checks++;
  assert.ok((auditByAction.UPDATE ?? 0) >= 1, "membership revocation is audited"); checks++;

  // 7. Faz D operator panel: token-protected HTML, no leaks without auth.
  const panelAnonymous = await rawSend(adminPort, "/admin/panel", {});
  assert.equal(panelAnonymous.status, 401); checks++;
  const panel = await rawSend(adminPort, "/admin/panel", { authorization: `Bearer ${adminToken}` });
  assert.equal(panel.status, 200); checks++;
  assert.match(panel.text, /Hosted Pilot Paneli/);
  assert.match(panel.text, /mcp\.example\.com/); checks++;
  const panelWrongToken = await rawSend(adminPort, "/admin/panel", { authorization: "Bearer wrong" });
  assert.equal(panelWrongToken.status, 401); checks++;

  console.log(`Provisioning verification passed: ${checks} checks (admin auth, provisioning, minted-token chain, revocation, audit, panel)`);
} finally {
  if (childStderrLines.length > 0) console.error("child stderr tail:", childStderrLines.slice(-6).join(" | "));
  await stopChild();
  for (const client of clients.splice(0)) { try { await client.close(); } catch { /* already closed */ } }
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
}
