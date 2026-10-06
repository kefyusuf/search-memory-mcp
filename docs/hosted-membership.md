# Hosted membership read model

This PostgreSQL adapter is the first hosted identity-storage prototype. It does not migrate notes, knowledge, graphs or caches, enable a listener, or qualify PostgreSQL as the complete production datastore.

## Trust and schema

An operator-controlled migration runner applies `migrations/0001-hosted-membership.sql` with a separate owner credential. Runtime lookup does not migrate, provision users, assign tenants or grant permissions. The schema uses globally unique opaque workspace IDs, a server-owned workspace-to-tenant mapping, and memberships keyed by exact issuer, principal subject and workspace ID. Workspace display names are not these identifiers. Disabled workspaces and revoked memberships cannot authorize a new lookup.

The JWT adapter adds its verified configured issuer to the immutable membership input. The resolver requires that issuer to equal its own configuration before querying. A mismatched adapter cannot silently resolve the same subject in another issuer's namespace. Caller request fields, token tenant/workspace claims and SQL fragments cannot select tenant ownership or override that issuer. The fixed-schema query parameterizes issuer, subject and requested workspace. Grants must be among the eight known permissions; the resulting permissions still intersect verified token scopes.

The runtime database role needs only:

```sql
GRANT USAGE ON SCHEMA mcp_identity TO membership_reader;
GRANT SELECT ON mcp_identity.workspaces, mcp_identity.workspace_memberships TO membership_reader;
```

Provision that role and its credentials through deployment-owned secret management. Do not use the migration owner or grant runtime write/DDL permissions. Membership administration, enrollment, audit and tenant assignment require a separate trusted workflow; no public grant-management endpoint exists here.

## Lookup budgets

Instantiate one shared `PostgresMembershipResolver` for the intended process budget, and pass its bound `resolveMembership` callback to the JWT adapter. Configure `maxConcurrentLookups` from 1 through 256 and `lookupTimeoutMs` from 1 through 30000. The pool has the same connection cap and a finite connection/statement timeout. A read-only session default is defense in depth alongside the read-only role. Incoming work beyond capacity rejects before pool acquisition and never joins an unbounded resolver queue.

The effective client timer is the smaller of the request deadline and configured lookup budget. Cancellation/timeout destroys an acquired client; a pending acquisition retains capacity until its bounded driver operation settles, then destroys any late client. Capacity releases after driver settlement, including failure. Requests are checked before acquisition and after connection/query waits. Identity strings and workspace selectors are bounded to 256 characters, issuer to 2048, and grants to eight elements. Returned membership/grants are immutable and uncached. Backend failures produce controlled errors; the JWT adapter maps availability/capacity failures to its existing unavailable path rather than local fallback.

Connection URLs must explicitly name a user, host and database; query/fragment policy overrides are rejected. Non-loopback databases require explicit verified TLS (`ssl: true` or a verified TLS configuration). Disabling certificate verification is rejected. The local fixture uses loopback plaintext only; production certificates, TLS reachability and connection policy are not demonstrated by that fixture.

Call `close()` during shutdown. It is idempotent, rejects new work and drains the owned pool. Idle pool errors are contained without logging credentials; production availability metrics/alerts still require bootstrap integration. Separate resolver instances or replicas multiply these process-local budgets.

## Verification

Build with Node 24, then run:

```powershell
$env:MEMBERSHIP_TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:55434/websearch_membership_test'
npm run test:postgres
```

This example contains fixture-only credentials. Use an isolated PostgreSQL 17 fixture whose base database is exactly `websearch_membership_test`. The verifier refuses non-loopback/non-fixture URLs, creates a unique child database and reader role, and removes only its own child database/role in `finally`. It tests actual SQL and driver behavior: issuer/principal/workspace isolation, SQL injection resistance, persistence across resolver reconnection, read-only grants, schema constraints, grant revocation/disablement, controlled backend failure, real JWT scope intersection, issuer mismatch, capacity rejection, cancellation and timeouts/deadlines. Lock-wait tests observe `pg_stat_activity` before asserting and wait for reader backend termination afterward. CI runs this suite against a PostgreSQL service; unit tests alone are not driver/locking evidence.

Pool acquisition/release behavior follows the [node-postgres pool contract](https://node-postgres.com/apis/pool); server statement limits follow [PostgreSQL client settings](https://www.postgresql.org/docs/17/runtime-config-client.html).

## Remaining release gates

JWT-issued contexts now carry a private asynchronous membership checkpoint. Tool dispatch revalidates after admission, before handler execution, and after handler settlement/admission release before returning a result. Long-running hosted handlers must call `await assertRequestAuthorization(context)` immediately before protected effects after asynchronous waits. Each checkpoint uses the same verified issuer, subject, workspace, deadline and cancellation signal and the resolver's existing pool/capacity/timeout limits. Concurrent checkpoints on one context share a pending lookup; later checkpoints perform a fresh lookup. No database lookup occurs synchronously on every context check.

Missing membership, changed ownership/subject/workspace, or loss of any originally granted context permission permanently denies that context. Backend errors permanently fail that context closed with a controlled availability error. Restoring a membership does not revive a denied context; a new authenticated request is required. Additional grants never expand an existing context's permissions. Key retirement uses the separate live key lease. Trusted direct context factories can omit this hook for prototype/test integrations; production authorization must use the JWT adapter or supply an equivalent trusted checkpoint.

This is checkpoint-based revocation, not atomic authorization with data writes. Changes after a successful lookup can race with subsequent effects; revocation and restoration between lookups are not observed. Already-completed writes or streamed bytes are not undone. No background poll, forced worker termination or stream shutdown is added. All built-in storage tools remain local-only; hosted transaction fencing and stream lifecycle policy remain release gates.

Before production: qualify migration ownership/versioning/rollback, backup/restore and crash recovery, trusted provisioning/audit, TLS/roles/secrets, live membership revocation policy, query/load plans, shared quotas, health/metrics/shutdown and full hosted storage. This prototype's connection-reopen and lock tests are not production durability, recovery or scale proof.
