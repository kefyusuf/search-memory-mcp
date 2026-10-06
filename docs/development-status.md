# Development status

Updated: 2026-10-02.

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
- All 11 built-in handlers remain local-only: hosted dispatch is rejected before handler execution. Knowledge/graph/cache isolation, hosted storage and quotas, HTTP authentication, and cancellation during provider/fetch/model work remain pending.

## Development environment

Use Node.js 24 (`.nvmrc`), also used by CI. Native modules must be installed for the same Node runtime that runs the server. A `better-sqlite3` binary from another runtime can break both server startup and storage tests.

HTTP-fetch and SSRF unit tests mock DNS answers as well as HTTP responses. They exercise real URL validation and redirect blocking without requiring external DNS. These tests do not measure live provider availability or scraping quality.

The retrieval evaluation disables embeddings during both ingestion and search through `KnowledgeIndex`'s `enableEmbeddings: false` option. It measures a deterministic FTS baseline without model initialization or downloads.

## Next development work

The user selected an internet-facing multi-user product as the first live target. The [production roadmap](production-roadmap.md), informed by [the sector comparison](research/2026-10-02-production-benchmark.md), therefore puts HTTP MCP/auth, tenant isolation, quotas, cache/filter correctness, durable storage, fetch egress/resource limits, and staging/release operations before a hosted pilot. Local stdio remains a development/distribution option.

- Measure live provider success, blocking, and latency before tuning routing profiles or introducing adaptive weighting.
- Evaluate query expansion against a search-quality fixture set; current retrieval evaluation measures the local knowledge index.
- Extract tool handlers from `src/index.ts` as orchestration grows, preserving MCP contracts and existing tests.

The August routing plan/spec and ADR are historical records. Their unchecked steps and original cache restrictions should not be interpreted as outstanding implementation work.
