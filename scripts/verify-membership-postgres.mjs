import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { generateKeyPair, SignJWT } from "jose";
import { PostgresMembershipResolver } from "../build/identity/postgres-membership.js";
import { JwtAuthorizationAdapter } from "../build/runtime/jwt-authorization.js";
import { assertRequestAuthorization, assertRequestContext } from "../build/runtime/request-context.js";
import { verifyMembershipAudit } from "./verify-membership-audit.mjs";

const configured = process.env.MEMBERSHIP_TEST_DATABASE_URL;
if (!configured) throw new Error("MEMBERSHIP_TEST_DATABASE_URL must name the local disposable fixture database");
const base = new URL(configured);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.pathname !== "/websearch_membership_test" || base.search || base.hash) {
  throw new Error("Refusing a non-local or non-fixture database");
}
const suffix = randomBytes(6).toString("hex");
const database = `websearch_membership_test_${suffix}`;
const role = `ws_membership_reader_${suffix}`;
const operatorRole = `ws_membership_operator_${suffix}`;
const ownerRole = `ws_membership_owner_${suffix}`;
const password = randomBytes(20).toString("hex");
const admin = new Pool({ connectionString: configured, connectionTimeoutMillis: 2000 });
let fixture; let locked; let createdDatabase = false; let createdRole = false;
let operatorPool; let auditReader; let operator; let createdOperator = false;
let createdOwner = false;
const resolvers = [];
let checks = 0;
const issuer = "https://auth.example.com";
const audience = "https://mcp.example.com/mcp";
const request = (signal = new AbortController().signal) => ({ issuer, workspaceId: "workspace-a", requestId: "r", deadlineAt: Date.now() + 10_000, signal });
async function until(predicate, message) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error(message);
}
async function readerActive(waitEvent) {
  const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND usename=$2 AND ($3::text IS NULL OR wait_event_type=$3)", [database, role, waitEvent ?? null]);
  return result.rows[0].count;
}
try {
  await admin.query(`CREATE DATABASE ${database}`); createdDatabase = true;
  const fixtureUrl = new URL(base); fixtureUrl.pathname = `/${database}`;
  fixture = new Pool({ connectionString: fixtureUrl.href, connectionTimeoutMillis: 2000 });
  await fixture.query(await readFile(new URL("../migrations/0001-hosted-membership.sql", import.meta.url), "utf8"));
  await fixture.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('pre-audit-workspace','pre-audit-tenant')");
  await fixture.query(await readFile(new URL("../migrations/0002-hosted-membership-audit.sql", import.meta.url), "utf8"));
  await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN`); createdOwner = true;
  await fixture.query(`ALTER SCHEMA mcp_identity OWNER TO ${ownerRole}`);
  for (const table of ["workspaces", "workspace_memberships", "membership_audit"])
    await fixture.query(`ALTER TABLE mcp_identity.${table} OWNER TO ${ownerRole}`);
  await fixture.query(`ALTER FUNCTION mcp_identity.record_membership_audit() OWNER TO ${ownerRole}`);
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`); createdRole = true;
  await fixture.query(`GRANT USAGE ON SCHEMA mcp_identity TO ${role}`);
  await fixture.query(`GRANT SELECT ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO ${role}`);
  await fixture.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-a','tenant-a'),('workspace-b','tenant-b')");
  await fixture.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'alice','workspace-a',ARRAY['memory:read']),($2,'alice','workspace-b',ARRAY['memory:write'])", [issuer, "https://other.example.com"]);
  const readerUrl = new URL(fixtureUrl); readerUrl.username = role; readerUrl.password = password;
  await admin.query(`CREATE ROLE ${operatorRole} LOGIN PASSWORD '${password}'`); createdOperator = true;
  await fixture.query(`GRANT USAGE ON SCHEMA mcp_identity TO ${operatorRole}`);
  await fixture.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO ${operatorRole}`);
  const operatorUrl = new URL(fixtureUrl); operatorUrl.username = operatorRole; operatorUrl.password = password;
  operatorPool = new Pool({ connectionString: operatorUrl.href, connectionTimeoutMillis: 2000 });
  auditReader = new Pool({ connectionString: readerUrl.href, connectionTimeoutMillis: 2000 });
  operator = await operatorPool.connect();
  checks += await verifyMembershipAudit({ fixture, operator, reader: auditReader, operatorRole, ownerRole, issuer });
  operator.release(); operator = undefined;
  const options = { connectionString: readerUrl.href, issuer, maxConcurrentLookups: 1, lookupTimeoutMs: 2000 };
  const create = (extra = {}) => { const resolver = new PostgresMembershipResolver({ ...options, ...extra }); resolvers.push(resolver); return resolver; };
  const resolver = create();
  assert.deepEqual(await resolver.resolveMembership("alice", "workspace-a", request()), { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }); checks++;
  for (const [subject, workspace] of [["bob", "workspace-a"], ["alice", "workspace-b"], ["alice' OR TRUE --", "workspace-a"]]) {
    assert.equal(await resolver.resolveMembership(subject, workspace, { ...request(), workspaceId: workspace }), null);
  } checks++;
  await resolver.close(); const reopened = create(); assert.equal((await reopened.resolveMembership("alice", "workspace-a", request())).tenantId, "tenant-a"); checks++;
  const directReader = new Pool({ connectionString: readerUrl.href });
  try { await assert.rejects(directReader.query("DELETE FROM mcp_identity.workspace_memberships"), error => error.code === "42501"); } finally { await directReader.end(); } checks++;
  await assert.rejects(fixture.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'mallory','workspace-a',ARRAY['admin'])", [issuer]), error => error.code === "23514"); checks++;
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE principal_id='alice' AND workspace_id='workspace-a'");
  assert.equal(await reopened.resolveMembership("alice", "workspace-a", request()), null);
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=NULL");
  await fixture.query("UPDATE mcp_identity.workspaces SET disabled_at=now() WHERE workspace_id='workspace-a'");
  assert.equal(await reopened.resolveMembership("alice", "workspace-a", request()), null);
  await fixture.query("UPDATE mcp_identity.workspaces SET disabled_at=NULL"); checks++;
  await fixture.query(`REVOKE SELECT ON mcp_identity.workspace_memberships FROM ${role}`);
  await assert.rejects(reopened.resolveMembership("alice", "workspace-a", request()), error => error.message === "authorization_unavailable");
  await fixture.query(`GRANT SELECT ON mcp_identity.workspace_memberships TO ${role}`);
  assert.equal((await reopened.resolveMembership("alice", "workspace-a", request())).tenantId, "tenant-a"); checks++;
  const keys = await generateKeyPair("ES256");
  const adapter = new JwtAuthorizationAdapter({ issuer, audience, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: reopened.resolveMembership });
  const signed = await new SignJWT({ sub: "alice", iss: issuer, aud: audience, exp: Math.floor(Date.now()/1000)+120, scope: "memory:read memory:write", tenantId: "attacker" }).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);
  const context = await adapter.authenticate(`Bearer ${signed}`, request()); assert.equal(context.tenantId, "tenant-a"); assert.deepEqual(context.permissions, ["memory:read"]); checks++;
  await assertRequestAuthorization(context);
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id='alice' AND workspace_id='workspace-a'", [issuer]);
  await assert.rejects(assertRequestAuthorization(context), /forbidden/);
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=NULL");
  assert.throws(() => assertRequestContext(context), /forbidden/); checks++;
  const reduced = await adapter.authenticate(`Bearer ${signed}`, request());
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET permissions=ARRAY[]::text[] WHERE issuer=$1 AND workspace_id='workspace-a'", [issuer]);
  await assert.rejects(assertRequestAuthorization(reduced), /forbidden/);
  await fixture.query("UPDATE mcp_identity.workspace_memberships SET permissions=ARRAY['memory:read'] WHERE issuer=$1 AND workspace_id='workspace-a'", [issuer]); checks++;
  const wrongIssuerAdapter = new JwtAuthorizationAdapter({ issuer: "https://other.example.com", audience, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: reopened.resolveMembership });
  const foreignSigned = await new SignJWT({ sub: "alice", iss: "https://other.example.com", aud: audience, exp: Math.floor(Date.now()/1000)+120, scope: "memory:read" }).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);
  await assert.rejects(wrongIssuerAdapter.authenticate(`Bearer ${foreignSigned}`, request()), /authorization_unavailable/); checks++;
  await reopened.close();
  locked = await fixture.connect(); await locked.query("BEGIN"); await locked.query("LOCK TABLE mcp_identity.workspace_memberships IN ACCESS EXCLUSIVE MODE");
  const bounded = create(); const controller = new AbortController();
  const pending = bounded.resolveMembership("alice", "workspace-a", request(controller.signal));
  const cancelled = assert.rejects(pending, /cancelled/);
  await until(async () => await readerActive("Lock") === 1, "Reader never reached a database lock wait");
  await assert.rejects(bounded.resolveMembership("alice", "workspace-a", request()), /membership_capacity_exceeded/); checks++;
  controller.abort(); await cancelled; await until(async () => await readerActive() === 0, "Cancelled reader backend did not terminate"); checks++;
  const timed = create({ lookupTimeoutMs: 500 });
  const timeoutResult = assert.rejects(timed.resolveMembership("alice", "workspace-a", request()), /membership_timeout/);
  await until(async () => await readerActive("Lock") === 1, "Timeout reader never reached a database lock wait");
  await timeoutResult; await until(async () => await readerActive() === 0, "Timed-out reader backend did not terminate"); checks++;
  const deadlineResult = assert.rejects(bounded.resolveMembership("alice", "workspace-a", { ...request(), deadlineAt: Date.now() + 750 }), /deadline_exceeded/);
  await until(async () => await readerActive("Lock") === 1, "Deadline reader never reached a database lock wait");
  await deadlineResult; await until(async () => await readerActive() === 0, "Expired reader backend did not terminate"); checks++;
  await locked.query("ROLLBACK"); locked.release(); locked = undefined;
  assert.equal((await bounded.resolveMembership("alice", "workspace-a", request())).tenantId, "tenant-a"); checks++;
  console.log(`PostgreSQL membership verification passed: ${checks} checks against real PostgreSQL`);
} finally {
  if (locked) { await locked.query("ROLLBACK").catch(() => {}); locked.release(); }
  await Promise.all(resolvers.map(resolver => resolver.close()));
  if (operator) { await operator.query("ROLLBACK").catch(() => {}); operator.release(); }
  if (operatorPool) await operatorPool.end();
  if (auditReader) await auditReader.end();
  if (fixture) await fixture.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
  if (createdRole) await admin.query(`DROP ROLE ${role}`);
  if (createdOperator) await admin.query(`DROP ROLE ${operatorRole}`);
  if (createdOwner) await admin.query(`DROP ROLE ${ownerRole}`);
  await admin.end();
}
