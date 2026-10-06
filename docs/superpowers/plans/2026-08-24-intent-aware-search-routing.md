# v1.2 Intent-Aware Search Routing Implementation Plan

Historical plan: routing shipped in commit `f2b0979`. The unchecked steps below are the original implementation instructions, not the current backlog. Later work added plan-aware caching and other features; see [current development status](../../development-status.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in `strategy=auto` routing that detects query intent, builds a deterministic provider plan from configured providers, delegates to existing fallback/aggregate execution, fixes Turkish locale inference, and preserves all v1.1 explicit-strategy behavior.

**Architecture:** Auto routing is a planning layer above the existing executor, not a third execution engine. Conservative deterministic heuristics resolve obvious intents; ambiguous queries fall back to one shared local zero-shot classifier; a pure versioned planner selects provider names from the configured allowlist; planned execution reuses the existing fallback/aggregate code and only expands to secondary providers when an aggregate primary set fails completely.

**Tech Stack:** TypeScript, Node.js >=20.9.0, Vitest, Zod, `@huggingface/transformers`, MCP SDK, Playwright, existing provider adapters and RRF/semantic reranking.

**Spec:** `docs/superpowers/specs/2026-08-24-intent-aware-search-routing-design.md`

## Global Constraints

- `strategy=auto` is opt-in; omitted strategy remains `fallback`.
- Explicit `fallback` and `aggregate` must bypass intent routing and preserve v1.1 behavior.
- `SEARCH_PROVIDERS` is an allowlist; auto routing must never activate an unconfigured provider.
- Intent taxonomy is exactly: `technical | research | news | commercial | shopping | local | navigational | general`.
- High-confidence heuristics run before local model inference; multiple strong heuristic matches defer rather than using first-match priority.
- Auto mode bypasses the current semantic query cache; deep content cache remains enabled.
- Domain filtering must not influence intent detection; the detector receives the original query, while providers receive the later `site:<domain>` rewrite.
- Aggregate auto plans query secondary configured providers only when all selected primary providers return no usable result.
- Existing provider-health backoff remains authoritative.
- Turkish locale inference must work with `ENABLE_CROSSLINGUAL=false`.
- Routing profile version is `v1`.
- No adaptive weighting, remote LLM routing, provider-learning algorithm, or query-cache namespacing in v1.2.
- Normal CI must remain blocking for `npm audit --audit-level=moderate`.

---

## File Structure

### Create

- `src/search/heuristics.ts` — conservative deterministic intent signals only.
- `src/search/intent.ts` — 8-intent domain type, zero-shot classifier adapter, shared detector contract.
- `src/search/profiles.ts` — versioned routing policy as data.
- `src/search/planner.ts` — pure intent + configured provider names -> `SearchPlan`.
- `src/__tests__/search-intent.test.ts` — heuristic/classifier/detector unit coverage.
- `src/__tests__/search-planner.test.ts` — profile, allowlist, order and target coverage.
- `src/__tests__/auto-search.test.ts` — auto orchestration, planner bypass, cache behavior, domain-classification isolation.
- `src/__tests__/search-locale-routing.test.ts` — server-level Turkish locale regression.
- `src/__tests__/search-routing-eval.test.ts` — deterministic JSONL fixture validation.
- `evals/search-routing/queries.jsonl` — committed Turkish/English routing examples.

### Modify

- `src/search/executor.ts` — add planned-execution entry point while retaining explicit execution function.
- `src/cache/semantic-cache.ts` — consume shared search intent detector instead of owning a separate classifier.
- `src/index.ts` — expose `auto`, share detector, orchestrate plan, fix locale resolution, status metadata.
- `src/__tests__/search-params.test.ts` — accept `auto`, still reject unknown strategy.
- `src/__tests__/server-status.test.ts` — routing metadata assertions.
- `scripts/smoke-mcp.mjs` — verify tool enum and routing status metadata.
- `README.md` — document `auto`, profile policy, allowlist semantics and Node/runtime behavior.

### Delete

- `src/cache/intent.ts` — superseded by `src/search/intent.ts` after all imports move.

---

### Task 1: Search-Domain Intent Detection

**Files:**
- Create: `src/search/heuristics.ts`
- Create: `src/search/intent.ts`
- Create: `src/__tests__/search-intent.test.ts`

**Interfaces:**
- Produces: `SearchIntent`, `IntentDetection`, `IntentClassifier`, `SearchIntentClassifier`, `SearchIntentDetector`, `detectHeuristicIntent(query)`.
- Later tasks consume `SearchIntentDetector.detect(query)` and `SearchIntent`.

- [ ] **Step 1: Write failing heuristic tests**

Create `src/__tests__/search-intent.test.ts` with deterministic cases that do not load a real model:

```ts
import { describe, expect, it, vi } from "vitest";
import { detectHeuristicIntent } from "../search/heuristics.js";
import {
  SearchIntentDetector,
  type IntentClassifier,
} from "../search/intent.js";

describe("search intent detection", () => {
  it.each([
    ["TypeError in Laravel queue worker retry configuration", "technical"],
    ["OpenAI latest news today", "news"],
    ["iPhone 17 price and discount", "shopping"],
    ["coffee shops near me", "local"],
    ["official PostgreSQL documentation page", "navigational"],
    ["enterprise CRM vendors and competitors", "commercial"],
    ["cloud database market adoption survey", "research"],
    ["bugün son dakika yapay zeka haberleri", "news"],
    ["yakınımdaki kahve dükkanları", "local"],
  ])("detects %s as %s", (query, expected) => {
    expect(detectHeuristicIntent(query)).toBe(expected);
  });

  it("defers mixed strong signals instead of using first-match priority", () => {
    expect(detectHeuristicIntent("PostgreSQL vs CockroachDB enterprise adoption benchmark"))
      .toBeNull();
  });

  it("uses the classifier only when heuristics defer", async () => {
    const classifier: IntentClassifier = {
      classify: vi.fn(async () => "research"),
    };
    const detector = new SearchIntentDetector(classifier);

    await expect(detector.detect("database platform landscape")).resolves.toEqual({
      intent: "research",
      source: "classifier",
    });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the classifier for a high-confidence heuristic", async () => {
    const classifier: IntentClassifier = {
      classify: vi.fn(async () => "general"),
    };
    const detector = new SearchIntentDetector(classifier);

    await expect(detector.detect("npm ERESOLVE dependency error")).resolves.toEqual({
      intent: "technical",
      source: "heuristic",
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the intent tests and verify RED**

```bash
npm test -- src/__tests__/search-intent.test.ts
```

Expected: FAIL because `src/search/heuristics.ts` and `src/search/intent.ts` do not exist.

- [ ] **Step 3: Implement conservative heuristic matching**

Create `src/search/heuristics.ts` using match sets rather than first-match priority:

```ts
import type { SearchIntent } from "./intent.js";

type HeuristicRule = {
  intent: Exclude<SearchIntent, "general">;
  patterns: RegExp[];
};

const RULES: HeuristicRule[] = [
  {
    intent: "technical",
    patterns: [
      /\b(typeerror|referenceerror|sqlstate|stack trace|http 5\d\d|eresolve)\b/i,
      /\b(api|sdk|docs?|documentation|configuration|runtime|database|query|migration|queue|docker|kubernetes)\b.*\b(error|implement|configure|retry|debug|optimi[sz]e|best practices?)\b/i,
      /\b(npm|composer|laravel|symfony|react|vue|next\.?js|nestjs|postgres(?:ql)?|mysql|redis|kafka)\b.*\b(error|config|configuration|implementation|retry|migration|query|worker)\b/i,
    ],
  },
  {
    intent: "news",
    patterns: [
      /\b(latest|today|breaking|news|announcement|announced)\b/i,
      /\b(bugün|son dakika|haber(?:ler)?|duyuru)\b/i,
    ],
  },
  {
    intent: "shopping",
    patterns: [
      /\b(buy|price|deal|discount|purchase|cheapest|in stock)\b/i,
      /\b(satın al|fiyat|indirim|kampanya|stokta)\b/i,
    ],
  },
  {
    intent: "local",
    patterns: [
      /\b(near me|nearby|closest|in my area)\b/i,
      /\b(yakınımda|yakınımdaki|yakındaki|en yakın)\b/i,
    ],
  },
  {
    intent: "navigational",
    patterns: [
      /https?:\/\//i,
      /\b[a-z0-9-]+\.(?:com|org|net|dev|io|ai)(?:\/|\b)/i,
      /\b(official site|official website|official docs|documentation page)\b/i,
      /\b(resmi site|resmi web sitesi|dokümantasyon sayfası)\b/i,
    ],
  },
  {
    intent: "commercial",
    patterns: [
      /\b(vendor|vendors|competitor|competitors|enterprise product|company discovery|supplier)\b/i,
      /\benterprise\b.*\b(adoption|benchmark|market|platform|vendor|product)\b/i,
      /\b(tedarikçi|rakip(?:ler)?|kurumsal ürün|şirket araştırması)\b/i,
    ],
  },
  {
    intent: "research",
    patterns: [
      /\b(landscape|market share|adoption|survey|evidence|benchmark|industry analysis)\b/i,
      /\b(pazar payı|benimsenme|araştırma|anket|kanıt|sektör analizi)\b/i,
    ],
  },
];

export function detectHeuristicIntent(query: string): SearchIntent | null {
  const matches = RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(query)))
    .map((rule) => rule.intent);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}
