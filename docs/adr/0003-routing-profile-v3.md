# ADR 0003: Routing profile v3 — measured placement of the opt-in official APIs

Status: accepted (2026-10-26). Supersedes the v2 preference ordering for `news` and `research` intents; all other intents keep v2 ordering.

## Context

Routing profile v2 (ADR 0001, updated after the October 2026 scraper benchmark) orders providers by measured reliability only: self-hosted SearXNG and the Brave Search API lead, DuckDuckGo is the only consistently answering scraper, Bing and Google come last. The profile deliberately excluded quality claims that had no measurement.

v1.1.0 added two opt-in official API providers — `tavily` (news topic with provider-reported publish dates) and `exa` (neural retrieval via `type: auto`) — with an explicit rule: no routing-profile placement without live evidence (P1-04).

## Evidence

Three-day live matrix (`evals/providers/2026-10-25-p104-day1.md`, `2026-10-25-p104-day2.md`, `2026-10-26-p104-day3.md`; 50 representative EN/TR queries per run):

- 449/450 attempts (99.8%): DuckDuckGo 150/150 (p50 737–758 ms), Exa 150/150 (p50 1958–2220 ms), Tavily 149/150 (p50 1799–1988 ms; one 10 s timeout correctly classified as an error attempt, never an empty result).
- Capability spot checks: Tavily news queries return provider-reported `publishedAt` (e.g. a 4-day-old result) with the news topic engaged; Exa surfaces semantically relevant academic results for neural phrasing that keyword scrapers do not answer.

## Decision

Profile **v3** changes exactly two intent rows:

| Intent | v3 preference (planner intersects with `SEARCH_PROVIDERS`) |
| --- | --- |
| `news` | tavily, duckduckgo, searxng, brave, bing, google |
| `research` | exa, tavily, searxng, duckduckgo, brave, bing, google |

Everything else (strategies, primary targets, all other intents) keeps v2. Placement follows measured *capability×intent*: news freshness/publish dates are Tavily's measured strength; semantic discovery is Exa's; DuckDuckGo leads the remaining candidates by measured speed and stability.

## Consequences

- **Keyless behavior is unchanged**: the planner intersects preferences with the configured allowlist, and tavily/exa never appear without their keys (`auto` plans resolve as v2 did). Covered by a dedicated regression test.
- **Cache namespaces isolate the change**: `auto:v3:{intent}:{providers}` — no v2-era cache entries are reused.
- **Cost**: users who configure the keys accept per-request billing; primary-target caps (3) bound the extra spend, and `expand_query` multiplies it (documented).
- The single Tavily timeout shows the error taxonomy matters: fallback/aggregate semantics absorb it.

## Rejected alternatives

- Keep v2 and only document advice: rejected — the profile is the designed tuning point for exactly this kind of measured change; scattering advice into docs would not affect `auto` behavior.
- Place Exa in `technical`/`general`: rejected — no per-intent quality measurement exists for those intents; only availability was measured. Revisit after P1-03's offline quality set.
- Move Tavily into every intent: rejected — same reason; capability claims stay where measured.
