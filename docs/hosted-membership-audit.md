# Transactional hosted membership audit

This increment records trusted PostgreSQL provisioning and membership changes. It does not expose an administration endpoint, authenticate an operator through OAuth, authorize tenant administrators, or atomically fence application data writes against membership revocation.

## Apply and own the schema

Apply `migrations/0001-hosted-membership.sql`, then `migrations/0002-hosted-membership-audit.sql` through a deployment-owned migration runner. The application does not run migrations. The second migration creates an audit table, a restricted trigger function, and row triggers on both identity tables in one transaction. Existing records survive the upgrade; their past changes are not reconstructed or backfilled. Record a separately controlled baseline if historical provenance is required.

Use a separate trusted, non-superuser owner role, preferably `NOLOGIN`, for the schema, tables and trigger function. The migration runner may assume that owner role; runtime/operator roles must not inherit it. Audit insertion executes as this owner so operators do not receive audit-table write privileges. The function uses fully qualified table/built-in references, a fixed trusted search path with `pg_temp` last, and no dynamic SQL. Public execution privileges are revoked within the migration transaction. These precautions follow PostgreSQL's [SECURITY DEFINER guidance](https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY).

## Separate database roles

| Role | Allowed access | Boundary |
| --- | --- | --- |
| Schema owner | Schema migration and owned objects | Trusted deployment only; never application credentials |
| Membership operator | SELECT/INSERT/UPDATE/DELETE on the two identity tables | Trusted cross-tenant provisioning; no ownership, DDL, TRUNCATE, TRIGGER, audit writes or function execution |
| Runtime membership reader | SELECT on the two identity tables | Existing bounded lookup resolver; no audit access or writes |
| Audit reader | SELECT on the audit table | Separate controlled operational access; no identity or audit writes |

After creating roles through secret management, assign only explicit object privileges:

```sql
GRANT USAGE ON SCHEMA mcp_identity TO membership_operator, membership_reader, membership_auditor;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO membership_operator;
GRANT SELECT ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO membership_reader;
GRANT SELECT ON mcp_identity.membership_audit TO membership_auditor;
```

These statements are examples for newly isolated roles, not repairs for pre-existing broad privileges. Verify effective ownership, inherited/default grants, function ACLs and parameter privileges before deployment. Never grant operators schema creation, owner membership, superuser status, or permission to set `session_replication_role`. Operators can otherwise bypass row triggers or alter the policy. Owners and superusers remain trusted: this audit is not tamper-proof against them or a database compromise.

## Events and atomicity

Every affected INSERT/UPDATE/DELETE row produces one event. Workspace events retain workspace/tenant identifiers and disablement; membership events retain exact issuer/principal/workspace, grants and revocation. Before/after snapshots use an explicit field list so future secret-bearing columns are not automatically copied. No bearer token, connection string, password, raw SQL or caller arguments are stored.

`actor_role` comes from `SESSION_USER`, the database login identity, independently of the trigger's owner. Client-supplied labels, custom session settings and `application_name` cannot replace it. A shared service login identifies that service, not the human behind it; human attribution and approved change reasons require a separate authenticated administration workflow. PostgreSQL documents these identities in [system information functions](https://www.postgresql.org/docs/17/functions-info.html).

Audit writes participate in the identity change's transaction. Rollback removes both; an audit insertion failure rejects the identity change. The verifier demonstrates this with a failing audit constraint. Failed/unauthorized attempts, SELECT, DDL and commands affecting no rows do not produce row events. Auditing those requires a separate operational mechanism. An UPDATE that matches an unchanged row still produces an event.

`event_id` identifies an event; identity gaps after rollback are expected. `transaction_id` groups events from one transaction. The server event timestamp and event identifiers are not a global commit-order guarantee. PostgreSQL's [trigger execution semantics](https://www.postgresql.org/docs/17/trigger-definition.html) define the transactional behavior.

## Verification and release gates

The existing `npm run test:postgres` verifier applies both migrations to its disposable child database. Its audit checks use a non-superuser `NOLOGIN` owner, a distinct DML-only login, and a separate runtime reader. They cover upgrade preservation without fabricated history, initial provisioning, before/after snapshots, grants/revocation/ownership/disablement/deletion, transaction grouping and rollback, failure atomicity, actor spoofing, temporary-table/search-path shadowing, and denied audit edits, trigger disabling, role/replication bypass and direct function calls. CI runs these checks against real PostgreSQL 17.

Production still requires an approved provisioning workflow, operator credential lifecycle, human/request attribution, conflict/expected-version policy, migration qualification, monitoring, audit access/retention/export and backup/restore testing. The table grows with operator activity; no purge/export job is enabled. Changes to the audit migration or trigger field list require review. Reversing the migration would remove an authorization-change safeguard: pause operator writes and preserve the audit history before a separately approved rollback. No production rollback has been rehearsed here.
