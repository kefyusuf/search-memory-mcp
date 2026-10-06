# v1.2 Intent-Aware Search Routing — Design

Date: 2026-08-24
Status: Design approved in chat; written spec pending review
Branch: `design/v1.2-intent-aware-search-routing`

> Historical design: routing shipped in commit `f2b0979`. Later work added plan-aware caching, so the cache exclusions below describe the original release scope. See [current development status](../../development-status.md).

## 1. Objective

Add an opt-in `strategy=auto` mode that classifies search intent, selects an intent-specific subset/order of the already configured search providers, and then delegates execution to the existing `fallback` or `aggregate` engines.

The design must preserve v1.1 behavior for explicit `fallback` and `aggregate`, avoid unnecessary local-model inference, keep `SEARCH_PROVIDERS` as the provider allowlist, and make routing policies measurable rather than embedding provider assumptions directly in orchestration code.

## 2. Current State

The repository currently has:

- `strategy=fallback`: ordered provider failover.
- `strategy=aggregate`: parallel provider execution with URL-aware deduplication, Reciprocal Rank Fusion, and semantic/RRF final reranking.
- `SearchIntentClassifier` owned by the cache layer with the taxonomy `technical | news | general`.
- a semantic query cache that is not namespaced by strategy/provider plan.
- provider configuration through `SEARCH_PROVIDERS`.
- locale inference logic that can detect Turkish queries, but `handleSearch` currently supplies `eng_Latn` whenever cross-lingual mode is disabled, preventing query-based locale inference from running.

## 3. Architectural Decision

Use a hybrid routing architecture:

1. High-confidence deterministic heuristics run first.
2. Ambiguous queries fall back to the local zero-shot classifier.
3. A pure `SearchPlanner` converts intent plus configured providers into a `SearchPlan`.
4. Existing execution/fusion/reranking code performs the search.

`auto` is a planner mode, not a third search-execution algorithm.

```text
web_search
   |
   +-- strategy=fallback  --------------------> existing executor
   +-- strategy=aggregate --------------------> existing executor
   |
   +-- strategy=auto
           |
           v
      Intent Detector
      +-- high-confidence heuristics
      +-- local classifier fallback
           |
           v
       Search Planner
           |
           v
       SearchPlan
      /          \
 fallback      aggregate
      \          /
       existing executor
           |
           v
       existing RRF + semantic rerank
```

## 4. Public Contract

### 4.1 Search strategy

Extend the tool schema to:

```ts
type SearchStrategy = "fallback" | "aggregate" | "auto";
```

Backward compatibility requirement:

- omitted `strategy` remains `fallback`.
- explicit `fallback` bypasses the planner.
- explicit `aggregate` bypasses the planner.
- only explicit `auto` invokes intent-aware routing in v1.2.

`auto` must not become the default in this milestone.

### 4.2 Intent taxonomy

```ts
type SearchIntent =
  | "technical"
  | "research"
  | "news"
  | "commercial"
  | "shopping"
  | "local"
  | "navigational"
  | "general";
```

Definitions:

- `technical`: software, APIs, errors, infrastructure, documentation, implementation, versions, programming, system design.
- `research`: broad investigation, comparisons, adoption, market/technology landscape, surveys, evidence gathering.
- `news`: current events, recent announcements, breaking/developing information.
- `commercial`: companies, vendors, competitors, enterprise products, company discovery/evaluation; not a specific consumer purchase.
- `shopping`: product purchase intent, prices, deals, product selection/comparison.
- `local`: nearby businesses, local services, places, location-constrained discovery.
- `navigational`: user is trying to reach a known official site, page, documentation area, repository, or named destination.
- `general`: catch-all informational search when no stronger intent is established.

B2B/B2C are explicitly not intent labels.

## 5. Intent Detection

Introduce a search-domain intent detector instead of keeping routing semantics inside the cache module.

Proposed files:

```text
src/search/
├── intent.ts
├── heuristics.ts
├── planner.ts
├── profiles.ts
├── executor.ts
└── fusion.ts
```

### 5.1 Heuristic stage

`detectHeuristicIntent(query)` returns a high-confidence intent or `null`.

The heuristic layer must be conservative. If multiple strong intent families match, return `null` and defer to the classifier instead of guessing.

