import { describe, expect, it } from "vitest";
import { planSearch } from "../search/planner.js";

const all = ["duckduckgo", "bing", "brave", "google"];

describe("search planner", () => {
  it.each([
    ["technical", "aggregate", ["brave", "duckduckgo"], ["bing", "google"]],
    ["research", "aggregate", ["brave", "duckduckgo", "bing"], ["google"]],
    ["news", "aggregate", ["duckduckgo", "brave", "bing"], ["google"]],
    ["commercial", "aggregate", ["brave", "duckduckgo", "bing"], ["google"]],
    ["shopping", "aggregate", ["duckduckgo", "brave"], ["bing", "google"]],
    ["local", "aggregate", ["duckduckgo", "brave"], ["bing", "google"]],
  ] as const)("plans %s intent", (intent, strategy, primary, fallback) => {
    expect(planSearch({ intent, configuredProviderNames: all })).toEqual({
      intent,
      strategy,
      primaryProviderNames: primary,
      fallbackProviderNames: fallback,
      profileVersion: "v2",
    });
  });

  it("orders navigational fallback by profile preference", () => {
    expect(planSearch({
      intent: "navigational",
      configuredProviderNames: all,
    })).toEqual({
      intent: "navigational",
      strategy: "fallback",
      primaryProviderNames: ["duckduckgo", "brave", "bing", "google"],
      fallbackProviderNames: [],
      profileVersion: "v2",
    });
  });

  it("preserves configured order for general fallback", () => {
    expect(planSearch({
      intent: "general",
      configuredProviderNames: ["bing", "duckduckgo", "google"],
    })).toEqual({
      intent: "general",
      strategy: "fallback",
      primaryProviderNames: ["bing", "duckduckgo", "google"],
      fallbackProviderNames: [],
      profileVersion: "v2",
    });
  });

  it("intersects preferences with the configured-provider allowlist", () => {
    expect(planSearch({
      intent: "technical",
      configuredProviderNames: ["duckduckgo", "bing"],
    })).toEqual({
      intent: "technical",
      strategy: "aggregate",
      primaryProviderNames: ["duckduckgo", "bing"],
      fallbackProviderNames: [],
      profileVersion: "v2",
    });
  });

  it("deduplicates configured provider names deterministically", () => {
    expect(planSearch({
      intent: "technical",
      configuredProviderNames: ["bing", "bing", "duckduckgo"],
    }).primaryProviderNames).toEqual(["duckduckgo", "bing"]);
  });
});
