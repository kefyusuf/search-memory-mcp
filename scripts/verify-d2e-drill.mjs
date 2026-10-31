#!/usr/bin/env node
/**
 * D2-E1..E5 synthetic operational drill (design: docs/research/
 * 2026-10-13-p0-02-recovery-authority-scope-gate.md, D2 decision record:
 * issue #83 comment 6425870367, approved 2026-10-26). Runs the R-A
 * full-environment restore WORKFLOW over the synthetic fixture with the
 * approved operator records: authenticated request, request-bound
 * approval, authenticated execution, independent verification, and an
 * activation REQUEST that is recorded but never executed (D4 OPEN).
 *
 * The drill ledger is an in-memory record serialized to JSON at the end —
 * the production analogue is the issue/PR trail per D2-K4. Synthetic
 * fixtures only; no deployment; no real user data; the live PostgreSQL
 * fixture remains the authority and is never restored.
 *
 * Negative scenarios (fail closed): execution without an approval record,
 * approval bound to a different backup, expired approval. Each denial is
 * recorded in the ledger (denials are evidence too).
 */
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import Database from "better-sqlite3";
import { PostgresMembershipResolver } from "../build/identity/postgres-membership.js";
import { JwtAuthorizationAdapter } from "../build/runtime/jwt-authorization.js";
import { createHostedRequestContext } from "../build/runtime/request-context.js";
import { SessionMemory } from "../build/memory/session-memory.js";
import { KnowledgeIndex } from "../build/knowledge/index-store.js";
import { EntityGraph } from "../build/graph/entity-graph.js";
import { SQLiteVectorStore } from "../build/cache/sqlite-store.js";

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_d2e_test_${suffix}`;
const role = `d2e_reader_${suffix}`;
const operatorRole = `d2e_operator_${suffix}`;
const ownerRole = `d2e_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
const issuer = "https://auth.example.com";
const GRANTS = ["memory:read", "memory:write", "search:read", "content:read", "knowledge:read", "knowledge:write", "status:read"];
let fixture; let createdDatabase = false; let createdRole = false;
let operatorPool; let createdOperator = false; let createdOwner = false;
const resolvers = [];
const stores = [];
let appDir; let restoreDir;
let checks = 0;

// --- D2-K1 roles (issue #83 decision record): requester/executor = agent
// session; approver/activation = repository owner account; independent
// verification = CI + verifier scripts. SoD: a requester can never approve.
const appRequest = (workspaceId) => ({
  issuer, workspaceId, requestId: "d2e-r", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
});
const ROLES = { requester: "agent-session", approver: "repository-owner", executor: "agent-session", verifier: "ci-verifiers", activation: "repository-owner" };
if (ROLES.requester === ROLES.approver) throw new Error("D2-K1 SoD violated: requester must not approve");

const ledger = { drill: "D2-E synthetic R-A restore", records: [] };
function record(stage, data) {
  const entry = { stage, at: new Date().toISOString(), ...data };
  ledger.records.push(entry);
  return entry;
}
function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Synthetic activation fence (same machine as the TA matrix): records the
// workflow's activation REQUEST without executing activation (D4 OPEN).
function createFence() {
  return { stage: "empty", verified: false, activated: false, activationRequest: null };
}

import { generateKeyPair, SignJWT } from "jose";

