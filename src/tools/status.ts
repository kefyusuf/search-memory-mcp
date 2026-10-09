import type { SearchProvider } from "../providers/base.js";
import type { ProviderHealthTracker } from "../providers/health.js";
import { ROUTING_PROFILE_VERSION } from "../search/profiles.js";
import type { SearchTraceHistory } from "./search.js";
import { textResult, type ToolResult } from "./types.js";

export type StatusToolDeps = {
  providers: () => SearchProvider[];
  healthTracker: () => ProviderHealthTracker;
  cacheStats: () => unknown;
  knowledgeStats: () => unknown;
  memoryStats: () => unknown;
  graphStats: () => unknown;
  traces: SearchTraceHistory;
  browserRunning: () => boolean;
  crosslingualEnabled: boolean;
  rerankerEnabled: boolean;
  fetchWaitUntil: string;
  cacheDbPath: string;
  startedAt: number;
};

export function createStatusHandler(deps: StatusToolDeps) {
  return async (): Promise<ToolResult> => {
    const providers = deps.providers();
    const healthTracker = deps.healthTracker();
    const status = {
      providers: providers.map((provider) => ({
        name: provider.name,
        ...healthTracker.getSnapshot(provider.name),
      })),
      cache: deps.cacheStats(),
      knowledgeIndex: deps.knowledgeStats(),
      memory: deps.memoryStats(),
      entityGraph: deps.graphStats(),
      recentSearches: deps.traces.recent(10),
      browser: deps.browserRunning() ? "running" : "idle",
      crosslingual: deps.crosslingualEnabled ? "enabled" : "disabled",
      config: {
        searchProviders: providers.map((provider) => provider.name),
        searchStrategyDefault: "fallback",
        autoRouting: "available",
        routingProfileVersion: ROUTING_PROFILE_VERSION,
        fetchWaitUntil: deps.fetchWaitUntil,
        forcePlaywright: process.env.FORCE_PLAYWRIGHT === "true" || process.env.FORCE_PLAYWRIGHT === "1",
        cacheDbPath: deps.cacheDbPath,
        reranker: deps.rerankerEnabled ? "enabled" : "disabled",
      },
      uptime_seconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    };
    return textResult(JSON.stringify(status, null, 2));
  };
}