```

`enterprise adoption benchmark` deliberately matches both `commercial` and `research`, so it returns `null` and exercises the classifier boundary. If a fixture exposes an accidental overlap, narrow the relevant regex; do not add priority ordering.

- [ ] **Step 4: Implement the 8-intent classifier adapter and detector**

Create `src/search/intent.ts`:

```ts
import { pipeline } from "@huggingface/transformers";
import { detectHeuristicIntent } from "./heuristics.js";

export type SearchIntent =
  | "technical"
  | "research"
  | "news"
  | "commercial"
  | "shopping"
  | "local"
  | "navigational"
  | "general";

export type IntentDetection = {
  intent: SearchIntent;
  source: "heuristic" | "classifier";
};

export interface IntentClassifier {
  classify(query: string): Promise<SearchIntent>;
}

const LABEL_TO_INTENT: Record<string, SearchIntent> = {
  "software development and technical documentation": "technical",
  "research comparison and evidence gathering": "research",
  "current news and recent events": "news",
  "companies vendors and competitors": "commercial",
  "shopping products prices and deals": "shopping",
  "local places and nearby services": "local",
  "official website documentation or specific page": "navigational",
  "general information": "general",
};

const LABELS = Object.keys(LABEL_TO_INTENT);

type ZeroShotRunner = (
  query: string,
  labels: string[],
) => Promise<{ labels: string[]; scores: number[] }>;

type PipelineLoader = (
  task: "zero-shot-classification",
  model: string,
) => Promise<ZeroShotRunner>;

export class SearchIntentClassifier implements IntentClassifier {
  private classifier: ZeroShotRunner | null = null;
  private classifierFailed = false;

  constructor(
    private readonly modelName = "Xenova/nli-deberta-v3-xsmall",
    private readonly loadPipeline: PipelineLoader = pipeline as unknown as PipelineLoader,
  ) {}

