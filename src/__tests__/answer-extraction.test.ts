import { describe, expect, it } from "vitest";
import {
  extractAnswerFromContent,
  extractAnswerFromDocuments,
  formatSearchResults,
  type AnswerSource,
} from "../answer-extraction.js";

describe("formatSearchResults", () => {
  it("uses cautious snippet language for version hints", () => {
    const text = formatSearchResults("node latest", [
      {
        title: "Node.js 20.11.1 release",
        url: "https://example.com/node",
        snippet: "Current release details",
        source: "test",
      },
    ]);

    expect(text).toContain("Version hint from search snippets:");
    expect(text).not.toContain("Answer: The latest version found");
  });

  it("adds a freshness hint for old dated snippets", () => {
    const text = formatSearchResults("old docs", [
      {
        title: "Old API Guide",
        url: "https://example.com/old",
        snippet: "Last updated 2019-01-01 with legacy API details.",
        source: "test",
      },
    ]);

    expect(text).toContain("Freshness: possibly stale (2019-01-01).");
  });

  it("uses a provider-reported publishedAt even when the snippet carries no date", () => {
    const text = formatSearchResults("old docs", [
      {
        title: "Legacy Reference",
        url: "https://example.com/legacy",
        snippet: "Complete reference without any date signal.",
        source: "test",
        publishedAt: "2019-01-01",
      },
    ]);

    expect(text).toContain("Freshness: possibly stale (2019-01-01).");
  });

  it("prefers a recent publishedAt over a stale date inside the snippet", () => {
    const text = formatSearchResults("fresh docs", [
      {
        title: "Current Guide",
        url: "https://example.com/current",
        snippet: "Supersedes the 2019-01-01 edition.",
        source: "test",
        publishedAt: "2026-09-15",
      },
    ]);

    expect(text).not.toContain("Freshness:");
  });
});

describe("extractAnswerFromDocuments", () => {
  const sources: AnswerSource[] = [
    {
      title: "Postgres pooling guide",
      url: "https://example.com/pg-pool",
      content:
        "PostgreSQL connection pooling reduces connection churn and improves throughput under load.\n\n" +
        "PgBouncer is a lightweight connection pooler that sits in front of PostgreSQL and multiplexes client connections.\n\n" +
        "Unrelated sentence about gardening tools and watering cans in the summer heat.",
    },
    {
      title: "Pool sizing notes",
      url: "https://example.com/pool-size",
      content:
        "The optimal pool size for PostgreSQL is often estimated as cores times two plus effective spindle count.\n\n" +
        "Oversizing the pool can increase context switching and reduce throughput.",
    },
  ];

  it("extracts a term-scoring answer with per-source citations", () => {
    const answer = extractAnswerFromDocuments("PostgreSQL connection pooling", sources);

    expect(answer).toContain("Answer:");
    expect(answer).toContain("[Source 1]");
    expect(answer).toContain("Sources:");
    expect(answer).toContain("https://example.com/pg-pool");
    expect(answer).toContain("https://example.com/pool-size");
    // Gardening noise should not dominate.
    expect(answer.toLowerCase()).not.toContain("watering cans");
  });

  it("prefers sentences that share question terms", () => {
    const answer = extractAnswerFromDocuments("PgBouncer connection pooler", sources);
    expect(answer).toContain("PgBouncer");
    expect(answer).toContain("[Source 1]");
  });

  it("keeps the version strategy with a source citation", () => {
    const versionSources: AnswerSource[] = [
      {
        title: "Release notes",
        url: "https://example.com/releases",
        content: "Node.js 22.4.1 is the latest LTS release published this month.",
      },
    ];

    const answer = extractAnswerFromDocuments("latest Node.js version", versionSources);
    expect(answer).toContain("Node.js 22.4.1");
    expect(answer).toContain("[Source 1]");
    expect(answer).toContain("https://example.com/releases");
  });

  it("returns a no-answer message when there are no sources", () => {
    const answer = extractAnswerFromDocuments("anything", []);
    expect(answer).toContain("Could not extract");
    expect(answer).toContain("Sources: (none)");
  });
});

describe("extractAnswerFromContent back-compat", () => {
  it("maps combined content chunks to source URLs", () => {
    const combined =
      "PostgreSQL pooling improves efficiency under concurrent load.\n\n---\n\n" +
      "Pool size should be tuned to workload and hardware.";

    const answer = extractAnswerFromContent(
      "PostgreSQL pooling",
      combined,
      ["https://example.com/a", "https://example.com/b"],
    );

    expect(answer).toContain("Answer:");
    expect(answer).toContain("https://example.com/a");
    expect(answer).toContain("https://example.com/b");
  });
});