Representative strong signals:

- technical: stack traces, error codes, API/docs terms, package/framework names with implementation verbs, configuration, database/query/runtime terms.
- news: `latest`, `today`, `breaking`, `news`, `announcement`, equivalents in supported user languages when unambiguous.
- shopping: price/buy/deal/product purchase language.
- local: `near me`, `nearby`, neighborhood/city-local-service formulations.
- navigational: explicit domain/URL, `official site`, `documentation page`, known destination formulations.
- commercial: vendor/company/competitor/enterprise evaluation terms.
- research: compare/landscape/adoption/market-share/survey/evidence-oriented formulations.

Priority must not be encoded as a blind first-match chain. Multiple high-confidence matches are considered ambiguous and use the classifier.

### 5.2 Classifier stage

Refactor/relocate the existing local classifier so the search domain owns the taxonomy.

Zero-shot labels should be descriptive phrases rather than only terse enum names, for example:

- software development and technical documentation
- research and comparison
- current news and recent events
- companies vendors and competitors
- shopping products and prices
- local places and nearby services
- official website or specific page
- general information

Classifier failure must return `general`; search must still proceed.

### 5.3 Shared classifier instance

Do not create independent model instances for the router and cache. The server should own/share one search-intent detector (or inject it into consumers) so model loading is not duplicated.

Existing content TTL categorization may continue to consume the same detector through a narrow interface.

For v1.2, content-cache TTL mapping remains deliberately coarse:

- `news` -> `news`
- `technical` -> `technical`
- every other search intent -> `general`

Expanding cache TTL categories for shopping/local/commercial/research is not part of this milestone.

### 5.4 Intent input semantics

Intent detection always receives the original user `query`, not the provider-specific query after domain rewriting.

For example:

```text
query: "Laravel queue retry best practices"
domain: "laravel.com"
```

The router classifies only `Laravel queue retry best practices`. The provider executor may later receive `Laravel queue retry best practices site:laravel.com`.

This prevents `site:` syntax or domain names from accidentally changing retrieval intent.

## 6. Search Planner

The planner must be pure/data-oriented and return provider names rather than provider instances.

```ts
interface SearchPlan {
  intent: SearchIntent;
  strategy: "fallback" | "aggregate";
  primaryProviderNames: string[];
  fallbackProviderNames: string[];
  profileVersion: string;
}
```

Inputs:

```ts
interface PlanSearchInput {
  intent: SearchIntent;
  configuredProviderNames: string[];
}
```

Rules:

1. `SEARCH_PROVIDERS` remains an allowlist. The planner never activates an unconfigured provider.
2. Profile preference determines primary provider selection.
3. Unselected configured providers form the secondary fallback set in the user's configured order.
4. Unknown/unavailable provider names are never invented by the planner.
5. Planner output is deterministic for identical intent/config inputs.

## 7. Routing Profiles

Profiles are policy-as-data, not hard-coded branching inside `index.ts`.

Initial profile version: `v1`.

| Intent | Execution | Preference | Primary target |
|---|---|---|---:|
| technical | aggregate | brave, google, bing, duckduckgo | 2 |
| research | aggregate | brave, google, bing, duckduckgo | 3 |
| news | aggregate | google, bing, brave, duckduckgo | 3 |
| commercial | aggregate | brave, google, bing, duckduckgo | 3 |
| shopping | aggregate | google, bing, duckduckgo, brave | 2 |
| local | aggregate | google, bing, duckduckgo, brave | 2 |
| navigational | fallback | google, bing, duckduckgo, brave | all configured in preferred order |
| general | fallback | existing configured order | all configured |

If fewer configured providers exist than a profile's primary target, all available configured providers in preference order become primary.

Example:

```env
SEARCH_PROVIDERS=duckduckgo,bing
```

Technical plan:

```text
preferred: brave, google, bing, duckduckgo
configured: duckduckgo, bing
primary target: 2
primary: bing, duckduckgo
fallback: []
strategy: aggregate
```

No provider outside the configuration is called.

## 8. Execution and Failure Semantics

### 8.1 Planned fallback

For plans whose strategy is `fallback`, execute the ordered primary list using the current fallback behavior. The executor stops on the first usable provider result.