  async classify(query: string): Promise<SearchIntent> {
    if (this.classifierFailed) return "general";

    try {
      if (!this.classifier) {
        this.classifier = await this.loadPipeline("zero-shot-classification", this.modelName);
      }
      const output = await this.classifier(query, LABELS);
      return LABEL_TO_INTENT[output.labels[0]] ?? "general";
    } catch (error) {
      this.classifierFailed = true;
      console.error("Intent classification model permanently failed:", error);
      return "general";
    }
  }
}

export class SearchIntentDetector {
  constructor(
    private readonly classifier: IntentClassifier = new SearchIntentClassifier(),
  ) {}

  async detect(query: string): Promise<IntentDetection> {
    const heuristic = detectHeuristicIntent(query);
    if (heuristic) return { intent: heuristic, source: "heuristic" };
    return {
      intent: await this.classifier.classify(query),
      source: "classifier",
    };
  }
}
```

- [ ] **Step 5: Add classifier mapping/failure tests without a real model**

Extend `src/__tests__/search-intent.test.ts`:

```ts
import { SearchIntentClassifier } from "../search/intent.js";

it("maps descriptive zero-shot labels to domain intents", async () => {
  const loader = vi.fn(async () => async () => ({
    labels: ["companies vendors and competitors"],
    scores: [0.91],
  }));
  const classifier = new SearchIntentClassifier("test-model", loader);

  await expect(classifier.classify("enterprise CRM alternatives"))
    .resolves.toBe("commercial");
});

