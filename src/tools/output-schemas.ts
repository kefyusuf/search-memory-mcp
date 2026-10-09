// JSON Schemas for tools that return structuredContent. Payload builders live in
// format/structured-output.ts and tools/status.ts; keep both in sync.

const searchResult = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
    snippet: { type: "string" },
    source: { type: "string" },
    semanticScore: { type: "number" },
    fusionScore: { type: "number" },
  },
  required: ["title", "url", "snippet", "source"],
};

/** Ranked results, or a deep-search answer with its sources. */
export const WEB_SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    resultCount: { type: "number" },
    results: { type: "array", items: searchResult },
    meta: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
    answer: { type: "string" },
    providerAttempts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          provider: { type: "string" },
          status: { type: "string", enum: ["ok", "empty", "error", "backoff"] },
          resultCount: { type: "number" },
          durationMs: { type: "number" },
          error: { type: "string" },
        },
        required: ["provider", "status", "resultCount", "durationMs"],
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "number" }, url: { type: "string" }, title: { type: "string" } },
        required: ["index", "url"],
      },
    },
  },
  required: ["query"],
};

export const SEARCH_INDEX_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string" },
    hitCount: { type: "number" },
    hits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          source: { type: "string" },
          text: { type: "string" },
          chunkIndex: { type: "number" },
          score: { type: "number" },
          matchedBy: { type: "string" },
        },
        required: ["title", "source", "text", "chunkIndex", "score", "matchedBy"],
      },
    },
  },
  required: ["query", "hitCount", "hits"],
};

export const SERVER_STATUS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    providers: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    cache: { type: "object" },
    knowledgeIndex: { type: "object" },
    memory: { type: "object" },
    entityGraph: { type: "object" },
    recentSearches: { type: "array", items: { type: "object" } },
    browser: { type: "string", enum: ["running", "idle"] },
    crosslingual: { type: "string", enum: ["enabled", "disabled"] },
    config: { type: "object" },
    uptime_seconds: { type: "number" },
  },
  required: ["providers", "config", "uptime_seconds"],
};