For `general`, that ordered list is exactly the existing configured provider order. For `navigational`, it is the profile-preferred order intersected with configured providers.

### 8.2 Planned aggregate

For aggregate plans:

1. Execute only the selected primary providers concurrently.
2. Fuse/rank any successful primary result sets using the existing v1.1 path.
3. If at least one primary provider returns usable results, return the fused primary result set; do not call secondary providers merely to increase result count.
4. If all primary providers return no usable results, run the remaining configured providers as ordered fallback.
5. Existing provider-health backoff remains authoritative.
6. If no secondary providers remain and all primaries fail, return the existing no-results/unavailable response.

This limits unnecessary scraping load and reduces CAPTCHA/blocking exposure.

### 8.3 No adaptive weighting in v1.2

Historical success, latency, block rate, and result-quality telemetry do not modify plans in v1.2. That is deferred until evaluation data exists.

## 9. Cache Semantics

The current semantic query cache is not namespaced by strategy or provider plan.

Therefore:

- explicit `fallback`: preserve current query-cache behavior.
- explicit `aggregate`: preserve current query-cache bypass.
- `auto`: bypass semantic query cache in v1.2, regardless of whether the resolved plan uses fallback or aggregate.
- deep page-content cache remains active for every strategy.

Reason: an `auto` plan may change with routing-profile versions or provider configuration, so sharing the current query cache would allow stale cross-strategy/provider-plan contamination.

Namespaced query caching is deferred to a later milestone.

## 10. Locale Correctness Fix

Treat the existing locale behavior as a v1.2 P0 correctness fix.

Current problem:

```ts
resolveSearchLocale(
  query,
  crossLingual ? detectedLanguage : "eng_Latn"
)
```

When cross-lingual mode is disabled, Turkish query heuristics cannot run because English is supplied as an explicit detected language.

Required behavior:

```ts
const detectedLanguage = crossLingual
  ? await detectLanguage(...).catch(() => null)
  : null;

const queryLocale = resolveSearchLocale(query, detectedLanguage);
```

Acceptance examples:

- `Laravel için en iyi queue yapısı` with cross-lingual disabled resolves to `tr-TR`.
- ordinary English query resolves to `en-US`.
- explicit detected language still takes precedence when cross-lingual detection is enabled.

## 11. MCP Diagnostics

`server_status` should expose enough metadata to diagnose routing without emitting per-request verbose traces:

```json
{
  "config": {
    "searchStrategyDefault": "fallback",
    "autoRouting": "available",
    "routingProfileVersion": "v1"
  }
}
```

Do not expose model internals, embeddings, or large profile payloads in status output.

## 12. Observability

Auto mode may emit concise stderr diagnostics such as:

```text
Auto search intent: technical (heuristic)
Auto search plan: aggregate [brave, google], fallback [bing]
```

Requirements:

- no query content should be duplicated unnecessarily in logs.
- no model vectors/prompts are logged.
- explicit fallback/aggregate should not gain noisy planner logging because they bypass the planner.

## 13. Evaluation

### 13.1 Offline deterministic evaluation

Add a committed routing dataset:

```text
evals/search-routing/queries.jsonl
```

Each record contains at least:

```json
{"query":"Laravel queue retry best practices","intent":"technical"}
```

The dataset should include Turkish and English queries and cover all eight intents plus ambiguity cases.

CI metrics/acceptance:

- heuristic cases route to the expected high-confidence intent.
- ambiguous heuristic cases defer to the classifier boundary.
- planner output matches expected execution mode and provider subset.
- configured-provider allowlist is never violated.
- explicit fallback/aggregate behavior remains unchanged.
- domain-filter syntax does not affect intent classification.
- locale regression cases pass.

Do not make network search quality a CI requirement.

### 13.2 Opt-in live benchmark

Provide a manually invoked benchmark path, not a required CI job, capable of comparing:

- individual providers
- explicit aggregate
- auto

Useful metrics:

- successful-search rate
- empty-result rate
- unique domains
- overlap between providers
- latency p50/p95
- provider timeout/block/error rate where observable

Ranking metrics such as MRR/nDCG require judged relevance data and should only be added where a query fixture includes relevance judgments.

## 14. Testing Strategy

