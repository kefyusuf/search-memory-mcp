# Search Memory MCP

**Free web search and long-term memory for your AI assistant. No API keys. Your data stays on your machine.**

[![npm](https://img.shields.io/npm/v/search-memory-mcp)](https://www.npmjs.com/package/search-memory-mcp)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)

Works with Claude Desktop, Claude Code, Cursor, Windsurf, and any other MCP client.

## Why Search Memory MCP?

- 🔎 **Search the web for free.** DuckDuckGo, Bing, Brave, and Google, with automatic fallback. No API keys, no subscriptions.
- 📄 **Read any page as clean Markdown.** Fast paths for GitHub, RSS, and static pages. A real browser only when a page needs it.
- 🧠 **Remember across sessions.** Your assistant can save notes and recall them later.
- 📚 **Build a private knowledge base.** Index pages and documents, then search them with keyword + semantic search and get answers with citations.
- 🔒 **Local first.** Cache, memory, index, and models all run on your machine.

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

> The first install downloads Playwright Chromium (over 100 MB). Model-backed features download small local models on first use.

## Features

**Search & fetch**

- Browser context pooling with a persistent Playwright browser instance.
- Web search through configurable providers with health tracking and ordered fallback. Supported scrapers: DuckDuckGo, Bing, Brave, Google. Optional SearXNG meta-search provider (self-hosted or trusted public instance) via `SEARXNG_BASE_URL`.
- Federated search across providers with URL normalization, cross-provider deduplication, and Reciprocal Rank Fusion (RRF).
- Opt-in intent-aware search routing (`strategy=auto`) with heuristics, local classifier fallback, and versioned provider profiles.
- Domain filter (`domain`) and date-range filter (`from_date` / `to_date`).
- Query rewrite for local-index searches and opt-in web multi-query expansion (`expand_query=true`): abbreviation expansion, question normalization, and news year bias.
- Optional cross-encoder reranking (`ENABLE_RERANKER`).
- Deep-search answers with paragraph/sentence term scoring, stopword filtering, and per-source citations.
- Structured JSON output (`format: "json"`) for machine-readable search results and answers.

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
| `server_status` | Returns provider availability, cache stats, knowledge index stats, memory stats, entity graph stats, recent search traces, browser state, routing profile metadata, feature flags, and uptime. |
| `ingest_document` | Chunks a document and indexes it into the local knowledge base (FTS + vectors) and entity graph. |
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
| `FORCE_PLAYWRIGHT` | unset | Set to `true` to skip HTTP-first fetch and always use Playwright. |
| `CACHE_DB_PATH` | `websearch_cache.db` | SQLite database path used by the semantic cache, content cache, knowledge index, session memory, and entity graph. |
| `CACHE_CLEANUP_INTERVAL_HOURS` | `24` | Interval for expired content cache cleanup. |

File-backed SQLite stores use WAL journaling with `synchronous=FULL`; `:memory:` databases remain in memory. Use a writable local data directory: WAL requires shared memory on the same host and is unsuitable for a database shared over a network filesystem. While the server is running, the `-wal` and `-shm` files belong to the database; copying only the `.db` file does not provide a consistent live backup. See [SQLite WAL documentation](https://www.sqlite.org/wal.html). Application backup/restore qualification remains separate from process-crash recovery.

## Docker

```bash
npm run docker:build
npm run docker:up
```

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

`npm run smoke:mcp` starts the compiled server over stdio, verifies the `web_search` strategy values (`fallback`, `aggregate`, `auto`), checks the knowledge/memory tools, confirms routing diagnostics from `server_status`, and confirms that `fetch_content` blocks localhost. It does not perform a live provider search, keeping CI independent of search-engine HTML/network availability.

`npm run eval:retrieval` runs an offline FTS-only retrieval baseline (recall@k, precision@k, MRR) over the knowledge index using fixtures in `evals/retrieval/cases.jsonl`. Embeddings are disabled for both ingestion and search, so the evaluation does not load or download models. It does not measure semantic/hybrid retrieval quality.

After building, `node scripts/eval-local-quality.mjs` prints a broader synthetic FTS/entity characterization as JSON. See [fixture labels and limitations](evals/local-quality/README.md). Keep generated reports in ignored `.cache/`; this diagnostic does not change runtime behavior or enforce a release threshold.

Deterministic TR/EN routing fixtures live in `evals/search-routing/queries.jsonl` and are exercised by the normal Vitest suite. They validate intent coverage, conservative heuristic behavior, ambiguity defer cases, and provider-allowlist enforcement without loading the real classifier or contacting providers.

## Troubleshooting

- If startup fails after install, run `npx playwright install chromium`.
- If `better-sqlite3` reports `NODE_MODULE_VERSION` mismatch, switch to the Node version in `.nvmrc` and run `npm ci` using that runtime before building again.
- If the first model-backed request is slow, allow the Transformers.js model download to complete and retry.
- If search returns no results, change `SEARCH_PROVIDERS` order/set or try a direct `fetch_content` URL.
- If aggregate mode is too slow or triggers provider blocking, use the default `fallback` strategy.
- If `auto` chooses too broad a search plan for your use case, use explicit `fallback` or `aggregate`; explicit strategies bypass the auto planner.
- If Docker cannot find Chromium, rebuild the image with `npm run docker:build`.
- If cache files appear in the project root, set `CACHE_DB_PATH` to a dedicated data directory.
- If knowledge search only hits keywords, embeddings may still be indexing; `search_index` falls back to FTS-only until vectors are ready.

## npm Packaging

The npm package includes only `build/`, `README.md`, `LICENSE`, and `SECURITY.md`. `npm pack` runs `npm run build` through `prepack` so the package contains compiled JavaScript instead of local planning files, tests, caches, or source-only artifacts.

## Security

See `SECURITY.md` for reporting instructions and current dependency audit notes.

## License

ISC