it("fails safely to general and does not reload after permanent load failure", async () => {
  const loader = vi.fn(async () => { throw new Error("load failed"); });
  const classifier = new SearchIntentClassifier("test-model", loader);

  await expect(classifier.classify("ambiguous query")).resolves.toBe("general");
  await expect(classifier.classify("another query")).resolves.toBe("general");
  expect(loader).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 6: Run tests and commit GREEN**

```bash
npm test -- src/__tests__/search-intent.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/search/heuristics.ts src/search/intent.ts src/__tests__/search-intent.test.ts
git commit -m "feat: add search intent detection"
```

---

### Task 2: Versioned Provider Profiles and Pure Search Planner

**Files:**
- Create: `src/search/profiles.ts`
- Create: `src/search/planner.ts`
- Create: `src/__tests__/search-planner.test.ts`

**Interfaces:**
- Consumes: `SearchIntent` from Task 1.
- Produces: `ROUTING_PROFILE_VERSION`, `SearchPlan`, `planSearch(input)`.

- [ ] **Step 1: Write failing planner tests for all profile families**

Create `src/__tests__/search-planner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planSearch } from "../search/planner.js";

const all = ["duckduckgo", "bing", "brave", "google"];

describe("search planner", () => {
  it("selects two preferred configured providers for technical", () => {
    expect(planSearch({ intent: "technical", configuredProviderNames: all }))
      .toMatchObject({
        intent: "technical",
        strategy: "aggregate",
        primaryProviderNames: ["brave", "google"],
        fallbackProviderNames: ["duckduckgo", "bing"],
        profileVersion: "v1",
      });
  });

  it("never activates an unconfigured provider", () => {
    expect(planSearch({
      intent: "technical",
      configuredProviderNames: ["duckduckgo", "bing"],
    })).toMatchObject({
      primaryProviderNames: ["bing", "duckduckgo"],
      fallbackProviderNames: [],
    });
  });

  it("keeps general fallback in configured order", () => {
    expect(planSearch({
      intent: "general",
      configuredProviderNames: ["duckduckgo", "brave", "bing"],
    })).toMatchObject({
      strategy: "fallback",
      primaryProviderNames: ["duckduckgo", "brave", "bing"],
      fallbackProviderNames: [],
    });
  });

  it("orders all configured navigational providers by navigational preference", () => {
    expect(planSearch({
      intent: "navigational",
      configuredProviderNames: ["duckduckgo", "brave", "bing"],
    })).toMatchObject({
      strategy: "fallback",
      primaryProviderNames: ["bing", "duckduckgo", "brave"],
      fallbackProviderNames: [],
    });
  });

  it.each([
    ["research", "aggregate", 3],
    ["news", "aggregate", 3],
    ["commercial", "aggregate", 3],
    ["shopping", "aggregate", 2],
    ["local", "aggregate", 2],
  ] as const)("plans %s with %s and target %i", (intent, strategy, target) => {
    const plan = planSearch({ intent, configuredProviderNames: all });
    expect(plan.strategy).toBe(strategy);
    expect(plan.primaryProviderNames).toHaveLength(target);
  });
});
```

- [ ] **Step 2: Run planner tests and verify RED**

```bash
npm test -- src/__tests__/search-planner.test.ts
```

Expected: FAIL because planner/profile modules do not exist.

- [ ] **Step 3: Implement profile policy as data**

Create `src/search/profiles.ts`:

```ts
import type { SearchIntent } from "./intent.js";

export const ROUTING_PROFILE_VERSION = "v1";

export type RoutingProfile = {
  strategy: "fallback" | "aggregate";
  preference: string[];
  primaryTarget: number | "all";
  preserveConfiguredOrder?: boolean;
};

const DEFAULT_PROVIDER_PREFERENCE = ["brave", "google", "bing", "duckduckgo"];
const GOOGLE_FIRST = ["google", "bing", "duckduckgo", "brave"];

export const ROUTING_PROFILES: Record<SearchIntent, RoutingProfile> = {
  technical: { strategy: "aggregate", preference: DEFAULT_PROVIDER_PREFERENCE, primaryTarget: 2 },
  research: { strategy: "aggregate", preference: DEFAULT_PROVIDER_PREFERENCE, primaryTarget: 3 },
  news: { strategy: "aggregate", preference: ["google", "bing", "brave", "duckduckgo"], primaryTarget: 3 },
  commercial: { strategy: "aggregate", preference: DEFAULT_PROVIDER_PREFERENCE, primaryTarget: 3 },
  shopping: { strategy: "aggregate", preference: GOOGLE_FIRST, primaryTarget: 2 },
  local: { strategy: "aggregate", preference: GOOGLE_FIRST, primaryTarget: 2 },
  navigational: { strategy: "fallback", preference: GOOGLE_FIRST, primaryTarget: "all" },
  general: { strategy: "fallback", preference: [], primaryTarget: "all", preserveConfiguredOrder: true },
};
```

- [ ] **Step 4: Implement the pure planner**

Create `src/search/planner.ts`:

```ts
import type { SearchIntent } from "./intent.js";
import { ROUTING_PROFILES, ROUTING_PROFILE_VERSION } from "./profiles.js";

export type SearchPlan = {
  intent: SearchIntent;
  strategy: "fallback" | "aggregate";
  primaryProviderNames: string[];
  fallbackProviderNames: string[];
  profileVersion: string;
};

export type PlanSearchInput = {
  intent: SearchIntent;
  configuredProviderNames: string[];
};

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

export function planSearch({
  intent,
  configuredProviderNames,
}: PlanSearchInput): SearchPlan {
  const configured = unique(configuredProviderNames);
  const profile = ROUTING_PROFILES[intent];

  const preferredConfigured = profile.preserveConfiguredOrder
    ? configured
    : [
        ...profile.preference.filter((name) => configured.includes(name)),
        ...configured.filter((name) => !profile.preference.includes(name)),
      ];

  const primary = profile.primaryTarget === "all"
    ? preferredConfigured
    : preferredConfigured.slice(0, profile.primaryTarget);

  const primarySet = new Set(primary);
  const fallback = configured.filter((name) => !primarySet.has(name));

  return {
    intent,
    strategy: profile.strategy,
    primaryProviderNames: primary,
    fallbackProviderNames: fallback,
    profileVersion: ROUTING_PROFILE_VERSION,
  };
}
```

- [ ] **Step 5: Run planner tests and commit GREEN**

```bash
npm test -- src/__tests__/search-planner.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/search/profiles.ts src/search/planner.ts src/__tests__/search-planner.test.ts
git commit -m "feat: add intent-aware search planner"
```

---

### Task 3: Planned Execution Using Existing Fallback/Aggregate Engine

**Files:**
- Modify: `src/search/executor.ts`
- Modify: `src/__tests__/federated-search.test.ts`

**Interfaces:**
- Consumes: `SearchPlan` from Task 2.
- Produces: `executeSearchPlan(options)`.
- Existing `executeProviderSearch(options)` remains the explicit-strategy API and its behavior must not change.

- [ ] **Step 1: Write RED tests for aggregate-primary success and total failure**

Extend `src/__tests__/federated-search.test.ts` to import `executeSearchPlan` and add:

```ts
it("planned aggregate returns primary results without calling secondary providers", async () => {
  const brave = provider("brave", ["https://example.com/brave"]);
  const google = provider("google", ["https://example.com/google"]);
  const bing = provider("bing", ["https://example.com/bing"]);

  const results = await executeSearchPlan({
    providers: [brave, google, bing],
    query: "postgres pooling",
    locale,
    plan: {
      intent: "technical",
      strategy: "aggregate",
      primaryProviderNames: ["brave", "google"],
      fallbackProviderNames: ["bing"],
      profileVersion: "v1",
    },
    healthTracker: new ProviderHealthTracker(),
  });

  expect(brave.execute).toHaveBeenCalledTimes(1);
  expect(google.execute).toHaveBeenCalledTimes(1);
  expect(bing.execute).not.toHaveBeenCalled();
  expect(results).toHaveLength(2);
});

it("planned aggregate falls back only when every primary provider fails", async () => {
  const brave = provider("brave", []);
  const google = provider("google", []);
  const bing = provider("bing", ["https://example.com/bing"]);

  const results = await executeSearchPlan({
    providers: [brave, google, bing],
    query: "postgres pooling",
    locale,
    plan: {
      intent: "technical",
      strategy: "aggregate",
      primaryProviderNames: ["brave", "google"],
      fallbackProviderNames: ["bing"],
      profileVersion: "v1",
    },
    healthTracker: new ProviderHealthTracker(),
  });

  expect(brave.execute).toHaveBeenCalledTimes(1);
  expect(google.execute).toHaveBeenCalledTimes(1);
  expect(bing.execute).toHaveBeenCalledTimes(1);
  expect(results.map((result) => result.url)).toEqual(["https://example.com/bing"]);
});
```

Add one planned-fallback test that passes a plan with `strategy: "fallback"`, `primaryProviderNames: ["google", "bing"]`, verifies Google empty -> Bing success, and verifies no provider after Bing is called.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- src/__tests__/federated-search.test.ts
```

Expected: FAIL because `executeSearchPlan` is not exported.

- [ ] **Step 3: Add provider selection helper and planned execution**

Modify `src/search/executor.ts` without changing `runProvider`, explicit fallback semantics, aggregate dedupe or RRF behavior:

```ts
import type { SearchPlan } from "./planner.js";

export type ExecuteSearchPlanOptions = Omit<ExecuteProviderSearchOptions, "strategy"> & {
  plan: SearchPlan;
};

function providersByNames(
  providers: SearchProvider[],
  names: string[],
): SearchProvider[] {
  const byName = new Map(uniqueProvidersByName(providers).map((provider) => [provider.name, provider]));
  return names
    .map((name) => byName.get(name))
    .filter((provider): provider is SearchProvider => Boolean(provider));
}

export async function executeSearchPlan({
  providers,
  query,
  locale,
  plan,
  healthTracker,
}: ExecuteSearchPlanOptions): Promise<SearchResultItem[]> {
  const primary = providersByNames(providers, plan.primaryProviderNames);
  const secondary = providersByNames(providers, plan.fallbackProviderNames);

  if (plan.strategy === "fallback") {
    return executeProviderSearch({
      providers: [...primary, ...secondary],
      query,
      locale,
      strategy: "fallback",
      healthTracker,
    });
  }

  const primaryResults = await executeProviderSearch({
    providers: primary,
    query,
    locale,
    strategy: "aggregate",
    healthTracker,
  });
  if (primaryResults.length > 0 || secondary.length === 0) return primaryResults;

  return executeProviderSearch({
    providers: secondary,
    query,
    locale,
    strategy: "fallback",
    healthTracker,
  });
}
```

- [ ] **Step 4: Run all federated regression tests and commit GREEN**

```bash
npm test -- src/__tests__/federated-search.test.ts src/__tests__/federated-rerank.test.ts
npm run typecheck
```

Expected: PASS, including all existing URL-normalization and explicit-strategy regressions.

```bash
git add src/search/executor.ts src/__tests__/federated-search.test.ts
git commit -m "feat: execute planned provider searches"
```

---

### Task 4: Auto Strategy Orchestration, Shared Detector and Cache Semantics

**Files:**
- Modify: `src/cache/semantic-cache.ts`
- Delete: `src/cache/intent.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/search-params.test.ts`
- Create: `src/__tests__/auto-search.test.ts`
- Modify: `src/__tests__/server-status.test.ts`

**Interfaces:**
- Consumes: `SearchIntentDetector`, `planSearch`, `executeSearchPlan`, `ROUTING_PROFILE_VERSION`.
- Public tool contract becomes `fallback | aggregate | auto`, with `fallback` still default.

- [ ] **Step 1: Change schema test from rejecting auto to accepting auto**

Modify `src/__tests__/search-params.test.ts`:

```ts
it("accepts fallback, aggregate, and auto search strategies", () => {
  for (const strategy of ["fallback", "aggregate", "auto"] as const) {
    expect(SearchSchema.parse({ query: "test", strategy }).strategy).toBe(strategy);
  }
});

it("rejects unsupported search strategies", () => {
  expect(() => SearchSchema.parse({ query: "test", strategy: "adaptive" }))
    .toThrowError(ZodError);
});
```

```bash
npm test -- src/__tests__/search-params.test.ts
```

Expected: FAIL because `auto` is not yet in the schema.

- [ ] **Step 2: Write auto orchestration RED tests**

Create `src/__tests__/auto-search.test.ts`. Use prototype spies so the production server still owns one detector instance while tests avoid loading a model:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import { SearchIntentDetector } from "../search/intent.js";
import type { SearchProvider } from "../providers/base.js";

function result(source: string, url: string) {
  return [{ title: source, url, snippet: `${source} snippet`, source }];
}

async function callPrivate<T>(target: unknown, method: string, args: unknown[] = []): Promise<T> {
  const callable = (target as Record<string, (...params: unknown[]) => Promise<T>>)[method];
  return callable.apply(target, args);
}

describe("auto search orchestration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("routes technical auto search to planned primary providers and bypasses query cache", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.spyOn(SearchIntentDetector.prototype, "detect")
      .mockResolvedValue({ intent: "technical", source: "heuristic" });

    const brave: SearchProvider = { name: "brave", execute: vi.fn(async () => result("brave", "https://example.com/brave")) };
    const google: SearchProvider = { name: "google", execute: vi.fn(async () => result("google", "https://example.com/google")) };
    const bing: SearchProvider = { name: "bing", execute: vi.fn(async () => result("bing", "https://example.com/bing")) };

    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([brave, google, bing]);
    const cache = (server as any).cache;
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "set").mockResolvedValue(undefined);
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query: string, rows: unknown[]) => rows);

    await callPrivate(server, "handleSearch", [{ query: "postgres pooling", strategy: "auto" }]);

    expect(brave.execute).toHaveBeenCalledTimes(1);
    expect(google.execute).toHaveBeenCalledTimes(1);
    expect(bing.execute).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it("classifies the original query before appending a site domain filter", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    const detect = vi.spyOn(SearchIntentDetector.prototype, "detect")
      .mockResolvedValue({ intent: "technical", source: "heuristic" });
    const brave: SearchProvider = { name: "brave", execute: vi.fn(async () => result("brave", "https://react.dev/reference")) };

    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([brave]);
    const cache = (server as any).cache;
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query: string, rows: unknown[]) => rows);

    await callPrivate(server, "handleSearch", [{
      query: "react server components documentation",
      domain: "react.dev",
      strategy: "auto",
    }]);

    expect(detect).toHaveBeenCalledWith("react server components documentation");
    expect(brave.execute).toHaveBeenCalledWith(
      "react server components documentation site:react.dev",
      expect.any(Object),
    );
  });

  it.each(["fallback", "aggregate"] as const)("explicit %s bypasses intent detection", async (strategy) => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    const detect = vi.spyOn(SearchIntentDetector.prototype, "detect");
    const provider: SearchProvider = { name: "duckduckgo", execute: vi.fn(async () => result("duckduckgo", "https://example.com")) };

    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([provider]);
    const cache = (server as any).cache;
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "set").mockResolvedValue(undefined);
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query: string, rows: unknown[]) => rows);

    await callPrivate(server, "handleSearch", [{ query: "test query", strategy }]);
    expect(detect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Refactor semantic cache to use the shared detector**

In `src/cache/semantic-cache.ts` replace the cache-local classifier import with:

```ts
import {
  SearchIntentDetector,
  type SearchIntent,
} from "../search/intent.js";
```

Replace `private intentClassifier` with `private intentDetector` and preserve existing constructor call compatibility:

```ts
constructor(
  embeddingProvider: IEmbeddingProvider,
  vectorStore: IVectorStore,
  threshold: number = 0.75,
  intentDetector: SearchIntentDetector = new SearchIntentDetector(),
) {
  this.embeddingProvider = embeddingProvider;
  this.vectorStore = vectorStore;
  this.intentDetector = intentDetector;
  this.threshold = threshold;
}
```

Change intent detection to:

```ts
async detectIntent(query: string): Promise<SearchIntent> {
  return (await this.intentDetector.detect(query)).intent;
}
```

Keep content TTL mapping intentionally narrow:

```ts
private intentToContentCategory(intent: SearchIntent): string {
  if (intent === "news") return "news";
  if (intent === "technical") return "technical";
  return "general";
}
```

Delete `src/cache/intent.ts` only after all imports have moved.

- [ ] **Step 4: Integrate `auto` into `WebSearchServer`**

Modify `src/index.ts` imports:

```ts
import { SearchIntentDetector } from "./search/intent.js";
import { planSearch } from "./search/planner.js";
import { ROUTING_PROFILE_VERSION } from "./search/profiles.js";
import {
  executeProviderSearch as executeSearch,
  executeSearchPlan,
  type SearchStrategy,
} from "./search/executor.js";
```

Keep executor `SearchStrategy` as `fallback | aggregate`; `auto` exists only in the MCP schema/orchestration branch.

Schema:

```ts
strategy: z.enum(["fallback", "aggregate", "auto"]).optional()
```

After existing env-derived fields (`enableCrosslingual`, `fetchWaitUntil`, `cacheDbPath`) have been assigned, create one detector and inject the same instance into the cache:

```ts
this.intentDetector = new SearchIntentDetector();
const embeddingProvider = new TransformersEmbeddingProvider();
const vectorStore = new SQLiteVectorStore(this.cacheDbPath);
this.cache = new SemanticCache(
  embeddingProvider,
  vectorStore,
  0.75,
  this.intentDetector,
);
```

In `handleSearch`, keep default `strategy = "fallback"` and query-cache behavior exactly:

```ts
const useSemanticSearchCache = strategy === "fallback";
```

Resolve execution:

```ts
let rawResults: SearchResultItem[];

if (strategy === "auto") {
  const detection = await this.intentDetector.detect(query);
  const plan = planSearch({
    intent: detection.intent,
    configuredProviderNames: this.providers.map((provider) => provider.name),
  });

  console.error(`Auto search intent: ${detection.intent} (${detection.source})`);
  console.error(
    `Auto search plan: ${plan.strategy} [${plan.primaryProviderNames.join(", ")}], fallback [${plan.fallbackProviderNames.join(", ")}]`,
  );

  rawResults = await executeSearchPlan({
    providers: this.providers,
    query: providerQuery,
    locale: queryLocale,
    plan,
    healthTracker: this.healthTracker,
  });
} else {
  rawResults = await this.executeProviderSearch(providerQuery, queryLocale, strategy);
}
```

Do not pass `providerQuery` into `intentDetector.detect`; only original `query` is classified.

- [ ] **Step 5: Expose tool/status routing metadata and test it**

Update MCP tool schema enum/description to include `auto` while stating default remains fallback.

Update `handleStatus()` config:

```ts
config: {
  searchProviders: this.providers.map((provider) => provider.name),
  searchStrategyDefault: "fallback",
  autoRouting: "available",
  routingProfileVersion: ROUTING_PROFILE_VERSION,
  // preserve existing fetch/cache config fields
}
```

Extend `src/__tests__/server-status.test.ts`:

```ts
expect(status.config).toMatchObject({
  searchProviders: ["mock"],
  searchStrategyDefault: "fallback",
  autoRouting: "available",
  routingProfileVersion: "v1",
  fetchWaitUntil: "domcontentloaded",
  forcePlaywright: true,
  cacheDbPath: ":memory:",
});
```

- [ ] **Step 6: Run focused integration tests and commit GREEN**

```bash
npm test -- \
  src/__tests__/search-params.test.ts \
  src/__tests__/auto-search.test.ts \
  src/__tests__/server-status.test.ts \
  src/__tests__/semantic-cache.test.ts
npm run typecheck
```

Expected: PASS, with no real intent model download in tests.

```bash
git add src/index.ts src/cache/semantic-cache.ts src/search/intent.ts \
  src/__tests__/search-params.test.ts src/__tests__/auto-search.test.ts \
  src/__tests__/server-status.test.ts
git rm src/cache/intent.ts
git commit -m "feat: add auto search orchestration"
```

---

### Task 5: P0 Turkish Locale Correctness

**Files:**
- Modify: `src/index.ts`
- Create: `src/__tests__/search-locale-routing.test.ts`
- Preserve: `src/search-utils.ts` locale API unless a failing test proves a utility change is necessary.

**Interfaces:**
- Uses existing `resolveSearchLocale(query, detectedLanguage?)`.
- Changes only how `WebSearchServer` supplies `detectedLanguage` when cross-lingual mode is disabled or detection fails.

- [ ] **Step 1: Write the server-level Turkish locale regression test**

Create `src/__tests__/search-locale-routing.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import type { SearchProvider } from "../providers/base.js";

async function callPrivate<T>(target: unknown, method: string, args: unknown[] = []): Promise<T> {
  const callable = (target as Record<string, (...params: unknown[]) => Promise<T>>)[method];
  return callable.apply(target, args);
}

describe("search locale routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses Turkish locale for Turkish query when cross-lingual detection is disabled", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CACHE_DB_PATH", ":memory:");
    vi.stubEnv("ENABLE_CROSSLINGUAL", "false");

    const execute = vi.fn(async () => [{
      title: "Queue",
      url: "https://example.com/queue",
      snippet: "Queue guide",
      source: "mock",
    }]);
    const provider: SearchProvider = { name: "mock", execute };

    const server = new WebSearchServer();
    server.overrideSearchProvidersForTesting([provider]);
    const cache = (server as any).cache;
    vi.spyOn(cache, "get").mockResolvedValue(null);
    vi.spyOn(cache, "set").mockResolvedValue(undefined);
    vi.spyOn(cache, "reRankResults").mockImplementation(async (_query: string, rows: unknown[]) => rows);

    await callPrivate(server, "handleSearch", [{
      query: "Laravel için en iyi queue yapısı",
      strategy: "fallback",
    }]);

    expect(execute).toHaveBeenCalledWith(
      "Laravel için en iyi queue yapısı",
      expect.objectContaining({ market: "tr-TR" }),
    );
  });
});
```

- [ ] **Step 2: Run the regression test and verify RED**

```bash
npm test -- src/__tests__/search-locale-routing.test.ts
```

Expected: FAIL because current `handleSearch` supplies `eng_Latn` when cross-lingual mode is disabled.

- [ ] **Step 3: Make the minimum locale fix in `src/index.ts`**

Replace the current inline locale resolution with:

```ts
const detectedLanguage = this.crossLingual
  ? await this.crossLingual.detectLanguage(query).catch(() => null)
  : null;
