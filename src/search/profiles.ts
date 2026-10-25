import type { SearchIntent } from "./intent.js";

export const ROUTING_PROFILE_VERSION = "v3";

export type RoutingExecutionStrategy = "fallback" | "aggregate";

export type RoutingProfile = {
  strategy: RoutingExecutionStrategy;
  preference: string[];
  primaryTarget: number | "all";
  preserveConfiguredOrder?: boolean;
};

// Reliability ordering measured in October 2026 (npm run benchmark:providers):
// self-hosted SearXNG and the Brave Search API answer reliably, DuckDuckGo is
// the only scraper that consistently answers, and Bing and Google mostly block
// scrapers.
const DEPTH_FIRST = ["searxng", "brave", "duckduckgo", "bing", "google"];
const BREADTH_FIRST = ["searxng", "duckduckgo", "brave", "bing", "google"];

// v3 places the opt-in official APIs where their capability is measured
// (evals/providers/ 2026-10-25/26 three-day matrix: 449/450 attempts, plus
// capability spot checks): Tavily's news topic with provider-reported publish
// dates leads news, and Exa's neural retrieval leads research. The planner
// intersects preferences with SEARCH_PROVIDERS, so keyless configurations
// resolve exactly as in v2.
const NEWS_FIRST = ["tavily", "duckduckgo", "searxng", "brave", "bing", "google"];
const RESEARCH_FIRST = ["exa", "tavily", "searxng", "duckduckgo", "brave", "bing", "google"];

export const ROUTING_PROFILES: Record<SearchIntent, RoutingProfile> = {
  technical: {
    strategy: "aggregate",
    preference: DEPTH_FIRST,
    primaryTarget: 2,
  },
  research: {
    strategy: "aggregate",
    preference: RESEARCH_FIRST,
    primaryTarget: 3,
  },
  news: {
    strategy: "aggregate",
    preference: NEWS_FIRST,
    primaryTarget: 3,
  },
  commercial: {
    strategy: "aggregate",
    preference: DEPTH_FIRST,
    primaryTarget: 3,
  },
  shopping: {
    strategy: "aggregate",
    preference: BREADTH_FIRST,
    primaryTarget: 2,
  },
  local: {
    strategy: "aggregate",
    preference: BREADTH_FIRST,
    primaryTarget: 2,
  },
  navigational: {
    strategy: "fallback",
    preference: BREADTH_FIRST,
    primaryTarget: "all",
  },
  general: {
    strategy: "fallback",
    preference: [],
    primaryTarget: "all",
    preserveConfiguredOrder: true,
  },
};
