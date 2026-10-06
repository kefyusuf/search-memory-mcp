# ADR-0002: Public multi-user service boundaries

Date: 2026-10-02
Status: Accepted design; context and dispatcher foundation implemented; hosted adapters pending

## Context

The first live target is an internet-facing multi-user product. The current server is a local stdio process with a shared SQLite path, process-wide provider health/rate limits, and client-supplied note session labels. These are not authentication or tenant boundaries. The [production roadmap](../production-roadmap.md) defines release gates.

## Decision

Start with a single-region modular service and bounded resource-intensive workers. Retain stdio as a local development/distribution transport. Extract transport-independent tool handlers before adding public HTTP routing; public access is blocked until authentication, authorization, data isolation and resource budgets are verified.

The HTTP adapter must derive an authenticated principal and workspace membership from validated credentials. It passes an immutable request context to every handler: tenant/workspace id, principal id, granted permissions, request id, deadline and cancellation signal. Caller-supplied `session`, document ids, URLs and cache keys must never override that context.

Storage contracts must require tenant context for notes, documents, chunks, graph entities and private cache entries. A PostgreSQL-backed store with tenant-aware vector retrieval is the hosted implementation candidate; selection is finalized through migration, load and restore evidence. SQLite remains an optional local adapter, not a shared file for horizontal replicas.

Browser contexts, queued jobs, deduplication keys and quotas must respect the same boundary. Shared public-content caching requires an explicit separate policy; private input and local-index data cannot enter it. Provider/model/fetch work is bounded independently of the tool-call count.

Target MCP protocol/client support must be explicit. The installed v1 SDK supports the 2025-era protocol; adding the 2026-07-28 revision requires a tested migration and compatibility strategy. This ADR does not claim newer protocol support.

## Required acceptance scenarios for the next implementation slice

Implemented foundation: a server-issued immutable context and transport-independent dispatcher check permissions, provenance, auth expiry, execution mode, deadline and cancellation before executing a handler. The stdio adapter uses this path. All existing handlers explicitly allow only local mode because their stores and budgets remain process-local. The hosted context factory accepts already-verified authorization and trusted membership outputs; token signature/issuer verification and HTTP/OAuth integration are still required. Preflight cancellation is implemented; cancellation during running work and tenant-safe storage are not.

- Missing, expired, wrong-audience and insufficient-permission credentials cannot call protected tools.
- A principal without workspace membership cannot read/write that workspace.
- Tenant A cannot read, update, delete, recall, relate or retrieve tenant B's data through an id, source, session label, semantic match or queued job.
- Private cache entries cannot cross workspace boundaries even when queries have identical embeddings.
- Limits hold across concurrent requests and query variants; cancellation releases browser/job slots.
- Restore preserves tenant ownership and relationships; disabling a provider or reverting a release does not bypass permissions.

Write failing tests for these scenarios as the corresponding HTTP/storage boundaries are implemented. This document records design decisions and test requirements; the current code does not yet satisfy these public-service gates.

## Consequences

Cache correctness can ship independently as a local/server-core fix. Public deployment requires additional PRs for request context, handler extraction, storage ownership, HTTP/auth and operational controls. Neither this foundation PR nor passing local tests authorizes a public launch.