const queryLocale = resolveSearchLocale(query, detectedLanguage);
```

Do not change `resolveSearchLocale` precedence: a successfully detected language still wins over heuristic query locale.

- [ ] **Step 4: Run locale utility + server regressions and commit GREEN**

```bash
npm test -- \
  src/__tests__/search-locale-routing.test.ts \
  src/__tests__/search-utils.test.ts \
  src/__tests__/crosslingual.test.ts
npm run typecheck
```

Expected: PASS.

```bash
git add src/index.ts src/__tests__/search-locale-routing.test.ts
git commit -m "fix: infer locale when cross-lingual search is disabled"
```

---

### Task 6: Deterministic TR/EN Routing Evaluation Fixture

**Files:**
- Create: `evals/search-routing/queries.jsonl`
- Create: `src/__tests__/search-routing-eval.test.ts`

**Interfaces:**
- Consumes: `detectHeuristicIntent`, `planSearch`.
- This is offline/deterministic CI coverage only; it must not call network providers or load the real classifier model.

- [ ] **Step 1: Add a compact bilingual fixture covering all intents and ambiguity**

Create `evals/search-routing/queries.jsonl`:

```jsonl
{"query":"npm ERESOLVE dependency error","intent":"technical","heuristic":"technical"}
{"query":"Laravel queue worker retry configuration","intent":"technical","heuristic":"technical"}
{"query":"OpenAI latest news today","intent":"news","heuristic":"news"}
{"query":"bugün son dakika yapay zeka haberleri","intent":"news","heuristic":"news"}
{"query":"iPhone 17 price and discount","intent":"shopping","heuristic":"shopping"}
{"query":"Bosch ocak fiyat kampanya","intent":"shopping","heuristic":"shopping"}
{"query":"coffee shops near me","intent":"local","heuristic":"local"}
{"query":"yakınımdaki kahve dükkanları","intent":"local","heuristic":"local"}
{"query":"official PostgreSQL documentation page","intent":"navigational","heuristic":"navigational"}
{"query":"github.com/openai/openai","intent":"navigational","heuristic":"navigational"}
{"query":"enterprise CRM vendors and competitors","intent":"commercial","heuristic":"commercial"}
{"query":"kurumsal ERP tedarikçi ve rakipler","intent":"commercial","heuristic":"commercial"}
{"query":"cloud database market adoption survey","intent":"research","heuristic":"research"}
{"query":"veritabanı pazar payı araştırması","intent":"research","heuristic":"research"}
{"query":"how does photosynthesis work","intent":"general","heuristic":null}
{"query":"İstanbul'un tarihi","intent":"general","heuristic":null}
{"query":"PostgreSQL vs CockroachDB enterprise adoption benchmark","intent":"research","heuristic":null}
```

The last ambiguity fixture intentionally expects heuristic defer even though the human-labeled ultimate intent is `research`.

- [ ] **Step 2: Write fixture parser and deterministic acceptance tests**

Create `src/__tests__/search-routing-eval.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectHeuristicIntent } from "../search/heuristics.js";
import { planSearch } from "../search/planner.js";
import type { SearchIntent } from "../search/intent.js";

