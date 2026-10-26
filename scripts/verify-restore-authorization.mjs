import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { generateKeyPair, SignJWT } from "jose";
import Database from "better-sqlite3";
import { PostgresMembershipResolver } from "../build/identity/postgres-membership.js";
import { JwtAuthorizationAdapter } from "../build/runtime/jwt-authorization.js";
import { createHostedRequestContext } from "../build/runtime/request-context.js";
import { SessionMemory } from "../build/memory/session-memory.js";
import { KnowledgeIndex } from "../build/knowledge/index-store.js";
import { EntityGraph } from "../build/graph/entity-graph.js";
import { SQLiteVectorStore } from "../build/cache/sqlite-store.js";

// P0-02 TR-03/TR-04/TR-05 synthetic acceptance (design:
// docs/research/2026-10-13-p0-02-restore-authorization-test-design.md; D2
// decision: issue #83, 2026-10-26). The live PostgreSQL identity fixture is
// the current authority and is never restored; the SQLite application backup
// is restored into an empty isolated target. No deployment, no real user
// data, no publish point; TR-02 stays HOLD (R-B).

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_restore_test_${suffix}`;
const role = `restore_reader_${suffix}`;
const operatorRole = `restore_operator_${suffix}`;
const ownerRole = `restore_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const audience = "https://mcp.example.com/mcp";
const GRANTS = ["memory:read", "memory:write", "knowledge:read", "knowledge:write", "search:read", "content:read"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
let reader;
const resolvers = [];
const stores = [];
let appDir; let restoreDir;
let checks = 0;
const appRequest = (workspaceId) => ({
  issuer, workspaceId, requestId: "restore-r", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
});
function hostedContext(subject, tenantId, workspaceId) {
  return createHostedRequestContext({
    authorization: { subject, audiences: [audience], scopes: GRANTS, expiresAt: Date.now() + 60_000 },
    membership: { principalId: subject, tenantId, workspaceId, permissions: GRANTS },
    expectedAudience: audience, requestId: "restore-r", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
  });
}
function track(store) { stores.push(store); return store; }
function openStores(dbPath, tenantId, workspaceId, subject) {
  const context = hostedContext(subject, tenantId, workspaceId);
  return {
    context,
    memory: track(new SessionMemory(dbPath, { context })),
    knowledge: track(new KnowledgeIndex(dbPath, { enableEmbeddings: false, context })),
    graph: track(new EntityGraph(dbPath, { context })),
    cache: track(new SQLiteVectorStore(dbPath, { context, useNativeVectors: false })),
  };
}
async function closeStores() {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
}
try {
  // --- Fixture database: the live identity authority (never restored) ---
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
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  reader = new Pool({ connectionString: readerUrl.href, connectionTimeoutMillis: 2000 });

  // Tenant A -> workspaces A1/A2; tenant B -> workspace B1 (same-URL/doc-id design).
  await fixture.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a1','tenant-a'),('workspace-a2','tenant-a'),('workspace-b1','tenant-b')");
  await fixture.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a1',$2),($1,'bob','workspace-b1',$2)", [issuer, GRANTS]);

  // --- S0: application data per scope in one SQLite file, then quiesce+backup ---
  appDir = mkdtempSync(join(tmpdir(), "restore-auth-app-"));
  const appDb = join(appDir, "app.db");
  const a1 = openStores(appDb, "tenant-a", "workspace-a1", "alice");
  const a2 = openStores(appDb, "tenant-a", "workspace-a2", "alice2");
  const b1 = openStores(appDb, "tenant-b", "workspace-b1", "bob");
  const a1Note = a1.memory.remember("A1 restore scenario note", { session: "s", topic: "pooling" });
  a2.memory.remember("A2 restore scenario note", { session: "s", topic: "pooling" });
  const b1Note = b1.memory.remember("B1 restore scenario note", { session: "s", topic: "pooling" });
  a1.knowledge.ingest({ content: "PgBouncer pooling guide for A1 workloads", title: "A1 doc", source: "https://example.com/a1-doc", category: "restore-test" });
  a2.knowledge.ingest({ content: "PgBouncer pooling guide for A2 workloads", title: "A2 doc", source: "https://example.com/a2-doc", category: "restore-test" });
  b1.knowledge.ingest({ content: "PgBouncer pooling guide for B1 workloads", title: "B1 doc", source: "https://example.com/b1-doc", category: "restore-test" });
  a1.graph.indexDocument({ docId: "shared-doc-id", source: "https://example.com/a1-doc", title: "A1 doc", content: "PgBouncer pooling" });
  a2.graph.indexDocument({ docId: "shared-doc-id", source: "https://example.com/a2-doc", title: "A2 doc", content: "PgBouncer pooling" });
  b1.graph.indexDocument({ docId: "shared-doc-id", source: "https://example.com/b1-doc", title: "B1 doc", content: "PgBouncer pooling" });
  await a1.cache.setContent("https://example.com/shared-url", "A1 cached content", "restore-test");
  await a2.cache.setContent("https://example.com/shared-url", "A2 cached content", "restore-test");
  await b1.cache.setContent("https://example.com/shared-url", "B1 cached content", "restore-test");
  await Promise.all([a1.knowledge.flush(), a2.knowledge.flush(), b1.knowledge.flush()]);
  await closeStores();
  const backupPath = join(appDir, "s0-backup.db");
  const source = new Database(appDb, { readonly: true });
  try { await source.backup(backupPath); } finally { source.close(); }

  // Stale Alice token minted at S0 (before revocation), still unexpired at S1.
  const keys = await generateKeyPair("ES256");
  const aliceToken = await new SignJWT({ sub: "alice", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 600, scope: GRANTS.join(" ") })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);
  const bobToken = await new SignJWT({ sub: "bob", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 600, scope: GRANTS.join(" ") })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);

  // --- S1: the live authority revokes alice outside any restore boundary ---
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id='alice' AND workspace_id='workspace-a1'", [issuer]);
  const liveResolver = new PostgresMembershipResolver({ connectionString: readerUrl.href, issuer, maxConcurrentLookups: 1, lookupTimeoutMs: 2000 });
  resolvers.push(liveResolver);
  const liveAdapter = new JwtAuthorizationAdapter({ issuer, audience, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: liveResolver.resolveMembership });

  // --- Restore S0 into an empty isolated target ---
  restoreDir = mkdtempSync(join(tmpdir(), "restore-auth-target-"));
  const restoreDb = join(restoreDir, "restored.db");
  copyFileSync(backupPath, restoreDb);
  const rA1 = openStores(restoreDb, "tenant-a", "workspace-a1", "alice");
  const rA2 = openStores(restoreDb, "tenant-a", "workspace-a2", "alice2");
  const rB1 = openStores(restoreDb, "tenant-b", "workspace-b1", "bob");

  // TR-03: the restored S0 state does not resurrect revoked access (I-2, D3-V2).
  await assert.rejects(liveAdapter.authenticate(`Bearer ${aliceToken}`, appRequest("workspace-a1")), /forbidden/); checks++;
  assert.equal(await liveResolver.resolveMembership("alice", "workspace-a1", appRequest("workspace-a1")), null); checks++;
  const bobContext = await liveAdapter.authenticate(`Bearer ${bobToken}`, appRequest("workspace-b1"));
  assert.equal(bobContext.tenantId, "tenant-b");
  assert.equal(bobContext.workspaceId, "workspace-b1");
  await assertRequestAuthorization(bobContext); checks++;
  // The only membership UPDATE in this fixture is alice's revocation; the audit
  // must contain it (provenance of the denial, D3-V1).
  const auditUpdates = await reader.query("SELECT count(*)::int AS count FROM mcp_identity.membership_audit WHERE entity_type='membership' AND action='UPDATE'");
  assert.ok(auditUpdates.rows[0].count >= 1, "the revocation must be audited"); checks++;

  // Restore completeness: the physical image carries every scope (TR-01 semantics).
  assert.deepEqual(rA1.memory.list().map(n => n.text), ["A1 restore scenario note"]);
  assert.deepEqual(rA2.memory.list().map(n => n.text), ["A2 restore scenario note"]);
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 restore scenario note"]);
  assert.equal(rA1.knowledge.getStats().docCount, 1);
  assert.equal(rA2.knowledge.getStats().docCount, 1);
  assert.deepEqual(rA1.graph.docsForEntity("PgBouncer").map(d => d.docId), ["shared-doc-id"]);
  assert.equal((await rA1.cache.getContent("https://example.com/shared-url"))?.content, "A1 cached content");
  checks++;

  // TR-05: scope isolation on the restored target — bob reaches only B1 (I-1).
  assert.equal(rB1.memory.get(a1Note.id), null);
  assert.equal(rA1.memory.get(b1Note.id), null);
  assert.deepEqual(rB1.knowledge.listDocs().map(d => d.source), ["https://example.com/b1-doc"]);
  assert.deepEqual(rB1.graph.docsForEntity("PgBouncer").map(d => d.source), ["https://example.com/b1-doc"]);
  assert.equal((await rB1.cache.getContent("https://example.com/shared-url"))?.content, "B1 cached content");
  checks++;

  // TR-05: forged/copied contexts are rejected by provenance (I-4).
  assert.throws(() => new SessionMemory(restoreDb, { context: { ...bobContext } }), /invalid_context/); checks++;
  const localView = new SessionMemory(restoreDb);
  assert.equal(localView.getStats().count, 0, "local scope must not see hosted rows in the restored file"); checks++;

  // TR-04: authority unreachable -> fail closed; restored data untouched.
  const deadUrl = new URL(fixtureUrl); deadUrl.hostname = "127.0.0.1"; deadUrl.port = "9";
  const deadResolver = new PostgresMembershipResolver({ connectionString: deadUrl.href, issuer, maxConcurrentLookups: 1, lookupTimeoutMs: 800 });
  resolvers.push(deadResolver);
  const deadAdapter = new JwtAuthorizationAdapter({ issuer, audience, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: deadResolver.resolveMembership });
  await assert.rejects(deadAdapter.authenticate(`Bearer ${bobToken}`, appRequest("workspace-b1")), /authorization_unavailable/); checks++;
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 restore scenario note"]);
  assert.equal(rB1.knowledge.getStats().docCount, 1); checks++;

  // TR-04: a broken/half restore fixture fails closed and is never verified.
  const full = readFileSync(backupPath);
  const brokenPath = join(restoreDir, "broken.db");
  writeFileSync(brokenPath, full.subarray(0, Math.floor(full.length * 0.4)));
  let brokenRejected = false;
  try {
    const brokenView = new SessionMemory(brokenPath);
    brokenView.close();
  } catch {
    brokenRejected = true;
  }
  assert.equal(brokenRejected, true, "a truncated restore target must not open as a usable store"); checks++;

  console.log(`Restore authorization verification passed: ${checks} checks (TR-03/TR-04/TR-05) against live PostgreSQL + restored SQLite`);
} finally {
  await closeStores();
  await Promise.all(resolvers.map(resolver => resolver.close()));
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (reader) await reader.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  if (restoreDir) rmSync(restoreDir, { recursive: true, force: true });
}
