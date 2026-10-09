import type { SearchIntent } from "./intent.js";

export const ROUTING_PROFILE_VERSION = "v2";

export type RoutingExecutionStrategy = "fallback" | "aggregate";

export type RoutingProfile = {
  strategy: RoutingExecutionStrategy;
  preference: string[];
  primaryTarget: number | "all";
  preserveConfiguredOrder?: boolean;
};

// v2 orders providers by measured reliability (npm run benchmark:providers, October 2026):
// self-hosted SearXNG and the Brave Search API answer reliably, DuckDuckGo is the only
// scraper that consistently answers, and Bing and Google mostly block scrapers.
const DEPTH_FIRST = ["searxng", "brave", "duckduckgo", "bing", "google"];
const BREADTH_FIRST = ["searxng", "duckduckgo", "brave", "bing", "google"];

export const ROUTING_PROFILES: Record<SearchIntent, RoutingProfile> = {
  technical: {
    strategy: "aggregate",
    preference: DEPTH_FIRST,
    primaryTarget: 2,
  },
  research: {
    strategy: "aggregate",
    preference: DEPTH_FIRST,
    primaryTarget: 3,
  },
  news: {
    strategy: "aggregate",
    preference: BREADTH_FIRST,
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