type Fixture = {
  query: string;
  intent: SearchIntent;
  heuristic: SearchIntent | null;
};

const fixtures = readFileSync("evals/search-routing/queries.jsonl", "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Fixture);

describe("search routing eval fixture", () => {
  it("covers all eight intents", () => {
    expect(new Set(fixtures.map((row) => row.intent))).toEqual(new Set([
      "technical", "research", "news", "commercial",
      "shopping", "local", "navigational", "general",
    ]));
  });

  it.each(fixtures)("heuristic expectation: $query", ({ query, heuristic }) => {
    expect(detectHeuristicIntent(query)).toBe(heuristic);
  });

  it.each(fixtures)("planner never escapes the configured allowlist: $query", ({ intent }) => {
    const configured = ["duckduckgo", "bing"];
    const plan = planSearch({ intent, configuredProviderNames: configured });
    expect([...plan.primaryProviderNames, ...plan.fallbackProviderNames]
      .every((name) => configured.includes(name))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the eval fixture test and refine only false-positive heuristics**

```bash
npm test -- src/__tests__/search-routing-eval.test.ts
```

Expected: PASS. If it fails due to overlapping heuristics, narrow the relevant regex; do not introduce a priority chain to force the expected result.

- [ ] **Step 4: Commit the deterministic eval layer**

```bash
git add evals/search-routing/queries.jsonl src/__tests__/search-routing-eval.test.ts src/search/heuristics.ts
git commit -m "test: add search routing evaluation fixtures"
```

---

### Task 7: MCP Surface, Documentation and Full Release Verification

**Files:**
- Modify: `scripts/smoke-mcp.mjs`
- Modify: `README.md`
- Modify if a review finding requires a scoped correction: files already introduced by Tasks 1–6.

**Interfaces:**
- Verifies the public contract end-to-end.
- No live network quality benchmark is added to blocking CI.

- [ ] **Step 1: Extend MCP smoke assertions for auto strategy and routing diagnostics**

After `tools/list`, find the web search tool and assert its strategy enum includes all three strategies:

```js
const webSearchTool = tools.result.tools.find((tool) => tool.name === "web_search");
const strategyEnum = webSearchTool?.inputSchema?.properties?.strategy?.enum ?? [];
for (const strategy of ["fallback", "aggregate", "auto"]) {
  assertIncludes(strategyEnum, strategy, "web_search strategy enum");
}
```

Extend `assertHasStatusShape(status)`:

```js
if (status.config.searchStrategyDefault !== "fallback") {
  fail(`server_status default search strategy changed: ${status.config.searchStrategyDefault}`);
}
if (status.config.autoRouting !== "available") {
  fail("server_status did not report auto routing availability.");
}
if (status.config.routingProfileVersion !== "v1") {
  fail(`server_status routing profile mismatch: ${status.config.routingProfileVersion}`);
}
```

Do not issue a real auto web search in smoke; provider HTML/network availability must not make CI flaky.

- [ ] **Step 2: Update README public contract**

Document:

```text
fallback  (default) — configured ordered failover, semantic query cache enabled
aggregate           — all configured providers in parallel, RRF fusion, semantic query cache bypassed
auto                — intent detector + routing profile v1 + existing executor, semantic query cache bypassed
```

Add an example:

```json
{
  "query": "PostgreSQL connection pooling best practices",
  "strategy": "auto",
  "max_results": 5
}
```

Document these invariants:

- `SEARCH_PROVIDERS` is an allowlist, not merely a preference list.
- auto never calls a provider omitted from `SEARCH_PROVIDERS`.
- auto is not the default.
- aggregate auto profiles use secondary fallback only after total primary failure.
- initial provider preferences are hypotheses to be tuned by later eval data.
- current profile version is `v1`.

Include the initial profile table from the design spec.

- [ ] **Step 3: Run the complete test suite**

```bash
npm test
```

Expected: every existing and new Vitest test passes. No test may depend on a live search provider or a real model download.

- [ ] **Step 4: Run the full release verification chain**

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run smoke:mcp
npm audit --audit-level=moderate
npm pack --dry-run --json
```

Expected:

- `npm ci` succeeds on Node >=20.9.0.
- build succeeds.
- typecheck succeeds.
- all tests pass.
- MCP smoke passes and reports `auto` in the schema.
- dependency audit reports 0 moderate-or-higher vulnerabilities.
- npm package dry-run succeeds.

- [ ] **Step 5: Review diff for scope and backward compatibility**

Review against `main` and confirm:

```text
- default strategy still fallback
- explicit fallback path unchanged except locale correctness fix
- explicit aggregate still queries all configured providers
- auto query cache read/write disabled
- domain rewrite happens after intent detection
- planner only receives registered/configured provider names
- no new provider adapter/API dependency
- no temporary workflow or generated cache/model artifact
- src/cache/intent.ts removed and no stale imports remain
- routing profile version reported as v1
```

Use:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git grep -n "cache/intent" -- src || true
git grep -n 'strategy.*auto' -- src README.md scripts
```

- [ ] **Step 6: Commit docs/smoke and request final review**

```bash
git add README.md scripts/smoke-mcp.mjs
git commit -m "docs: document intent-aware search routing"
```

Open/update the implementation PR with:

```text
- design/spec link
- routing profile version
- TDD checkpoint summary
- explicit statement that auto remains opt-in
- locale P0 fix
- final test count
- build/typecheck/smoke/audit/package results
- any temporary provider overrides already inherited from main, without changing them in this feature
```

Request final review focused on:

```text
1. accidental behavior changes to explicit fallback/aggregate
2. heuristic false-positive risk and ambiguity handling
3. configured-provider allowlist enforcement
4. aggregate total-failure fallback semantics
5. auto query-cache contamination risk
6. locale regression correctness
7. log/token/noise footprint
```

Do not merge with unresolved review threads or a non-green latest-head CI.

---

## Plan Self-Review Result

### Spec coverage

- Public `auto` contract: Task 4 and Task 7.
- 8-intent taxonomy: Task 1.
- Conservative heuristic + classifier fallback: Task 1 and Task 6.
- Shared model instance: Task 4 via one server-owned `SearchIntentDetector` injected into `SemanticCache`.
- Policy-as-data profiles: Task 2.
- Configured-provider allowlist: Task 2 + Task 6.
- Planned aggregate total-failure fallback: Task 3.
- Explicit strategy compatibility: Task 3 + Task 4 + Task 7 review checklist.
- Auto query-cache bypass: Task 4.
- Domain filter isolation: Task 4 integration test.
- Turkish locale P0: Task 5.
- Status diagnostics: Task 4 + Task 7 smoke.
- TR/EN deterministic fixtures: Task 6.
- Blocking audit/full release verification: Task 7.
- v1.3 non-goals remain excluded.

### Placeholder scan

No `TBD`, `TODO`, generic “handle errors”, or undefined follow-up steps remain. Each implementation task includes concrete interfaces, failing tests, minimal implementation shape, verification commands and commit boundary.

### Type consistency

- `SearchIntent` is defined only in `src/search/intent.ts` after migration.
- `SearchPlan` is defined only in `src/search/planner.ts`.
- Existing executor `SearchStrategy` remains `fallback | aggregate`; public `auto` is handled at orchestration level.
- `SearchIntentDetector.detect()` consistently returns `{ intent, source }`.
- `ROUTING_PROFILE_VERSION` is consistently `v1`.
