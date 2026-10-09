# Search Memory MCP

**Free web search and long-term memory for your AI assistant. No API keys. Your data stays on your machine.**

[![npm](https://img.shields.io/npm/v/search-memory-mcp)](https://www.npmjs.com/package/search-memory-mcp)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any other MCP client.

## Why Search Memory MCP?

- 🔎 **Search the web for free.** DuckDuckGo, Bing, Brave, and Google, with automatic fallback. No API keys, no subscriptions.
- 📄 **Read any page as clean Markdown.** Fast paths for GitHub, RSS, and static pages. PDF, DOCX and EPUB links are converted to text. A real browser only when a page needs it.
- 🧠 **Remember across sessions.** Your assistant can save notes and recall them later.
- 📚 **Build a private knowledge base.** Index pages and documents, then search them with keyword + semantic search and get answers with citations.
- 🔁 **Research that remembers.** One `research` call checks what you already indexed, searches the web, reads the top pages, answers with citations, and keeps the pages for next time. Every source shows when it was published (from page or PDF metadata) and when it was fetched or indexed, so you can tell how current an answer is.
- 🔒 **Local first.** Cache, memory, index, and models all run on your machine.
- 🛡️ **Safer with untrusted pages.** Hidden text and invisible characters are removed from fetched pages, and web content is marked as data so the assistant is told not to follow instructions inside it. See [SECURITY.md](SECURITY.md).

## Quick start

Add this to your MCP client config (for example `claude_desktop_config.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "search-memory": {
      "command": "npx",
      "args": ["-y", "search-memory-mcp@latest"]
    }
  }
}
```

Restart your client and ask: *"Search the web for the latest Node.js release and remember the version number."*

> Search and most pages work right away. Pages that need a real browser use Playwright Chromium (about 180 MB). It is downloaded during install, or on first use if your package manager skipped install scripts, so that first request can take a few minutes. To download it ahead of time, run `npx playwright install chromium`. Model-backed features download small local models on first use.

> Requires Node.js 20.9 to 25 (Node 24 recommended). If your Node version is newer, or npm skipped install scripts, the server prints the exact fix when it starts. You can also [run it in Docker](#run-in-docker-no-local-setup) with nothing installed on your machine except Docker.

### Run in Docker (no local setup)

Docker brings its own Node 24, SQLite module and Chromium, so it works whatever Node version you have. Point your MCP client at the published image (linux/amd64 and linux/arm64):

```json
{
  "mcpServers": {
    "search-memory": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "-v", "search-memory-data:/app/data", "-v", "search-memory-models:/root/.cache/huggingface", "ghcr.io/kefyusuf/search-memory-mcp:latest"]
    }
  }
}
```

Docker downloads the image on first start. Run `docker pull ghcr.io/kefyusuf/search-memory-mcp:latest` to update, or use a version tag such as `:1.0` to stay on one release. To build the image yourself instead, run `docker build -t search-memory-mcp .` in a clone and use `search-memory-mcp` as the image name.

The named volumes keep your cache, memory, knowledge base and downloaded models between runs. To let `ingest_document` read local files, mount the folder and allow it, for example `"-v", "/home/me/notes:/notes:ro", "-e", "INGEST_ALLOWED_DIRS=/notes"`.

## Features

**Search & fetch**

- Browser context pooling with a persistent Playwright browser instance.
- Web search through configurable providers with health tracking and ordered fallback. Supported scrapers: DuckDuckGo, Bing, Brave, Google. Optional SearXNG meta-search provider (self-hosted or trusted public instance) via `SEARXNG_BASE_URL`.
- Search responses report which providers were tried and why any failed, were empty, or were skipped (`providerAttempts` in structured output, a short "Provider notes" line in text output).
- Search-result cache lifetime follows the query type: news 15 minutes; shopping, local and general 1 hour; technical, research and navigational 24 hours.
- `fetch_content` and `index_url` extract text from PDF, DOCX and EPUB responses (detected by content type, or by extension for generic binary responses), up to 25 MB per document, without opening a browser.
- Federated search across providers with URL normalization, cross-provider deduplication, and Reciprocal Rank Fusion (RRF).
- Opt-in intent-aware search routing (`strategy=auto`) with heuristics, local classifier fallback, and versioned provider profiles.
- Domain filter (`domain`) and date-range filter (`from_date` / `to_date`).
- Query rewrite for local-index searches and opt-in web multi-query expansion (`expand_query=true`): abbreviation expansion, question normalization, and news year bias.
- Optional cross-encoder reranking (`ENABLE_RERANKER`).
- Deep-search answers with paragraph/sentence term scoring, stopword filtering, and per-source citations.
- Structured JSON output (`format: "json"`) for machine-readable search results and answers. `web_search`, `search_index` and `server_status` also declare an MCP `outputSchema` and return `structuredContent` on every successful call.

**Local knowledge base (RAG)**

- Document chunking (paragraph-first with overlap).
- Hybrid retrieval: FTS5 keyword search + `sqlite-vec` semantic search fused with RRF. Degrades to FTS-only when embeddings are unavailable.
- `ingest_document`, `index_url`, `search_index`, and `list_index` tools for building a citable local corpus.
- Entity graph over indexed documents with `find_related` (related docs + co-occurring entities).

**Memory & observability**

- Session memory (`remember` / `recall` / `forget`) with topic, tags, and session scoping.
- Per-search execution traces (stages, timings, cache). Recent searches surface in `server_status`; `TRACE_SEARCHES=true` logs full traces.
- Retrieval eval harness (`npm run eval:retrieval`) with recall@k, precision@k, and MRR.

**Safety & infrastructure**

- HTTP-first page fetching with GitHub Raw and RSS fast paths plus Playwright fallback.
- SSRF protection for `fetch_content` and `index_url` by blocking localhost and private network targets.
- Token-bucket rate limiting for search and fetch tools.
- Semantic cache backed by SQLite and `sqlite-vec`, namespaced per execution strategy/plan.

## Requirements

- Node.js 20.9.0 or newer.
- Node.js 24 is the development baseline (`.nvmrc`); CI uses the same version. After switching Node versions, reinstall dependencies so native modules such as `better-sqlite3` match the active runtime.
- npm.
- Network access during installation for npm packages, Playwright Chromium, and first-run model downloads.

## Installation

```bash
npm install
npm run build
```

The `postinstall` script downloads Playwright Chromium. On first use of model-backed features, Transformers.js downloads the required model files to the local Hugging Face cache. The first request that loads a model can be slow; later requests reuse the local cache. Keep `ENABLE_CROSSLINGUAL=false` and `ENABLE_RERANKER=false` for the lightest first run. Obvious `strategy=auto` intents are resolved by heuristics without loading the intent classifier; ambiguous auto queries may trigger a first-run classifier download.

## MCP Client Configuration

Add the built server to your MCP client config:

The package, command and MCP server identity are `search-memory-mcp`. Use your actual checkout path in the configuration below. Existing clients that launch `node` with an absolute `build/index.js` path can keep that path even if the checkout directory still has its previous name. Restart the MCP connection after rebuilding to load the updated server identity. Keep existing `CACHE_DB_PATH` values to retain stored data.

```json
{
  "mcpServers": {
    "websearch": {
      "command": "node",
      "args": ["path/to/search-memory-mcp/build/index.js"],
      "env": {
        "RATE_LIMIT_SEARCH_PER_MIN": "10",
        "RATE_LIMIT_FETCH_PER_MIN": "20",
        "SEARCH_PROVIDERS": "duckduckgo,bing",
        "ENABLE_CROSSLINGUAL": "false",
        "CACHE_DB_PATH": "websearch_cache.db"
      }
    }
  }
}
```

If the package is installed globally or through a package runner, use the binary entrypoint:

```json
{
  "mcpServers": {
    "websearch": {
      "command": "search-memory-mcp",
      "args": [],
      "env": {
        "SEARCH_PROVIDERS": "duckduckgo,bing",
        "ENABLE_CROSSLINGUAL": "false"
      }
    }
  }
}
```

For package-runner based clients, use the `npx` configuration from [Quick start](#quick-start).

## Tools

| Tool | Description |
| --- | --- |
| `web_search` | Searches the web and returns ranked results. Supports `strategy` (`fallback`/`aggregate`/`auto`), `domain`, `from_date`/`to_date`, `format` (`text`/`json`), and `deep=true` for source-backed answers. |
| `fetch_content` | Fetches a URL and returns clean Markdown with content caching, charset handling, GitHub Raw fast paths, RSS feed extraction, and Playwright fallback. |
| `research` | Researches a question in one call: checks the local knowledge base, searches the web, reads the top pages (`max_sources`, default 3), answers with citations from both, and adds the pages it read to the knowledge base (`index=false` to skip; sources already indexed are not added again). |
| `server_status` | Returns provider availability, cache stats, knowledge index stats, memory stats, entity graph stats, recent search traces, browser state, routing profile metadata, feature flags, and uptime. |
| `ingest_document` | Chunks a document and indexes it into the local knowledge base (FTS + vectors) and entity graph. Pass `content`, or `path` to a local PDF, DOCX, EPUB, HTML or text file inside `INGEST_ALLOWED_DIRS`. |
| `index_url` | Fetches a URL and indexes its Markdown into the local knowledge base and entity graph. |
| `search_index` | Hybrid keyword + semantic search over the local knowledge base; returns chunks with source citations. Supports `format: "json"`. |
| `list_index` | Lists documents stored in the local knowledge base. |
| `remember` | Stores a short fact or note in session memory. |
| `recall` | Searches or lists session memory notes. |
| `forget` | Deletes a session memory note by id. |
| `find_related` | Explores the entity graph: related documents and co-occurring entities for an entity name. |

### Search strategies

| Strategy | Behavior | Semantic query cache |
| --- | --- | --- |
| `fallback` **(default)** | Tries configured providers in order and stops at the first usable result set. | Enabled (namespace: `fallback`) |
| `aggregate` | Queries all currently available configured providers in parallel, deduplicates URLs, and fuses rankings with RRF. | Enabled (namespace: `aggregate`) |
| `auto` | Detects intent, builds a routing plan from profile `v1`, then delegates to the existing fallback/aggregate executor. | Enabled (namespace: `auto:{profile}:{intent}:{providers}`) |

Semantic query cache keys are namespaced by execution strategy (and by plan fingerprint for `auto`), so a cached `fallback` result is never reused for `aggregate` or a different auto plan. Deep-search page content continues to use the normal content cache.

Domain and date bounds are exact cache constraints, isolated from semantic query similarity. Provider candidates are cached and the requested domain/date filters are reapplied on every hit, including before deep page fetching. A cache entry with no eligible candidates triggers provider execution. Namespace filtering happens before the vector-store result limit so unrelated strategies cannot crowd out eligible entries.

`SEARCH_PROVIDERS` is an **allowlist** as well as the configured provider set. Auto routing never activates a provider omitted from `SEARCH_PROVIDERS`; the routing profile only changes ordering and how many configured providers are selected as primary candidates.

For aggregate auto profiles, secondary configured providers are contacted only if **all** selected primary providers return no usable result. A partial primary success is accepted instead of widening the request just to increase result count. This limits scraping load and reduces unnecessary blocking/CAPTCHA exposure.

Current routing profile: `v1`.

| Intent | Execution | Preferred order | Primary target |
| --- | --- | --- | ---: |
| `technical` | aggregate | searxng, brave, google, bing, duckduckgo | 2 |
| `research` | aggregate | searxng, brave, google, bing, duckduckgo | 3 |
| `news` | aggregate | searxng, google, bing, brave, duckduckgo | 3 |
| `commercial` | aggregate | searxng, brave, google, bing, duckduckgo | 3 |
| `shopping` | aggregate | google, bing, searxng, duckduckgo, brave | 2 |
| `local` | aggregate | google, bing, searxng, duckduckgo, brave | 2 |
| `navigational` | fallback | google, bing, searxng, duckduckgo, brave | all configured |
| `general` | fallback | existing configured order | all configured |

These provider preferences are initial hypotheses, not permanent quality claims. They are versioned so later releases can tune them from deterministic and live evaluation evidence without scattering routing conditionals through the server.

### Example: intent-aware search

```json
{
  "query": "PostgreSQL connection pooling best practices",
  "strategy": "auto",
  "max_results": 5
}
```

Use `domain` for targeted searches such as `react.dev` or `github.com`. Intent detection always receives the original query; `site:<domain>` is appended only afterward for provider execution.

```json
{
  "query": "server components reference",
  "domain": "react.dev",
  "strategy": "auto",
  "max_results": 5
}
```

Use `from_date` / `to_date` (inclusive `YYYY-MM-DD`) to filter by detected publish dates in titles and snippets. Results without a detectable date are kept by default.

Use `deep=true` only when the client needs the server to fetch top pages and extract a likely answer from page text. Answers include per-source citations (`[Source N]`) mapped to the fetched URLs. The MCP client LLM remains responsible for final reasoning and summarization.

Search snippets with old detected dates include a short freshness warning so clients can treat stale sources carefully.

### Example: federated search

```json
{
  "query": "postgres connection pooling strategies",
  "strategy": "aggregate",
  "max_results": 5
}
```

### Example: multi-query search

```json
{
  "query": "how to configure db backup",
  "strategy": "auto",
  "expand_query": true,
  "max_results": 5
}
```

`expand_query` defaults to `false`. When enabled, the server searches the original query plus up to two variants, then deduplicates URLs and combines query rankings with RRF before reranking. This can make up to three times as many provider requests. The original query determines intent and locale; every variant keeps the domain restriction and uses the same provider plan. Date filters apply to the combined results. Expanded searches use a separate cache namespace, and cache hits skip all provider requests.

### Example: structured JSON output

```json
{
  "query": "postgres pooling",
  "format": "json",
  "max_results": 5
}
```

Returns a stable payload with `query`, `resultCount`, `results[]` (title, url, snippet, source, optional scores), and `meta`.

### Example: local knowledge base

```json
{ "content": "PgBouncer multiplexes PostgreSQL connections...", "title": "PgBouncer Guide", "source": "https://example.com/pgbouncer" }
```

Then search it:

```json
{ "query": "connection pooler", "max_results": 5 }
```

Or explore the entity graph:

```json
{ "entity": "PgBouncer" }
```

`fetch_content` uses fast source-specific paths before opening a browser:

- GitHub repository, blob, tree, and raw URLs are read from `raw.githubusercontent.com` when possible.
- RSS or Atom feed URLs, plus common blog/news feed paths, are converted into a Markdown list of recent items.
- Regular HTML pages still use HTTP-first Readability parsing with Playwright fallback.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_SEARCH_PER_MIN` | `10` | Maximum `web_search` requests per minute. Invalid or non-positive values disable the limiter. |
| `RATE_LIMIT_FETCH_PER_MIN` | `20` | Maximum `fetch_content` requests per minute. Invalid or non-positive values disable the limiter. |
| `SEARCH_PROVIDERS` | `duckduckgo,bing` | Comma-separated provider allowlist/order. Supported values: `duckduckgo`, `bing`, `brave`, `google`, `searxng`. |
| `SEARXNG_BASE_URL` | unset | Base URL of a SearXNG instance with the JSON format enabled (for example `https://searx.example.com`). Required for the `searxng` provider; no API key is used. |
| `ENABLE_CROSSLINGUAL` | `false` | Enables language detection and cross-lingual search support. This can trigger first-run local model downloads. When disabled, query heuristics still infer supported locales such as Turkish. |
| `ENABLE_RERANKER` | `false` | Enables optional cross-encoder reranking of `web_search` results using a local Transformers.js model. First use downloads the model. |
| `TRACE_SEARCHES` | `false` | Logs a compact per-search execution trace (stages, timings, cache) to stderr. Recent searches are always exposed via `server_status`. |
| `MEMORY_MAX_NOTES` | `500` | Maximum session-memory notes kept; oldest notes are evicted first. |
| `FETCH_WAIT_UNTIL` | `networkidle` | Playwright wait strategy. Use `domcontentloaded` for faster rendered-page fallback. |
| `CHROMIUM_INSTALL_TIMEOUT_MS` | `600000` | Maximum time for the automatic first-use Chromium download. A stalled download is stopped after this time and the next browser request tries again. |
| `FORCE_PLAYWRIGHT` | unset | Set to `true` to skip HTTP-first fetch and always use Playwright. |
| `CACHE_DB_PATH` | `websearch_cache.db` | SQLite database path used by the semantic cache, content cache, knowledge index, session memory, and entity graph. |
| `INGEST_ALLOWED_DIRS` | _(empty: disabled)_ | Comma-separated directories `ingest_document` may read files from, for example `~/Documents/notes,~/Papers`. Symlinks are resolved first, so a link cannot point outside these directories. Hidden files and anything inside hidden folders (such as `.ssh` or `.env`) are never read. Files above 25 MB are refused. |
| `CACHE_CLEANUP_INTERVAL_HOURS` | `24` | Interval for expired content cache cleanup. |

File-backed SQLite stores use WAL journaling with `synchronous=FULL`; `:memory:` databases remain in memory. Use a writable local data directory: WAL requires shared memory on the same host and is unsuitable for a database shared over a network filesystem. While the server is running, the `-wal` and `-shm` files belong to the database; copying only the `.db` file does not provide a consistent live backup. See [SQLite WAL documentation](https://www.sqlite.org/wal.html) and the [disposable backup/restore rehearsal](docs/sqlite-backup-restore.md). Production backup operations remain separate from these local regressions.

## Docker

A GitHub Actions workflow (`.github/workflows/docker.yml`) builds the image, runs the MCP smoke test against it over stdio, and publishes `ghcr.io/kefyusuf/search-memory-mcp` for linux/amd64 and linux/arm64: `:latest` and `:sha-<commit>` from `main`, semver tags from `v*` tags. To run the smoke test against any image locally: `SMOKE_DOCKER_IMAGE=<image> npm run smoke:mcp`.

```bash
npm run docker:build
npm run docker:up
```

### Optional SearXNG

Measured provider reliability varies (see Troubleshooting), so the compose file includes an optional self-hosted [SearXNG](https://docs.searxng.org/) service as a second reliable source. It starts only with the `searxng` profile and is reachable only inside the compose network:

```bash
SEARXNG_SECRET=$(openssl rand -hex 32) \
SEARCH_PROVIDERS=searxng,duckduckgo \
SEARXNG_BASE_URL=http://searxng:8080 \
docker compose --profile searxng up
```

`docker/searxng/settings.yml` enables the JSON API that this server reads and turns off SearXNG's public rate limiter. The Docker image workflow starts this service in CI and checks that it answers a JSON search.

Docker Compose stores the SQLite cache in a named volume mounted at `/app/data` and stores Hugging Face models in a separate named volume. The container sets `CACHE_DB_PATH=/app/data/websearch_cache.db`.

Both Docker stages use Node 24, matching `.nvmrc` and CI. The runtime explicitly initializes the native SQLite binding after installing dependencies with lifecycle scripts disabled. To check the compiled stdio interface with a disposable database, run from the repository root:

```bash
docker compose -p search-memory-mcp-check run --rm -T \
  -v "${PWD}/scripts:/app/scripts:ro" \
  -e CACHE_DB_PATH=/tmp/search-memory-mcp-smoke.db \
  search-memory-mcp node scripts/smoke-mcp.mjs
docker compose -p search-memory-mcp-check down --volumes --remove-orphans
```

The smoke check verifies initialization, tool discovery, status, memory save/recall/deletion, argument validation and loopback blocking. It does not qualify live search providers or model inference. Use a distinct Compose project name for checks so the development data volumes remain separate.

If a trusted TLS inspection proxy intercepts browser downloads, supply its public CA certificate as the optional BuildKit `build_ca` secret:

```bash
docker build --secret id=build_ca,src=/path/to/trusted-ca.pem -t search-memory-mcp:latest .
```

The certificate is used only during dependency installation and is not copied into the image. Runtime HTTPS trust is a separate configuration concern; keep TLS verification enabled.

## Development

See the [production roadmap](docs/production-roadmap.md) and [sector comparison](docs/research/2026-10-02-production-benchmark.md) for release scope, production gaps, and measurable launch gates.

```bash
npm run build
npm run typecheck
npm test
npm run smoke:mcp
npm run eval:retrieval
npm audit --audit-level=moderate
npm pack --dry-run --json
```

`npm run e2e` runs a user scenario against the compiled server through the MCP SDK client: memory, local PDF/DOCX ingestion (including refusing hidden and outside files), knowledge search, entity graph, then web search, page and PDF fetch, and research. Web steps are reported as SKIP when web search is unavailable, so the local steps can run anywhere; run it on a normal network to cover the whole system. It exits with 1 when a step fails.

`npm run smoke:mcp` starts the compiled server over stdio, verifies the `web_search` strategy values (`fallback`, `aggregate`, `auto`), checks the knowledge/memory tools, confirms routing diagnostics from `server_status`, and confirms that `fetch_content` blocks localhost. It does not perform a live provider search, keeping CI independent of search-engine HTML/network availability.

`npm run eval:retrieval` runs an offline FTS-only retrieval baseline (recall@k, precision@k, MRR) over the knowledge index using fixtures in `evals/retrieval/cases.jsonl`. Embeddings are disabled for both ingestion and search, so the evaluation does not load or download models. It does not measure semantic/hybrid retrieval quality.

`npm run benchmark:providers` (after building) sends real queries from `evals/providers/queries.jsonl` (16 EN/TR queries across intents) to each provider in `SEARCH_PROVIDERS`, one provider at a time, and prints success, empty, error and p50/p95 latency per provider. Use `--limit N` for fewer queries, `--delay MS` between requests (default 1500), `--json PATH` to keep the raw attempts, and `--dump DIR` to save the raw response of every empty or failed attempt (useful to tell a block or consent page from changed result markup). It contacts real search engines, so it is not part of CI; results depend on your network and the engines' blocking at that moment.

After building, `node scripts/eval-local-quality.mjs` prints a broader synthetic FTS/entity characterization as JSON. See [fixture labels and limitations](evals/local-quality/README.md). Keep generated reports in ignored `.cache/`; this diagnostic does not change runtime behavior or enforce a release threshold.

Deterministic TR/EN routing fixtures live in `evals/search-routing/queries.jsonl` and are exercised by the normal Vitest suite. They validate intent coverage, conservative heuristic behavior, ambiguity defer cases, and provider-allowlist enforcement without loading the real classifier or contacting providers.

## Troubleshooting

- The server downloads Chromium automatically the first time a page needs a browser. If that download fails or stalls (for example offline or behind a proxy), it stops after `CHROMIUM_INSTALL_TIMEOUT_MS`; run `npx playwright install chromium` manually.
- If the server says it could not load its SQLite module (`better-sqlite3`), follow the steps it prints: use Node 24 (the version in `.nvmrc`); if npm 11 skipped install scripts, run `npm install-scripts approve better-sqlite3`; then `npm rebuild better-sqlite3`. Or [run it in Docker](#run-in-docker-no-local-setup).
- If the first model-backed request is slow, allow the Transformers.js model download to complete and retry.
- If search returns no results, change `SEARCH_PROVIDERS` order/set or try a direct `fetch_content` URL.
- Provider reliability varies by network. In a live run in October 2026 (`npm run benchmark:providers`), DuckDuckGo answered every query; Bing sometimes returned a "no results" page for ordinary queries, which looks like a soft block; Brave answered HTTP 429; and Google returned a JavaScript-required page to every request, which is now reported as an error. Keep `duckduckgo` first, and add a self-hosted SearXNG (`SEARXNG_BASE_URL`) if you need a second reliable source. Measure your own network with `npm run benchmark:providers`.
- If aggregate mode is too slow or triggers provider blocking, use the default `fallback` strategy.
- If `auto` chooses too broad a search plan for your use case, use explicit `fallback` or `aggregate`; explicit strategies bypass the auto planner.
- If Docker cannot find Chromium, rebuild the image with `npm run docker:build`.
- If cache files appear in the project root, set `CACHE_DB_PATH` to a dedicated data directory.
- If knowledge search only hits keywords, embeddings may still be indexing; `search_index` falls back to FTS-only until vectors are ready.

## Known limitations

- **Default search depends mostly on DuckDuckGo.** Search engines block scraping clients. In our measurements, Brave answers with HTTP 429 and Google serves a JavaScript-only page; both now show up as provider errors. When Bing blocks a client, it returns a normal-looking "no results" page that cannot be told apart from a real empty result. For dependable results, add a self-hosted [SearXNG](#optional-searxng) (`SEARXNG_BASE_URL`) as a second source; see [Troubleshooting](#troubleshooting).
- **Hidden-content filtering is best effort.** Elements hidden by the `hidden` attribute, `aria-hidden`, `<template>` or inline styles are removed. Content hidden by external stylesheets or scripts is not. Web content is wrapped in `<untrusted_web_content>` markers, but the client model must still treat it as data.
- **Scanned PDFs are not read.** PDF text is extracted without OCR, so image-only pages produce no text.
- **The first run downloads models and a browser.** The embedding model and Playwright Chromium are fetched on first use. Offline machines need them pre-installed, or the Docker image.
- **Single local user.** The server runs over stdio for one local client. There is no authentication and no shared HTTP endpoint yet.
- **Web steps need an open network.** `npm run e2e` reports web steps as SKIP when search engines are unreachable.

## npm Packaging

The npm package includes only `build/`, `README.md`, `LICENSE`, and `SECURITY.md`. `npm pack` runs `npm run build` through `prepack` so the package contains compiled JavaScript instead of local planning files, tests, caches, or source-only artifacts.

## Security

See `SECURITY.md` for reporting instructions and current dependency audit notes.

## License

ISC
