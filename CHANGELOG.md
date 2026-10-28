# Changelog

## 1.2.0 (2026-10-27)

Feature release for the existing local-first stdio MCP server: intent-aware routing places the opt-in official APIs where the P1-04 three-day live matrix measured them, and the recovery/quality verification layer moved into CI. No new hosted services or public L3 launch.

### Search routing

- Routing profile `v3` ([ADR 0003](docs/adr/0003-routing-profile-v3.md)): with `TAVILY_API_KEY`/`EXA_API_KEY` configured, intent-aware `auto` search leads `news` with Tavily (news topic, provider-reported publish dates) and `research` with Exa (neural retrieval), based on the P1-04 three-day live matrix (449/450 attempts; `evals/providers/`). Keyless configurations resolve exactly as before; cache namespaces are versioned, so no v2-era entries are reused.

### Verification and scope (repo-internal; no runtime change)

- P1-03 offline quality set: 120 labeled TR/EN queries (80 local retrieval over a 20-doc fixture corpus, 16 negatives, 40 web-structural) with a deterministic FTS-baseline harness reporting recall/precision@1/3/5, MRR, nDCG@5, top1Accuracy and negative zero-hit checks as a CI step (`evals/quality/`, npm `eval:quality`; baseline nDCG@5 0.985).
- Recovery-track synthetic acceptance joined CI: TR-03/TR-04/TR-05 restore authorization, hosted HTTP ingress end-to-end with live identity, and TA-01…TA-07 activation/fencing (`npm run test:restore-authorization`, `test:hosted-ingress`, `test:activation-fencing`). The D2 operator-authority decision is recorded (issue #83) and the D4 design (TA matrix) merged; gate docs updated (PRs #99–#106). D2-E1–E5, D3-V3/V4 and real-environment D4 counterparts remain OPEN; hosted restore, deployment and public L3 stay NO-GO.

## 1.1.0 (2026-10-25)

Feature release for the existing local-first stdio MCP server: two opt-in official search APIs close the fresh-news and semantic-discovery gaps, and search results now carry provider-reported publish dates. No new hosted services or public L3 launch.

### Search quality

- Optional `TAVILY_API_KEY`: adds the opt-in `tavily` provider backed by the Tavily Search API. News-intent queries use Tavily's news topic for fresh reporting; results carry publish dates. Billed per request; never in the default provider order.
- Optional `EXA_API_KEY`: adds the opt-in `exa` provider backed by the Exa Search API with `type: auto` neural/keyword retrieval for semantic discovery. Billed per request; never in the default provider order.
- `web_search` results now carry an optional `publishedAt` (YYYY-MM-DD) when a provider reports one. Date filters prefer the provider-reported date over snippet text extraction, and the JSON output schema exposes the field.
- API providers move a trailing `site:domain` query suffix into their native domain parameter instead of degrading the query text.
- Key-backed providers named in `SEARCH_PROVIDERS` without a key are skipped with a startup note instead of failing per request.

## 1.0.4

Maintenance update for the existing local-first stdio MCP server. No new hosted services or public L3 launch.

### Fetch reliability and security

- Enforce decoded response-body byte limits for HTTP-first HTML, GitHub Raw and RSS, and optional reader fallback (PRs #62–#64).
- Treat terminal browser errors as terminal instead of incorrectly invoking reader fallback (PR #67).
- Bound Chromium main-document responses via CDP streaming and validate the read/error paths (PR #68).
- Require real Chromium outbound socket-policy acceptance in CI, including attempted subresource and page-initiated fetch requests (PR #60).

### Verification and scope

- Test whole-file physical SQLite backup and restore for three synthetic tenant/workspace scopes across four local stores; not tenant-selective restore or hosted disaster recovery (PR #79).
- Document P0-02 hosted recovery evidence without implementation. D2 operator authority, D3 current revocation authority and D4 activation remain OPEN; TR-02–TR-05 NOT RUN, R-B HOLD, public L3 NO-GO (PRs #69–#80).

## 1.0.3 (2026-10-12)

Security maintenance release for the existing `fetch_content` and browser-fetch paths.

- Optional `READER_FALLBACK_URL` (for example `https://markdown.new/`): when direct HTTP and the browser both fail to read a page, the reader service converts it to Markdown. Off by default because it sends the page URL to a third party.
- Docs: the opt-in `yahoo` provider is documented as blocked (empty HTTP 500 for every non-browser request) and is no longer in the provider benchmark by default.

- HTTP-first fetches, document/feed fast paths, retries and optional reader fallback use a request-scoped Undici dispatcher. The socket's actual DNS answers are checked before connecting; private/reserved IP literals, mixed public/private answers, and DNS failures are rejected.
- Chromium requests now use a loopback-only guarded HTTP/HTTPS CONNECT egress proxy with the same outbound socket policy. This covers tested navigation, redirects, subresources and WebSocket paths. Browser contexts cannot start without the proxy; service workers are blocked, QUIC is disabled and non-proxied WebRTC UDP is restricted.
- Browser startup/shutdown cleanup waits for in-flight contexts; public IPv6 CONNECT authority parsing is corrected.
- Verification: successful main CI and Docker checks, real Linux/Docker and Windows Chromium egress fixtures, and public HTTPS over the guarded connection path.

**Limitations:** This is defense in depth for the tested fetch paths, not process- or OS-level network isolation. The ephemeral proxy listens on localhost without authentication; untrusted local processes and untested browser protocols are not covered by a universal isolation guarantee. Additional risk tracking remains in [Issue #54](https://github.com/kefyusuf/search-memory-mcp/issues/54).

## 1.0.2 (2026-10-11)

- SSRF preflight hardening: DNS lookups with no usable results fail closed; IPv6 URL literals and IPv4-mapped IPv6 addresses are classified more accurately.
- Add regression tests for DNS failures, private IPv6 and malformed address cases.

## 1.0.1 (2026-10-09)

- Default provider order is now `duckduckgo,marginalia,bing` (`brave,duckduckgo,marginalia,bing` with a Brave key). In live benchmarks Bing returned no results for every query, while Marginalia answered 3 of 4.
- Marginalia: when it answers with its "Wait A Moment" bot-check page, the provider waits the requested time and follows the one-time continue link; a repeated check is reported as an error instead of an empty result.
- New opt-in scraping providers `yahoo` and `marginalia` (an independent index of non-commercial sites); add them to `SEARCH_PROVIDERS`.
- Fix: the database now defaults to `~/.search-memory-mcp/websearch_cache.db` instead of the working directory, which MCP clients such as Claude Desktop on Windows start in a read-only folder (`SQLITE_CANTOPEN`). An existing `websearch_cache.db` in the working directory is still used.
- Routing profile `v2`: `auto` search tries providers in measured reliability order (SearXNG, Brave, DuckDuckGo, then Bing and Google) instead of preferring Google and Bing, which mostly block scrapers.
- Optional Brave Search API support: with `BRAVE_SEARCH_API_KEY` set, the `brave` provider uses the official API instead of scraping, and leads the default provider order.

## 1.0.0 (2026-10-09)

First published release.

### Search and fetch
- Web search with ordered fallback, health tracking and aggregate/auto strategies over DuckDuckGo, Bing, Brave, Google and an optional self-hosted SearXNG (`SEARXNG_BASE_URL`).
- Provider blocks (HTTP errors, Google's JavaScript-required page) are reported as errors instead of empty results.
- `research` tool: searches the web and the local knowledge base, fetches sources and returns a cited answer with `publishedAt`/`fetchedAt` dates.
- `fetch_content` and `index_url` read PDF, DOCX and EPUB responses as well as HTML pages. They retry with plain headers when a bot challenge blocks the browser request.
- Search cache lifetimes depend on query intent.

### Knowledge base and memory
- `ingest_document` reads local PDF, DOCX, EPUB, HTML and text files inside `INGEST_ALLOWED_DIRS` (off by default; hidden files are never read).
- Hybrid FTS + vector search, entity graph (`find_related`) and session memory (`remember`/`recall`/`forget`).
- The embedding model is loaded once, in the background at startup; queries never wait for it.

### Security
- Prompt-injection defenses for web content: hidden elements and invisible characters are removed, and content is wrapped in `<untrusted_web_content>` markers.
- SSRF protection for every fetched URL and redirect.

### MCP
- Tool annotations and output schemas with structured content for all 12 tools.

### Operations
- Docker image on GHCR (linux/amd64, linux/arm64) and a SearXNG compose profile.
- `npm run e2e`, `npm run benchmark:providers` and `scripts/diagnose-document.mjs` for checking a setup.