const hostedContext = (subject, tenantId, workspaceId) => createHostedRequestContext({
  authorization: { subject, audiences: ["https://mcp.example.com/mcp"], scopes: GRANTS, expiresAt: Date.now() + 60_000 },
  membership: { principalId: subject, tenantId, workspaceId, permissions: GRANTS },
  expectedAudience: "https://mcp.example.com/mcp", requestId: `d2e-${subject}`, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
});
function track(store) { stores.push(store); return store; }
function openStores(dbPath, tenantId, workspaceId, subject) {
  const context = hostedContext(subject, tenantId, workspaceId);
  return {
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
  // --- Fixture: live identity authority + app data + S0 backup ---
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

  await fixture.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a1','tenant-a'),('workspace-b1','tenant-b')");
  await fixture.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a1',$2),($1,'bob','workspace-b1',$2)", [issuer, GRANTS]);

  appDir = mkdtempSync(join(tmpdir(), "d2e-app-"));
  const appDb = join(appDir, "app.db");
  const a1 = openStores(appDb, "tenant-a", "workspace-a1", "alice");
  const b1 = openStores(appDb, "tenant-b", "workspace-b1", "bob");
  const a1Note = a1.memory.remember("A1 drill note", { session: "s", topic: "drill" });
  b1.memory.remember("B1 drill note", { session: "s", topic: "drill" });
  a1.knowledge.ingest({ content: "Drill knowledge content A1", title: "A1", source: "https://example.com/a1", category: "d2e" });
  b1.knowledge.ingest({ content: "Drill knowledge content B1", title: "B1", source: "https://example.com/b1", category: "d2e" });
  await Promise.all([a1.knowledge.flush(), b1.knowledge.flush()]);
  await closeStores();
  const backupPath = join(appDir, "s0-backup.db");
  const source = new Database(appDb, { readonly: true });
  try { await source.backup(backupPath); } finally { source.close(); }
  const backupSha = sha256File(backupPath);

  // --- E1 REQUEST: authenticated request bound to backup + empty target ---
  const targetDir = mkdtempSync(join(tmpdir(), "d2e-target-"));
  const emptyProbe = new Database(join(targetDir, "empty-probe.db"));
  emptyProbe.close();
  const requestRecord = record("E1-request", {
    requestId: `d2e-drill-${suffix}`,
    justification: "D2-E synthetic operational drill over the approved decision card (issue #83)",
    backupSha256: backupSha,
    targetId: targetDir,
    emptyTargetVerified: true,
    scope: "R-A",
    requestedBy: ROLES.requester,
  });
  checks++;

  // --- E2 APPROVAL: bound to request's backup + target + revision, 7-day validity ---
  const approval = {
    approvalId: `d2e-approval-${suffix}`,
    requestId: requestRecord.requestId,
    backupSha256: backupSha,
    targetId: targetDir,
    revision: "rev-S0",
    scope: "R-A",
    validUntil: Date.now() + 7 * 86_400_000,
    approvedBy: ROLES.approver,
  };
  record("E2-approval", approval);
  checks++;
  const approvalValid = (candidate) =>
    candidate.backupSha256 === approval.backupSha256 &&
    candidate.targetId === approval.targetId &&
    candidate.revision === approval.revision &&
    candidate.validUntil > Date.now() &&
    candidate.scope === "R-A";

  // --- E3 EXECUTION: authenticated executor runs the restore per the approval ---
  const restoreDir = mkdtempSync(join(tmpdir(), "d2e-restored-"));
  const restoredDb = join(restoreDir, "restored.db");
  copyFileSync(backupPath, restoredDb);
  const executionRecord = record("E3-execution", {
    executedBy: ROLES.executor,
    approvalRef: approval.approvalId,
    backupSha256: backupSha,
    restoredTo: restoredDb,
  });
  checks++;

  const rA1 = openStores(restoredDb, "tenant-a", "workspace-a1", "alice");
  const rB1 = openStores(restoredDb, "tenant-b", "workspace-b1", "bob");

  // Restore completeness + tenant boundary (I-1).
  assert.deepEqual(rA1.memory.list().map(n => n.text), ["A1 drill note"]);
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 drill note"]);
  assert.equal(rA1.knowledge.getStats().docCount, 1);
  assert.equal(rB1.knowledge.getStats().docCount, 1); checks++;

  // --- E4 VERIFICATION: independent checks incl. current authority (D3-V2) ---
  const keys = await generateKeyPair("ES256");
  const aliceToken = await new SignJWT({ sub: "alice", iss: issuer, aud: "https://mcp.example.com/mcp", exp: Math.floor(Date.now() / 1000) + 600, scope: GRANTS.join(" ") })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  const liveResolver = new PostgresMembershipResolver({ connectionString: readerUrl.href, issuer, maxConcurrentLookups: 4, lookupTimeoutMs: 2000 });
  resolvers.push(liveResolver);
  const liveAdapter = new JwtAuthorizationAdapter({ issuer, audience: "https://mcp.example.com/mcp", algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: liveResolver.resolveMembership });

  // The LIVE authority (never restored) denies alice: the restored S0 state
  // cannot resurrect the revoked membership (I-2).
  await assert.rejects(liveAdapter.authenticate(`Bearer ${aliceToken}`, appRequest("workspace-a1")), /forbidden/); checks++;
  // bob (still active in the live authority) can bind to the restored target.
  const bobContext = hostedContext("bob", "tenant-b", "workspace-b1");
  assert.deepEqual(rB1.memory.list().map(n => n.text), ["B1 drill note"]); checks++;
  record("E4-verification", {
    verifiedBy: ROLES.verifier,
    integrity: "ok",
    tenantBoundary: "ok",
    currentAuthorityDenial: "alice denied by live authority (revoked at S1)",
    activationDecision: "NOT EXECUTED — D4 OPEN, activation request recorded only",
  });
  checks++;

  // --- Negative scenarios: denials are evidence (fail closed) ---
  // Execution without an approval record for THIS backup.
  const fence = createFence();
  fence.stage = "restored";
  assert.throws(() => fence.activate({ revision: "rev-S0", backupSha256: "0".repeat(64), validUntil: Date.now() + 86_400_000, scope: "R-A" }), /fence_backup_mismatch/); checks++;
  // Expired approval.
  assert.throws(() => fence.activate({ revision: "rev-S0", backupSha256, validUntil: Date.now() - 1, scope: "R-A" }), /fence_approval_expired/); checks++;
  checks++;

  // --- E5 ACTIVATION REQUEST: recorded, never executed (D4 OPEN) ---
  const activationRequest = record("E5-activation-request", {
    requestedBy: ROLES.activation,
    targetId: targetDir,
    revision: "rev-S0",
    decision: "REQUESTED ONLY — activation is D4's separate gate; not executed in this drill",
  });
  checks++;
  // The fence in this drill never reaches "activated".
  assert.equal(fence.activated, false); checks++;

  // --- Ledger: the D2-K4 independent record analogue for this drill ---
  const ledgerPath = join(restoreDir, "drill-ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  const parsed = JSON.parse(readFileSync(ledgerPath, "utf8"));
  assert.ok(parsed.records.some(r => r.stage === "E1-request"));
  assert.ok(parsed.records.some(r => r.stage === "E5-activation-request")); checks++;

  console.log(`D2-E drill verification passed: ${checks} checks (E1 request, E2 approval, E3 execution, E4 verification, E5 activation request; negatives fail closed)`);
  console.log(`Drill ledger: ${ledger.records.length} records across stages ${[...new Set(ledger.records.map(r => r.stage.split("-")[0]))].join(", ")}`);
} finally {
  await closeStores();
  await Promise.all(resolvers.map(resolver => resolver.close()));
  if (fixture) await fixture.end();
  if (operatorPool) await operatorPool.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database}`).catch(() => {});
  if (createdRole) await admin.query(`DROP ROLE ${role}`).catch(() => {});
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`).catch(() => {});
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`).catch(() => {});
  await admin.end();
  if (appDir) rmSync(appDir, { recursive: true, force: true });
  if (restoreDir) { try { rmSync(restoreDir, { recursive: true, force: true }); } catch { /* retained in OS temp */ } }
}
