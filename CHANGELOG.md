# Changelog

## Unreleased

- Fix: the database now defaults to `~/.search-memory-mcp/websearch_cache.db` instead of the working directory, which MCP clients such as Claude Desktop on Windows start in a read-only folder (`SQLITE_CANTOPEN`). An existing `websearch_cache.db` in the working directory is still used.
- Optional Brave Search API support: with `BRAVE_SEARCH_API_KEY` set, the `brave` provider uses the official API instead of scraping, and leads the default provider order.

## 1.0.0 (unreleased)

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
