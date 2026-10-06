import assert from "node:assert/strict";

/** Real database checks, invoked only inside the disposable membership fixture. */
export async function verifyMembershipAudit({ fixture, operator, reader, operatorRole, ownerRole, issuer }) {
  let checks = 0;
  assert.equal((await fixture.query("SELECT to_regclass('mcp_identity.membership_audit')::text AS relation")).rows[0].relation,
    "mcp_identity.membership_audit", "Membership writes must have a transactional audit table"); checks++;
  const count = async () => Number((await fixture.query("SELECT count(*) AS count FROM mcp_identity.membership_audit")).rows[0].count);
  const events = async () => (await fixture.query("SELECT * FROM mcp_identity.membership_audit WHERE actor_role=$1 ORDER BY event_id", [operatorRole])).rows;
  assert.equal(await count(), 4, "Initial fixture provisioning must also be audited"); checks++;
  assert.equal((await fixture.query("SELECT tenant_id FROM mcp_identity.workspaces WHERE workspace_id='pre-audit-workspace'")).rows[0].tenant_id, "pre-audit-tenant");
  assert.equal((await fixture.query("SELECT * FROM mcp_identity.membership_audit WHERE after_state->>'workspace_id'='pre-audit-workspace'")).rowCount, 0); checks++;

  await operator.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('workspace-audit','tenant-audit')");
  let history = await events();
  assert.equal(history.length, 1); assert.equal(history[0].entity_type, "workspace"); assert.equal(history[0].action, "INSERT");
  assert.equal(history[0].before_state, null); assert.deepEqual(history[0].after_state, { workspace_id: "workspace-audit", tenant_id: "tenant-audit", disabled_at: null });
  assert.ok(history[0].occurred_at instanceof Date); assert.ok(history[0].transaction_id); checks++;

  await operator.query("INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,'audit-user','workspace-audit',ARRAY['memory:read','memory:write'])", [issuer]);
  await operator.query("UPDATE mcp_identity.workspace_memberships SET permissions=ARRAY['memory:read'], revoked_at=now() WHERE principal_id='audit-user'");
  history = await events();
  assert.equal(history[1].entity_type, "membership"); assert.equal(history[1].action, "INSERT"); assert.equal(history[1].after_state.issuer, issuer);
  assert.equal(history[2].action, "UPDATE"); assert.deepEqual(history[2].before_state.permissions, ["memory:read", "memory:write"]);
  assert.deepEqual(history[2].after_state.permissions, ["memory:read"]); assert.ok(history[2].after_state.revoked_at); checks++;

  await operator.query("UPDATE mcp_identity.workspaces SET disabled_at=now(),tenant_id='tenant-changed' WHERE workspace_id='workspace-audit'");
  history = await events(); assert.equal(history[3].before_state.tenant_id, "tenant-audit");
  assert.equal(history[3].after_state.tenant_id, "tenant-changed"); assert.ok(history[3].after_state.disabled_at); checks++;

  const beforeRollback = await count();
  await operator.query("BEGIN");
  try {
    await operator.query("UPDATE mcp_identity.workspaces SET tenant_id='rolled-back' WHERE workspace_id='workspace-audit'");
    await operator.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('rollback-workspace','tenant-audit')");
  } finally { await operator.query("ROLLBACK"); }
  assert.equal(await count(), beforeRollback);
  assert.equal((await fixture.query("SELECT tenant_id FROM mcp_identity.workspaces WHERE workspace_id='workspace-audit'")).rows[0].tenant_id, "tenant-changed");
  assert.equal((await fixture.query("SELECT * FROM mcp_identity.workspaces WHERE workspace_id='rollback-workspace'")).rowCount, 0); checks++;

  await fixture.query("ALTER TABLE mcp_identity.membership_audit ADD CONSTRAINT fixture_reject_audit_update CHECK (action <> 'UPDATE') NOT VALID");
  try {
    await assert.rejects(operator.query("UPDATE mcp_identity.workspace_memberships SET permissions=ARRAY['memory:write'] WHERE principal_id='audit-user'"), error => error.code === "23514");
    assert.deepEqual((await fixture.query("SELECT permissions FROM mcp_identity.workspace_memberships WHERE principal_id='audit-user'")).rows[0].permissions, ["memory:read"]);
    assert.equal(await count(), beforeRollback);
  } finally { await fixture.query("ALTER TABLE mcp_identity.membership_audit DROP CONSTRAINT fixture_reject_audit_update"); } checks++;

  await assert.rejects(operator.query("UPDATE mcp_identity.workspace_memberships SET permissions=ARRAY['admin'] WHERE principal_id='audit-user'"), error => error.code === "23514");
  assert.equal(await count(), beforeRollback); checks++;

  // A caller-controlled session label must not replace the authenticated login identity.
  await operator.query("SET application_name='forged-actor'");
  await operator.query("DELETE FROM mcp_identity.workspace_memberships WHERE principal_id='audit-user'");
  await operator.query("DELETE FROM mcp_identity.workspaces WHERE workspace_id='workspace-audit'");
  history = await events(); assert.equal(history.length, 6);
  for (const event of history.slice(-2)) { assert.equal(event.action, "DELETE"); assert.equal(event.after_state, null); assert.ok(event.before_state); assert.equal(event.actor_role, operatorRole); } checks++;

  for (const query of [
    "SELECT * FROM mcp_identity.membership_audit",
    "INSERT INTO mcp_identity.membership_audit(entity_type,action,actor_role) VALUES ('workspace','INSERT','forged')",
    "UPDATE mcp_identity.membership_audit SET actor_role='forged'",
    "DELETE FROM mcp_identity.membership_audit",
    "TRUNCATE mcp_identity.membership_audit",
    "TRUNCATE mcp_identity.workspace_memberships",
    "ALTER TABLE mcp_identity.workspaces DISABLE TRIGGER ALL",
    "SET session_replication_role='replica'",
    "SET SESSION AUTHORIZATION postgres",
    `SET ROLE ${ownerRole}`,
    "SELECT mcp_identity.record_membership_audit()",
  ]) await assert.rejects(operator.query(query), error => error.code === "42501"); checks++;
  for (const query of ["SELECT * FROM mcp_identity.membership_audit", "DELETE FROM mcp_identity.workspaces", "SELECT mcp_identity.record_membership_audit()"])
    await assert.rejects(reader.query(query), error => error.code === "42501"); checks++;
  await operator.query("CREATE TEMP TABLE membership_audit(actor_role text)");
  await operator.query("SET search_path=pg_temp,public");
  await operator.query("SET websearch.actor='forged-actor'");
  const beforeShadow = await count();
  await operator.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('shadow-workspace','tenant-audit')");
  assert.equal(await count(), beforeShadow + 1);
  assert.equal((await operator.query("SELECT * FROM pg_temp.membership_audit")).rowCount, 0);
  assert.equal((await events()).at(-1).actor_role, operatorRole);
  await operator.query("DELETE FROM mcp_identity.workspaces WHERE workspace_id='shadow-workspace'");
  await operator.query("DROP TABLE pg_temp.membership_audit"); checks++;
  await operator.query("BEGIN");
  try {
    await operator.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ('grouped-workspace','tenant-audit')");
    await operator.query("UPDATE mcp_identity.workspaces SET disabled_at=now() WHERE workspace_id='grouped-workspace'");
    await operator.query("COMMIT");
  } catch (error) { await operator.query("ROLLBACK"); throw error; }
  const grouped = (await fixture.query("SELECT transaction_id, action FROM mcp_identity.membership_audit WHERE after_state->>'workspace_id'='grouped-workspace' ORDER BY event_id")).rows;
  assert.deepEqual(grouped.map(event => event.action), ["INSERT", "UPDATE"]);
  assert.equal(grouped[0].transaction_id, grouped[1].transaction_id);
  await operator.query("DELETE FROM mcp_identity.workspaces WHERE workspace_id='grouped-workspace'"); checks++;
  return checks;
}
