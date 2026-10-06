# ADR-0001: Intent-Aware Search Routing

Date: 2026-08-24
Status: Accepted

Implementation update (2026-10-02): auto routing shipped in `f2b0979`; `1a54286` subsequently added plan-aware semantic cache namespaces. The cache bypass described below is historical. See [current development status](../development-status.md).

## Context

The server currently supports explicit ordered fallback and federated aggregate search. Provider choice is configuration-driven but not query-intent-aware. A simplistic global provider order is insufficient because technical, news, shopping, local, company, and navigational searches benefit from different provider preferences and different execution breadth.

A routing layer must not replace the existing execution engines, silently activate providers that were not configured, or require local-model inference for every request.

## Decision

Introduce an opt-in `strategy=auto` mode implemented as a planning layer above the existing executor.

The router will:

1. detect intent using conservative high-confidence heuristics first;
2. use the local zero-shot classifier only when heuristics are ambiguous or inconclusive;
3. classify queries into eight domain intents: `technical`, `research`, `news`, `commercial`, `shopping`, `local`, `navigational`, `general`;
4. convert intent plus `SEARCH_PROVIDERS` into a deterministic, versioned `SearchPlan`;
5. treat configured providers as an allowlist;
6. delegate the plan to the existing `fallback` or `aggregate` execution path;
7. keep omitted `strategy` defaulting to `fallback` for backward compatibility;
8. bypass the current semantic query cache for `auto` until cache keys are plan-aware.

Routing policy will be stored as profile data rather than scattered conditionals in `index.ts`.

## Initial Profile Policy

- technical: aggregate, prefer Brave/Google, target 2
- research: aggregate, prefer Brave/Google/Bing, target 3
- news: aggregate, prefer Google/Bing/Brave, target 3
- commercial: aggregate, prefer Brave/Google/Bing, target 3
- shopping: aggregate, prefer Google/Bing, target 2
- local: aggregate, prefer Google/Bing, target 2
- navigational: fallback in provider preference order
- general: preserve configured fallback order

All profiles are intersected with configured providers before execution.

## Failure Policy

For an aggregate auto plan, secondary configured providers are queried only if every primary provider returns no usable result. A partial primary success is accepted rather than expanding the request merely to increase result count.

Existing provider health/backoff behavior remains authoritative.

## Consequences

### Positive

- Provider selection becomes intent-aware without replacing tested v1.1 execution code.
- Common high-confidence queries avoid transformer inference.
- Search breadth can be controlled by intent, reducing unnecessary scraper calls.
- Provider policy is deterministic, testable, versioned, and later tunable from eval data.
- Existing explicit strategies remain stable.

### Negative

- Intent taxonomy and profiles introduce a new policy surface that must be evaluated and maintained.
- Auto mode initially bypasses semantic query caching.
- The initial profile ordering is a hypothesis, not a permanent quality truth.
- Local classifier loading remains necessary for ambiguous queries.

## Rejected Alternatives

### Rules-only routing

Rejected because a fixed keyword router becomes brittle for ambiguous comparisons, company research, and mixed-intent queries.

### Model-only routing

Rejected because it adds avoidable first-run/model-inference cost to obvious queries.

### B2B/B2C intent categories

Rejected because they describe market/customer context rather than the user's retrieval intent and lead to ambiguous provider policy.

### Adaptive/learning router in v1.2

Rejected until provider success, latency, blocking, and result-quality data are available. Adaptive weighting is a v1.3 concern.

## Related Design

See `docs/superpowers/specs/2026-08-24-intent-aware-search-routing-design.md` for the full v1.2 contract, testing strategy, locale correction, cache behavior, and delivery sequence.