TDD is required for implementation.

Minimum test groups:

1. `SearchSchema` accepts `auto` and rejects unknown strategies.
2. heuristic detector: positive and ambiguity/defer cases.
3. classifier mapping/failure fallback without loading real models.
4. shared detector/classifier dependency does not create duplicate classifier instances in server/cache wiring.
5. planner profile tests for every intent.
6. allowlist tests with partial provider configurations.
7. aggregate-primary success does not call secondary fallback providers.
8. aggregate-primary total failure falls back to remaining configured providers.
9. explicit fallback remains first-success ordered behavior.
10. explicit aggregate remains all-configured-provider behavior.
11. auto semantic query-cache bypass.
12. domain-filtered auto search classifies the original query rather than the `site:`-rewritten provider query.
13. Turkish locale regression with cross-lingual disabled.
14. server-status routing metadata.
15. MCP smoke/tool schema exposes `auto` without changing the default.

Existing v1.1 federated regression tests remain mandatory.

## 15. Proposed Code Boundaries

```text
src/search/
├── intent.ts        # SearchIntent, classifier adapter, shared detector contract
├── heuristics.ts    # conservative deterministic intent detection
├── profiles.ts      # routing profile v1 as data
├── planner.ts       # pure intent/config -> SearchPlan
├── executor.ts      # existing execution; add planned execution entry point only as needed
└── fusion.ts        # unchanged unless a test exposes a necessary correction
```

`src/index.ts` responsibilities after v1.2:

```text
parse request
-> resolve locale
-> resolve explicit/auto strategy
-> classify original query for auto only
-> resolve SearchPlan for auto only
-> create provider query/domain rewrite
-> execute
-> filter/rerank/deep fetch
-> format response
```

The planner must not depend on MCP request types, cache implementation, browser state, or concrete provider scraping implementations.

## 16. Delivery Sequence

Implementation should be delivered in reviewable checkpoints on a feature branch:

1. intent taxonomy + heuristics + planner contracts/tests.
2. `strategy=auto` orchestration and provider-plan execution tests.
3. locale P0 fix and regression tests.
4. cache/status/MCP schema integration.
5. offline routing eval fixture and documentation.
6. full build/typecheck/test/smoke/audit/package verification.
7. final code review before merge.

The live network benchmark may be included if it remains isolated and non-blocking; otherwise it can follow as a small v1.2.x PR without delaying the core router.

## 17. Non-Goals

Not part of v1.2:

- auto mode becoming default.
- dynamic provider weighting.
- multi-armed bandit/provider-learning algorithms.
- remote LLM intent classification.
- historical result-quality feedback loops.
- semantic query-cache namespacing.
- per-provider quality scores that alter production routing.
- new official search API integrations.
- redesign of existing RRF/semantic weighting without evaluation evidence.
- provider outcome taxonomy overhaul unless required by a correctness bug discovered during implementation.
- new content-cache TTL categories for the expanded intent taxonomy.

## 18. Acceptance Criteria

v1.2 is complete when:

1. `strategy=auto` is available but `fallback` remains the default.
2. explicit `fallback` and `aggregate` preserve v1.1 behavior.
3. all eight intents have versioned routing profiles.
4. heuristics avoid model inference for high-confidence queries and defer ambiguous cases.
5. the local classifier handles unresolved intent and fails safely to `general`.
6. a shared detector/classifier dependency avoids duplicate model instances for routing and cache intent use.
7. planner never uses an unconfigured provider.
8. aggregate plans use only primary providers unless all primary providers fail.
9. auto search does not read/write the current semantic query cache.
10. domain-filtered auto search classifies the original query, not provider-specific `site:` syntax.
11. Turkish locale inference works when cross-lingual mode is disabled.
12. routing decisions are covered by deterministic TR/EN fixtures.
13. normal repository CI passes, including the blocking dependency audit.
14. no temporary workflow or generated remediation artifact remains in the final PR.

## 19. Follow-Up Direction

v1.3 may use live-eval evidence to introduce:

- provider success/block/latency telemetry,
- outcome taxonomy,
- profile tuning,
- plan-aware semantic query cache keys,
- adaptive provider weighting.

Those changes require measurements gathered from v1.2 and are deliberately excluded from this design.
