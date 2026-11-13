import type { SearchIntent } from "./intent.js";
import { ROUTING_PROFILES, ROUTING_PROFILE_VERSION, type RoutingExecutionStrategy } from "./profiles.js";

export interface SearchPlan {
  intent: SearchIntent;
  strategy: RoutingExecutionStrategy;
  primaryProviderNames: string[];
  fallbackProviderNames: string[];
  profileVersion: string;
}

export interface PlanSearchInput {
  intent: SearchIntent;
  configuredProviderNames: string[];
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

export function planSearch({ intent, configuredProviderNames }: PlanSearchInput): SearchPlan {
  const configured = uniqueNames(configuredProviderNames);
  const profile = ROUTING_PROFILES[intent];

  if (profile.preserveConfiguredOrder) {
    return {
      intent,
      strategy: profile.strategy,
      primaryProviderNames: configured,
      fallbackProviderNames: [],
      profileVersion: ROUTING_PROFILE_VERSION,
    };
  }

  const configuredSet = new Set(configured);
  const preferred = profile.preference.filter((name) => configuredSet.has(name));
  const unprofiled = configured.filter((name) => !profile.preference.includes(name));
  const orderedCandidates = [...preferred, ...unprofiled];
  const primaryProviderNames =
    profile.primaryTarget === "all" ? orderedCandidates : orderedCandidates.slice(0, profile.primaryTarget);
  const selected = new Set(primaryProviderNames);
  const fallbackProviderNames =
    profile.strategy === "aggregate" ? configured.filter((name) => !selected.has(name)) : [];

  return {
    intent,
    strategy: profile.strategy,
    primaryProviderNames,
    fallbackProviderNames,
    profileVersion: ROUTING_PROFILE_VERSION,
  };
}
