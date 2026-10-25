# Live provider benchmark — 2026-10-25 (v1.1.0)

First live measurement after the 1.1.0 release. Scope: a small smoke-scale run, **not** the P1-04 acceptance matrix (which requires ≥50 representative queries across three separate days/locations). Evidence only; no routing-profile decision is taken from it.

## Setup

- Package: `search-memory-mcp@1.1.0` (local build of `main`), Windows host, TR network.
- Providers: `tavily,exa,duckduckgo`. Tavily and Exa used their official APIs with keys from the maintainer's local client configuration; keys never entered the repository or this log.
- 4 queries from `evals/providers/queries.jsonl` per provider, default 1500 ms delay, via `npm run benchmark:providers -- --limit 4 --json 2026-10-25-live-attempts.json`.

## Results

| Provider | Attempts | OK | Empty | Error | Success | p50 ms | p95 ms | Top errors |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| duckduckgo | 4 | 4 | 0 | 0 | 100% | 790 | 988 | - |
| exa | 4 | 4 | 0 | 0 | 100% | 1263 | 2441 | - |
| tavily | 4 | 4 | 0 | 0 | 100% | 1847 | 2148 | - |

All three providers answered every query with zero blocks, empty results, or errors — a marked contrast to the October 2026 scraper measurements (Brave 429, Google JS-only, Yahoo always-500, Bing soft blocks).

## Capability spot checks

- **Tavily freshness + publish dates:** `latest node.js release announcement` returned a result dated `publishedAt: "2026-10-21"` with source `tavily` — the news topic engaged and the provider-reported date flowed into `SearchResultItem.publishedAt` end-to-end.
- **Exa semantic discovery:** the neural-oriented query "papers about attention-free transformer architectures" returned "FNet: Mixing Tokens with Fourier Transforms" — a semantically relevant academic result that keyword scrapers do not surface for this phrasing.
- DuckDuckGo remains the lowest-latency provider; the API providers add capability, not raw speed.

## Interpretation limits

- 4 queries × 1 day × 1 location: no statistical claim. The scraper baseline (October 2026, documented in README) measured 16 queries; the full P1-04 matrix (≥50 queries, three separate days) remains the gate for any routing-profile v2 change.
- Official-API availability depends on account quotas; scraper availability depends on network and engine blocking at measurement time.
- Raw attempts: `2026-10-25-live-attempts.json` in this directory.
