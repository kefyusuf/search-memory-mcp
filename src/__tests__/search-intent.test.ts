import { describe, expect, it, vi } from "vitest";
import { detectHeuristicIntent } from "../search/heuristics.js";
import { SearchIntentClassifier, SearchIntentDetector, type IntentClassifier } from "../search/intent.js";

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
    expect(detectHeuristicIntent("enterprise vendors market adoption benchmark")).toBeNull();
  });

  it("uses the classifier only when heuristics defer", async () => {
    const classifier: IntentClassifier = {
      classify: vi.fn(async (_query: string) => "research" as const),
    };
    const detector = new SearchIntentDetector(classifier);

    await expect(detector.detect("database platform options")).resolves.toEqual({
      intent: "research",
      source: "classifier",
    });
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the classifier for a high-confidence heuristic", async () => {
    const classifier: IntentClassifier = {
      classify: vi.fn(async (_query: string) => "general" as const),
    };
    const detector = new SearchIntentDetector(classifier);

    await expect(detector.detect("npm ERESOLVE dependency error")).resolves.toEqual({
      intent: "technical",
      source: "heuristic",
    });
    expect(classifier.classify).not.toHaveBeenCalled();
  });

  it("maps descriptive zero-shot labels to domain intents", async () => {
    const loader = vi.fn(async () => async () => ({
      labels: ["companies vendors and competitors"],
      scores: [0.91],
    }));
    const classifier = new SearchIntentClassifier("test-model", loader);

    await expect(classifier.classify("enterprise CRM alternatives")).resolves.toBe("commercial");
  });

  it("fails safely to general and does not reload after permanent load failure", async () => {
    const loader = vi.fn(async () => {
      throw new Error("load failed");
    });
    const classifier = new SearchIntentClassifier("test-model", loader);

    await expect(classifier.classify("ambiguous query")).resolves.toBe("general");
    await expect(classifier.classify("another query")).resolves.toBe("general");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("retries classification after a transient inference failure", async () => {
    const runner = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient inference failure"))
      .mockResolvedValueOnce({
        labels: ["research comparison and evidence gathering"],
        scores: [0.88],
      });
    const loader = vi.fn(async () => runner);
    const classifier = new SearchIntentClassifier("test-model", loader);

    await expect(classifier.classify("first ambiguous query")).resolves.toBe("general");
    await expect(classifier.classify("second ambiguous query")).resolves.toBe("research");
    expect(loader).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight model load across concurrent classifications", async () => {
    const runner = vi.fn(async () => ({
      labels: ["research comparison and evidence gathering"],
      scores: [0.9],
    }));
    let resolveLoad!: (value: typeof runner) => void;
    const pendingLoad = new Promise<typeof runner>((resolve) => {
      resolveLoad = resolve;
    });
    const loader = vi.fn(() => pendingLoad);
    const classifier = new SearchIntentClassifier("test-model", loader);

    const first = classifier.classify("database platform options");
    const second = classifier.classify("storage platform options");
    await Promise.resolve();

    expect(loader).toHaveBeenCalledTimes(1);
    resolveLoad(runner);
    await expect(Promise.all([first, second])).resolves.toEqual(["research", "research"]);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
