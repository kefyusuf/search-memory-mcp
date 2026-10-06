# Development status

Updated: 2026-10-04.

## Current implementation

- TypeScript MCP server over stdio with 11 tools; orchestration lives in `src/index.ts`.
- Five provider adapters with health backoff, fallback/aggregate execution, and opt-in intent-aware routing.
- Plan-aware semantic caching for all strategies, HTTP-first Markdown fetching with Playwright fallback, domain/date filters, optional reranking, and extractive deep answers.
- Local FTS5/vector knowledge index, session memory, entity graph, JSON output, search traces, and offline retrieval evaluation.
- Query rewriting for local-index search. Web multi-query retrieval is available through `expand_query=true`, with at most two additional variants and RRF fusion that retains actual provider provenance.
- Cache filters now isolate exact domain/date constraints and reapply them before output/deep fetching; namespace filtering precedes vector-store limits, and expired candidates do not hide later valid hits.
- Tool routing now passes through a transport-independent dispatcher with per-tool permissions and execution modes. The stdio adapter issues an immutable local request context, using the SDK request id and cancellation signal.
- Hosted context creation consumes trusted auth-adapter and membership-resolver outputs, intersects scopes with membership grants, and rejects missing/expired/wrong-audience authorization, forged contexts, expired deadlines and pre-cancelled requests. It does not verify token signatures or implement HTTP/OAuth.
- Session memory supports a trusted request context and filters every data operation by execution mode, tenant and workspace. Permission checks apply at the storage boundary; capacity eviction is workspace-local. The additive SQLite migration keeps legacy rows in the local scope. Context omission retains the legacy local adapter only.
- Entity graph storage now binds composite document/entity/link keys and every relational join to execution mode, tenant and workspace. Re-indexing a matching document id in another workspace cannot replace local links. Queries and stats enforce read permissions; indexing enforces write permissions. Transactional schema rebuilding keeps legacy graph rows and links in the local scope.
- Knowledge storage accepts trusted context and enforces read/write permissions and document ownership for ids, lists, FTS/vector retrieval and stats. Ownership joins precede ordering/limits. New documents use opaque UUIDs; legacy documents/FTS/vectors retain their ids and become local-only through an additive document migration. Deletion removes vectors before chunks; queued embedding writes recheck context and surviving ownership. Query embedding waits recheck context before returning results.
- Private content and semantic caches now enforce trusted mode/tenant/workspace ownership. Content keys are composite; hosted vector keys are scoped hashes with caller ids retained separately. Both native and JS fallback paths filter ownership and execution namespace before limiting candidates. Migration preserves legacy caches locally; scoped maintenance clears both vector backends and content transactionally. Cache fills use search:read/content:read as internal effects of read tools, statistics use status:read, and clear/TTL cleanup require cache:manage. SemanticCache preserves authorization/cancellation errors across inference waits and fallback paths.
- All 11 built-in handlers remain local-only: hosted dispatch is rejected before handler execution. Hosted adapter wiring, storage and quotas, HTTP authentication, browser/session isolation, and cancellation during provider/fetch/model work remain pending. The embedding queue is serialized and bounded per index; cross-index/model concurrency and inference duration are not bounded or forcibly cancellable. No shared public cache policy is enabled.
- Hosted dispatcher execution now requires an explicit shared admission policy. The process-local reference policy enforces positive global/tenant/workspace/principal concurrency limits atomically using trusted context, counts each invocation independently of request IDs, and releases grants once after handlers settle. The dispatcher rechecks authorization, deadline and cancellation after admission, handler completion and asynchronous grant release. Cancellation retains capacity until the actual handler settles. This does not forcibly stop resources or implement distributed/ingress/spend quotas.

The process-local admission policy also accepts explicit optional sliding-window rate limits for global, tenant, workspace and principal accepted invocations. It snapshots positive safe-integer limits/window duration, uses monotonic time, expires individual timestamps and rejects all dimensions before charging usage. Release never refunds rate usage, including failed handlers. Rejections consume neither rate nor concurrency capacity. Expired history is swept across inactive identities on admission checks, bounding retained history by global accepted usage in the configured window. Rate limits must be configured explicitly; omission retains the earlier concurrency-only policy. This is not distributed quota enforcement or unauthenticated HTTP/IP protection.

## Development environment

KnowledgeIndex limits active plus queued embedding chunks per instance with maxPendingEmbeddingChunks (positive safe integer, default 256). Overload throws embedding_queue_full before document/chunk/FTS writes. Successful or failed embedding settlement releases the reservation; deletion retains it until the job settles. SQL rollback consumes no reservation. FTS-only indexes do not queue embedding work or apply this inference budget. Documents exceeding the budget require an explicit capacity choice or FTS-only ingestion. This bounds per-index backlog, not incoming content allocation, stored data, cross-index/model work, CPU duration or durable background jobs.

Use Node.js 24 (`.nvmrc`), also used by CI. Native modules must be installed for the same Node runtime that runs the server. A `better-sqlite3` binary from another runtime can break both server startup and storage tests.

HTTP-fetch and SSRF unit tests mock DNS answers as well as HTTP responses. They exercise real URL validation and redirect blocking without requiring external DNS. These tests do not measure live provider availability or scraping quality.

The retrieval evaluation disables embeddings during both ingestion and search through `KnowledgeIndex`'s `enableEmbeddings: false` option. It measures a deterministic FTS baseline without model initialization or downloads.

## Next development work

Continuation checkpoint: `codex/bounded-knowledge-embedding-queue` builds on `codex/hosted-invocation-rate-limits` (PR #17, parent commit `54c64ca`; its GitHub CI passed). These branches are review increments, not merged releases. This increment adds 15 real SQLite embedding-queue tests with deterministic model substitutes; all 395 tests, TypeScript build and compiled stdio MCP smoke pass locally. Verify current PR heads and CI before resuming. The earlier two-query retrieval fixture is a deterministic baseline, not sector-scale quality evidence.

The user selected an internet-facing multi-user product as the first live target. The [production roadmap](production-roadmap.md), informed by [the sector comparison](research/2026-10-02-production-benchmark.md), therefore puts HTTP MCP/auth, tenant isolation, quotas, cache/filter correctness, durable storage, fetch egress/resource limits, and staging/release operations before a hosted pilot. Local stdio remains a development/distribution option.

- Measure live provider success, blocking, and latency before tuning routing profiles or introducing adaptive weighting.
- Evaluate query expansion against a search-quality fixture set; current retrieval evaluation measures the local knowledge index.
- Extract tool handlers from `src/index.ts` as orchestration grows, preserving MCP contracts and existing tests.

The August routing plan/spec and ADR are historical records. Their unchecked steps and original cache restrictions should not be interpreted as outstanding implementation work.
