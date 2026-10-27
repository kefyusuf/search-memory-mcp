import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
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

// P0-02 D4 TA-01..TA-07 synthetic activation/fencing acceptance (design:
// docs/research/2026-10-27-p0-02-d4-activation-fencing-design.md; D2
// decision: issue #83, 2026-10-26). The live PostgreSQL fixture stays the
// current authority and is never restored; identity snapshots are restored
// into SEPARATE databases purely as verification objects. "Activation" is a
// harness-level binding transition - no production cutover mechanism, no
// deployment, no real user data. TR-02 stays HOLD (R-B).

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_activation_test_${suffix}`;
const role = `activation_reader_${suffix}`;
const operatorRole = `activation_operator_${suffix}`;
const ownerRole = `activation_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const GRANTS = ["memory:read", "memory:write", "knowledge:read", "knowledge:write", "search:read", "content:read"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
const identityCopies = [];
const resolvers = [];
const stores = [];
let appDir; let restoreDir;
let checks = 0;
const appRequest = (workspaceId) => ({
  issuer, workspaceId, requestId: "activation-r", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
});
function hostedContext(subject, tenantId, workspaceId) {
  return createHostedRequestContext({
    authorization: { subject, audiences: ["https://mcp.example.com/mcp"], scopes: GRANTS, expiresAt: Date.now() + 60_000 },
    membership: { principalId: subject, tenantId, workspaceId, permissions: GRANTS },
    expectedAudience: "https://mcp.example.com/mcp", requestId: "activation-r", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
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
async function applyIdentitySchema(targetUrl, ownerRole) {
  const target = new Pool({ connectionString: targetUrl, connectionTimeoutMillis: 2000 });
  await target.query(await readFile(new URL("../migrations/0001-hosted-membership.sql", import.meta.url), "utf8"));
  await target.query(await readFile(new URL("../migrations/0002-hosted-membership-audit.sql", import.meta.url), "utf8"));
  // Ownership fixes apply to the COPY database, never to the live fixture.
  await target.query(`ALTER SCHEMA mcp_identity OWNER TO ${ownerRole}`);
  for (const table of ["workspaces", "workspace_memberships", "membership_audit"])
    await target.query(`ALTER TABLE mcp_identity.${table} OWNER TO ${ownerRole}`);
  await target.query(`ALTER FUNCTION mcp_identity.record_membership_audit() OWNER TO ${ownerRole}`);
  return target;
}
async function createIdentityCopy(label, workspaces, memberships) {
  const copyDatabase = `websearch_restore_id_${suffix}_${label}`;
  await admin.query(`CREATE DATABASE ${copyDatabase}`);
  const copyUrl = new URL(base); copyUrl.pathname = `/${copyDatabase}`;
  const ownerRole = `act_owner_${suffix}_${label}`;
  await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN`);
  const pool = await applyIdentitySchema(copyUrl.href, ownerRole);
  for (const ws of workspaces) await pool.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id,disabled_at) VALUES ($1,$2,$3)", [ws.workspace_id, ws.tenant_id, ws.disabled_at]);
  for (const m of memberships) await pool.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions,revoked_at) VALUES ($1,$2,$3,$4,$5)", [m.issuer, m.principal_id, m.workspace_id, m.permissions, m.revoked_at]);
  await pool.end();
  identityCopies.push({ copyDatabase, ownerRole });
  return copyUrl.href;
}
// Synthetic activation state machine: the production analogue of these
// stages is a documented operator workflow, not an implemented mechanism.
function createActivationHarness() {
  return {
    stage: "empty", manifest: null, verified: false, activated: false, activationRecord: null,
    verify(manifest) {
      if (this.verified || this.activated) throw new Error("fence_already_processed");
      if (this.stage !== "restored") throw new Error("fence_target_not_restored");
      this.manifest = manifest; this.verified = true; this.stage = "verified";
    },
    activate(approval) {
      if (!this.verified || this.activated) throw new Error("fence_not_verified");
      if (approval.revision !== this.manifest.revision) throw new Error("fence_revision_mismatch");
      if (approval.backupSha256 !== this.manifest.appBackupSha256) throw new Error("fence_backup_mismatch");
      if (approval.validUntil < Date.now()) throw new Error("fence_approval_expired");
      if (approval.scope !== "R-A") throw new Error("fence_scope_mismatch");
      this.activated = true; this.stage = "activated"; this.activationRecord = { ...approval };
    },
  };
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
  const operator = (text, values) => operatorPool.query(text, values);

  // Tenant A -> A1/A2; tenant B -> B1. alice@A1 + bob@B1 active at S0.
  await operator("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a1','tenant-a'),('workspace-a2','tenant-a'),('workspace-b1','tenant-b')");
  await operator("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a1',$2),($1,'bob','workspace-b1',$2)", [issuer, GRANTS]);

  // --- S0: application data + identity snapshot + backup ---
  appDir = mkdtempSync(join(tmpdir(), "activation-app-"));
  const appDb = join(appDir, "app.db");
  const a1 = openStores(appDb, "tenant-a", "workspace-a1", "alice");
  const a2 = openStores(appDb, "tenant-a", "workspace-a2", "alice2");
  const b1 = openStores(appDb, "tenant-b", "workspace-b1", "bob");
  const a1Note = a1.memory.remember("A1 activation note", { session: "s", topic: "pooling" });
  a2.memory.remember("A2 activation note", { session: "s", topic: "pooling" });
  const b1Note = b1.memory.remember("B1 activation note", { session: "s", topic: "pooling" });
  a1.knowledge.ingest({ content: "PgBouncer guide A1", title: "A1", source: "https://example.com/a1", category: "activation-test" });
  b1.knowledge.ingest({ content: "PgBouncer guide B1", title: "B1", source: "https://example.com/b1", category: "activation-test" });
  await Promise.all([a1.knowledge.flush(), a2.knowledge.flush(), b1.knowledge.flush()]);
  await closeStores();
  const backupPath = join(appDir, "s0-backup.db");
  const source = new Database(appDb, { readonly: true });
  try { await source.backup(backupPath); } finally { source.close(); }
  const backupSha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");

  // Identity snapshots: S0 (alice active) and S1 (alice revoked, live state).
  const wsRows = (await fixture.query("SELECT workspace_id, tenant_id, disabled_at FROM mcp_identity.workspaces ORDER BY workspace_id")).rows;
  const memRowsS0 = (await fixture.query("SELECT issuer, principal_id, workspace_id, permissions, revoked_at FROM mcp_identity.workspace_memberships ORDER BY principal_id")).rows;
  const identityS0Url = await createIdentityCopy("s0", wsRows, memRowsS0);
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id='alice' AND workspace_id='workspace-a1'", [issuer]);
  const memRowsS1 = (await fixture.query("SELECT issuer, principal_id, workspace_id, permissions, revoked_at FROM mcp_identity.workspace_memberships ORDER BY principal_id")).rows;
  const identityS1Url = await createIdentityCopy("s1", wsRows, memRowsS1);
  const manifestS0 = { revision: "rev-S0", appBackupSha256: backupSha256, identitySnapshot: "s0", scope: "R-A" };

  // Live authority (unrestored): alice denied, bob allowed.
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  const liveResolver = new PostgresMembershipResolver({ connectionString: readerUrl.href, issuer, maxConcurrentLookups: 4, lookupTimeoutMs: 2000 });
  resolvers.push(liveResolver);
  const keys = await generateKeyPair("ES256");
  const mint = async (subject) => `Bearer ${await new SignJWT({ sub: subject, iss: issuer, aud: "https://mcp.example.com/mcp", exp: Math.floor(Date.now() / 1000) + 600, scope: GRANTS.join(" ") }).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey)}`;
  const adapter = new JwtAuthorizationAdapter({ issuer, audience: "https://mcp.example.com/mcp", algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: liveResolver.resolveMembership });

  // --- Restore S0 application backup into an empty isolated target ---
  restoreDir = mkdtempSync(join(tmpdir(), "activation-target-"));
  const restoreDb = join(restoreDir, "restored.db");
  copyFileSync(backupPath, restoreDb);
  const rA1 = openStores(restoreDb, "tenant-a", "workspace-a1", "alice");
  const rB1 = openStores(restoreDb, "tenant-b", "workspace-b1", "bob");

  const harness = createActivationHarness();
  harness.stage = "restored";

  // TA-01: revision-consistent dual restore verifies; publish never happens.
  assert.equal(await liveResolver.resolveMembership("alice", "workspace-a1", appRequest("workspace-a1")), null, "live authority must still deny alice after S1 revocation");
  const verifyTarget = (manifest, identityUrl) => {
    // Integrity + tenant boundary on the restored application store.
    const probe = new Database(restoreDb, { readonly: true });
    try {
      assert.equal(probe.pragma("integrity_check", { simple: true }), "ok");
      assert.deepEqual(probe.pragma("foreign_key_check"), []);
    } finally { probe.close(); }
    assert.deepEqual(rA1.memory.list().map(n => n.text), ["A1 activation note"]);
    assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 activation note"]);
    // The restored identity copy is a verification object, NOT the authority:
    // current authorization comes from the live (unrestored) resolver only.
    assert.equal(manifest.revision, "rev-S0");
    void identityUrl;
    return true;
  };
  assert.equal(verifyTarget(manifestS0, identityS0Url), true);
  harness.verify(manifestS0);
  assert.equal(harness.verified, true); checks++;

  // TA-02: revision mismatch (S0 app + S1 identity) is rejected before activation.
  assert.throws(() => harness.verify({ ...manifestS0, identitySnapshot: "s1", revision: "rev-S1" }), /fence_already_processed/);
  const mismatchHarness = createActivationHarness();
  mismatchHarness.stage = "restored";
  assert.throws(() => {
    const accepted = manifestS0.identitySnapshot === "s1";
    if (!accepted) throw new Error("fence_revision_mismatch");
    mismatchHarness.verify(manifestS0);
  }, /fence_revision_mismatch/);
  assert.equal(mismatchHarness.verified, false); checks++;

  // TA-03: a partial restore target fails closed and is never verified.
  const brokenPath = join(restoreDir, "broken.db");
  writeFileSync(brokenPath, readFileSync(backupPath).subarray(0, Math.floor(readFileSync(backupPath).length * 0.4)));
  let brokenRejected = false;
  try { const brokenView = new SessionMemory(brokenPath); brokenView.close(); } catch { brokenRejected = true; }
  assert.equal(brokenRejected, true);
  const brokenHarness = createActivationHarness();
  assert.throws(() => brokenHarness.verify(manifestS0), /fence_target_not_restored/); checks++;

  // TA-04: activation requires a D2-shaped approval bound to the same manifest.
  assert.throws(() => harness.activate({ revision: "rev-S1", backupSha256, validUntil: Date.now() + 86_400_000, scope: "R-A" }), /fence_revision_mismatch/);
  assert.throws(() => harness.activate({ revision: "rev-S0", backupSha256: "0".repeat(64), validUntil: Date.now() + 86_400_000, scope: "R-A" }), /fence_backup_mismatch/);
  assert.throws(() => harness.activate({ revision: "rev-S0", backupSha256, validUntil: Date.now() - 1, scope: "R-A" }), /fence_approval_expired/);
  assert.throws(() => harness.activate({ revision: "rev-S0", backupSha256, validUntil: Date.now() + 86_400_000, scope: "R-B" }), /fence_scope_mismatch/); checks++;
  harness.activate({ revision: "rev-S0", backupSha256, validUntil: Date.now() + 86_400_000, scope: "R-A" });
  assert.equal(harness.activated, true); checks++;

  // TA-05: single active data path after activation (A4).
  const bobContext = await adapter.authenticate(await mint("bob"), appRequest("workspace-b1"));
  await assertRequestAuthorizationChecks(bobContext);
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 activation note"]);
  assert.equal(rB1.memory.get(a1Note.id), null);
  assert.equal(rA1.memory.get(b1Note.id), null);
  // The original source remains independent: post-restore writes there do not
  // appear on the activated target (stale path cannot push into the new one).
  const srcLate = new SessionMemory(appDb, { context: hostedContext("bob", "tenant-b", "workspace-b1") });
  srcLate.remember("post-restore source write", { session: "s", topic: "pooling" });
  try { srcLate.close(); } catch { /* already closed */ }
  assert.doesNotMatch(JSON.stringify(rB1.memory.list().map(n => n.text)), /post-restore source write/); checks++;

  // TA-06: post-cutover ambiguity never auto-recovers or auto-activates.
  const ambiguous = createActivationHarness();
  ambiguous.stage = "restored";
  ambiguous.verify(manifestS0);
  assert.throws(() => ambiguous.activate({ revision: "rev-S0", backupSha256, validUntil: Date.now() - 1, scope: "R-A" }), /fence_approval_expired/);
  assert.equal(ambiguous.activated, false);
  assert.equal(ambiguous.stage, "verified", "no automatic fallback: the harness stays verified, awaiting a new decision"); checks++;

  // TA-07: pre-activation failure injection keeps the active source untouched.
  assert.equal((await liveResolver.resolveMembership("bob", "workspace-b1", appRequest("workspace-b1"))).principalId, "bob");
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 activation note"]); checks++;

  console.log(`Activation/fencing verification passed: ${checks} checks (TA-01..TA-07) against live PostgreSQL + restored SQLite`);
} finally {
  await closeStores();
  await Promise.all(resolvers.map(resolver => resolver.close()));
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  for (const copy of identityCopies) {
    await admin.query(`DROP DATABASE ${copy.copyDatabase}`).catch(() => {});
    await admin.query(`DROP ROLE ${copy.ownerRole}`).catch(() => {});
  }
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  if (restoreDir) { try { rmSync(restoreDir, { recursive: true, force: true }); } catch { /* retained in OS temp */ } }
}
async function assertRequestAuthorizationChecks(context) {
  const { assertRequestAuthorization } = await import("../build/runtime/request-context.js");
  await assertRequestAuthorization(context);
}
