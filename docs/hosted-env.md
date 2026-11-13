# Hosted environment reference

Configuration for the hosted MCP bootstrap (`src/hosted/server.ts`, [ADR-0005](adr/0005-hosted-pilot-architecture.md)) and its optional provisioning surface ([ADR-0006](adr/0006-provisioning-and-identity.md)). The local stdio server (`src/index.ts`) does not read these variables; see [.env.example](../.env.example) for local configuration.

The bootstrap requires explicit configuration. A missing required variable, or a value that fails validation, prints the exact setup error and exits instead of guessing. Secrets never belong in the repository; provide them through deployment-owned secret management.

## MCP ingress

| Variable                         | Required | Default   | Validation / notes                                                                                                       |
| -------------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `HOSTED_HTTP_PORT`               | no       | `8080`    | TCP port for the MCP listener.                                                                                           |
| `HOSTED_BIND`                    | no       | `0.0.0.0` | Bind address for the public MCP listener.                                                                                |
| `HOSTED_ISSUER`                  | yes      | —         | Must start with `https://`. Verified JWT issuer.                                                                         |
| `HOSTED_AUDIENCE`                | yes      | —         | Must start with `https://`. Verified JWT audience.                                                                       |
| `HOSTED_ALLOWED_ORIGINS`         | yes      | —         | Comma-separated origin allowlist; empty entries are dropped.                                                             |
| `HOSTED_JWT_ALGORITHM`           | no       | `ES256`   | One of `ES256`, `RS256`, `EdDSA`; anything else exits.                                                                   |
| `HOSTED_PUBLIC_KEY_FILE`         | yes      | —         | Path to an SPKI public key PEM. Must be a valid key for the chosen algorithm.                                            |
| `HOSTED_MEMBERSHIP_DATABASE_URL` | yes      | —         | Must start with `postgres://` or `postgresql://`. Read-only runtime role; the live membership authority, never restored. |
| `HOSTED_APP_DB`                  | yes      | —         | Path to the shared SQLite application database (tenant-scoped stores).                                                   |
| `HOSTED_REQUEST_TIMEOUT_MS`      | no       | `30000`   | Per-request auth/handler timeout.                                                                                        |

## Admission and rate limits

Concurrency caps are always required and explicit ([ADR-0002](adr/0002-public-service-boundaries.md)). The sliding-window rate policy is **opt-in**: it activates only when `HOSTED_RATE_WINDOW_MS` is set.

| Variable                 | Required           | Default          | Validation / notes                                                                                                        |
| ------------------------ | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `HOSTED_ADMIT_GLOBAL`    | yes                | —                | Positive integer (>= 1). Process-wide concurrent invocations.                                                             |
| `HOSTED_ADMIT_TENANT`    | yes                | —                | Positive integer (>= 1). Per-tenant concurrency cap.                                                                      |
| `HOSTED_ADMIT_WORKSPACE` | yes                | —                | Positive integer (>= 1). Per-workspace concurrency cap.                                                                   |
| `HOSTED_ADMIT_PRINCIPAL` | yes                | —                | Positive integer (>= 1). Per-principal concurrency cap.                                                                   |
| `HOSTED_RATE_WINDOW_MS`  | no                 | unset (disabled) | Positive integer. When unset/empty, admission is concurrency-only. When set, all four rate budgets below become required. |
| `HOSTED_RATE_GLOBAL`     | only if window set | —                | Positive integer. Global budget per window.                                                                               |
| `HOSTED_RATE_TENANT`     | only if window set | —                | Positive integer. Per-tenant budget per window.                                                                           |
| `HOSTED_RATE_WORKSPACE`  | only if window set | —                | Positive integer. Per-workspace budget per window.                                                                        |
| `HOSTED_RATE_PRINCIPAL`  | only if window set | —                | Positive integer. Per-principal budget per window.                                                                        |

Rate resolution lives in the pure `src/hosted/config.ts` module (unit-tested without a server or database). An invalid configured value is a startup error. The startup log prints the active rate policy, or `disabled (concurrency-only; set HOSTED_RATE_WINDOW_MS to enable)`.

## Tenant caches and membership lookup

| Variable                    | Required | Default | Validation / notes                                                                                            |
| --------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `HOSTED_MAX_TENANT_STORES`  | no       | `64`    | LRU cap for per-scope `SessionMemory` stores; evicted stores are closed.                                      |
| `HOSTED_MAX_SCOPE_CACHES`   | no       | `64`    | LRU cap for per-scope semantic caches, fetchers, search tools and knowledge bundles.                          |
| `HOSTED_LOOKUP_CONCURRENCY` | no       | `8`     | Membership resolver concurrent lookups. See [hosted-membership.md](hosted-membership.md) for resolver bounds. |
| `HOSTED_LOOKUP_TIMEOUT_MS`  | no       | `2000`  | Membership resolver lookup timeout. See [hosted-membership.md](hosted-membership.md).                         |

## Shared search infrastructure

Process-wide by design ([ADR-0005](adr/0005-hosted-pilot-architecture.md) resource split); these reuse the local search variables.

| Variable                     | Required | Default                                                                                                | Validation / notes                                                                          |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `SEARCH_PROVIDERS`           | no       | `brave,duckduckgo,marginalia,bing` if `BRAVE_SEARCH_API_KEY` is set, else `duckduckgo,marginalia,bing` | Comma-separated provider order.                                                             |
| `BRAVE_SEARCH_API_KEY`       | no       | —                                                                                                      | Enables the Brave provider and changes the default provider order.                          |
| `HOSTED_FETCH_WAIT_UNTIL`    | no       | `networkidle`                                                                                          | `domcontentloaded` selects that wait strategy; any other value falls back to `networkidle`. |
| `HOSTED_READER_FALLBACK_URL` | no       | —                                                                                                      | Optional reader-mode fallback endpoint for content fetching.                                |

## Admin / provisioning surface

Disabled entirely unless `HOSTED_ADMIN_PORT` is set. The admin API never accepts user JWTs and connects with the operator DSN (DML role), physically separate from the MCP ingress port and identity ([ADR-0006](adr/0006-provisioning-and-identity.md)).

| Variable                        | Required               | Default          | Validation / notes                                                                                                                                  |
| ------------------------------- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOSTED_ADMIN_PORT`             | no                     | unset (disabled) | When unset, the provisioning surface is never opened.                                                                                               |
| `HOSTED_ADMIN_BIND`             | no                     | `127.0.0.1`      | Bind address for the admin surface, **independent of `HOSTED_BIND`**. Defaults to loopback so the operator-token surface is not exposed by default. |
| `HOSTED_ADMIN_TOKEN`            | yes (if admin enabled) | —                | Operator bearer token; at least 32 characters after trimming. A shorter token is a startup error.                                                   |
| `HOSTED_ADMIN_DATABASE_URL`     | yes (if admin enabled) | —                | Operator DSN with DML rights on the identity tables; distinct from the read-only runtime role.                                                      |
| `HOSTED_TOKEN_PRIVATE_KEY_FILE` | yes (if admin enabled) | —                | Path to a PKCS#8 private key PEM used to mint pilot tokens. Must match `HOSTED_PUBLIC_KEY_FILE`; a mismatched pair is a startup error.              |

Admin rate limiting remains deferred; the operator token secret and the loopback default are the primary controls.
