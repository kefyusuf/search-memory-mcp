import { describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "../providers/base.js";
import type { ProviderAttempt } from "../search/executor.js";
import {
  formatProviderBenchmarkReport,
  runProviderBenchmark,
  summarizeProviderBenchmark,
} from "../eval/provider-benchmark.js";

const attempt = (provider: string, status: ProviderAttempt["status"], durationMs: number, error?: string): ProviderAttempt =>
  ({ provider, status, resultCount: status === "ok" ? 3 : 0, durationMs, ...(error ? { error } : {}) });

describe("provider benchmark summary", () => {
  it("computes success rate, latency percentiles and top errors per provider", () => {
    const summary = summarizeProviderBenchmark([
      attempt("bing", "ok", 100),
      attempt("bing", "ok", 200),
      attempt("bing", "empty", 300),
      attempt("bing", "error", 400, "HTTP 429"),
      attempt("bing", "error", 500, "HTTP 429"),
      attempt("bing", "error", 600, "timeout"),
      attempt("duckduckgo", "ok", 50),
    ]);
    expect(summary).toEqual([
      {
        provider: "bing", attempts: 6, ok: 2, empty: 1, error: 3, backoff: 0,
        successRate: 2 / 6, p50Ms: 300, p95Ms: 600, avgResults: 1,
        topErrors: [{ error: "HTTP 429", count: 2 }, { error: "timeout", count: 1 }],
      },
      {
        provider: "duckduckgo", attempts: 1, ok: 1, empty: 0, error: 0, backoff: 0,
        successRate: 1, p50Ms: 50, p95Ms: 50, avgResults: 3, topErrors: [],
      },
    ]);
  });
});

describe("provider benchmark runner", () => {
  it("runs every query against each provider separately and paces requests", async () => {
    const calls: string[] = [];
    const provider = (name: string, fail = false): SearchProvider => ({
      name,
      execute: async (query) => {
        calls.push(`${name}:${query}`);
        if (fail) throw new Error("blocked");
        return [{ title: "t", url: `https://${name}.example/${query}`, snippet: "s", source: name }];
      },
    });
    const sleep = vi.fn(async () => {});
    const attempts = await runProviderBenchmark({
      providers: [provider("bing", true), provider("duckduckgo")],
      queries: [{ query: "a" }, { query: "b", locale: "tr" }],
      delayMs: 250,
      sleep,
    });
    expect(calls).toEqual(["bing:a", "duckduckgo:a", "bing:b", "duckduckgo:b"]);
    expect(attempts.map(({ provider, status }) => `${provider}:${status}`))
      .toEqual(["bing:error", "duckduckgo:ok", "bing:error", "duckduckgo:ok"]);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});

describe("provider benchmark attempt hook", () => {
  it("reports each attempt with the query that produced it", async () => {
    const seen: string[] = [];
    await runProviderBenchmark({
      providers: [{ name: "bing", execute: async () => [] }],
      queries: [{ query: "a" }, { query: "b" }],
      delayMs: 0,
      onAttempt: (attempt, query) => seen.push(`${attempt.provider}:${attempt.status}:${query}`),
    });
    expect(seen).toEqual(["bing:empty:a", "bing:empty:b"]);
  });
});

describe("provider benchmark report", () => {
  it("renders a Markdown table with the measured counts", () => {
    const report = formatProviderBenchmarkReport(
      summarizeProviderBenchmark([attempt("bing", "ok", 120), attempt("bing", "error", 80, "HTTP 403")]),
      { queries: 1, date: "2026-10-09" },
    );
    expect(report).toContain("| Provider | Attempts | OK | Empty | Error | Success | p50 ms | p95 ms | Top errors |");
    expect(report).toContain("| bing | 2 | 1 | 0 | 1 | 50% | 80 | 120 | HTTP 403 (1) |");
    expect(report).toContain("2026-10-09");
  });
});
