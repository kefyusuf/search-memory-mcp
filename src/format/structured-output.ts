import type { SearchResultItem } from "../cache/types.js";
import type { KnowledgeChunkHit } from "../knowledge/index-store.js";

export type OutputFormat = "text" | "json";

export type SearchJsonPayload = {
  query: string;
  resultCount: number;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
    publishedAt?: string;
    semanticScore?: number;
    fusionScore?: number;
  }>;
  meta: Record<string, string | number | boolean>;
};

export type IndexHitJsonPayload = {
  query: string;
  hitCount: number;
  hits: Array<{
    title: string;
    source: string;
    text: string;
    chunkIndex: number;
    score: number;
    matchedBy: string;
  }>;
};

export type AnswerJsonPayload = {
  query: string;
  answer: string;
  sources: Array<{ index: number; url: string; title?: string }>;
};

export function buildSearchJson(
  query: string,
  results: SearchResultItem[],
  meta?: Record<string, string | number | boolean | undefined>,
): SearchJsonPayload {
  const cleanMeta: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value !== undefined) cleanMeta[key] = value;
  }

  return {
    query,
    resultCount: results.length,
    results: results.map((result) => {
      const entry: SearchJsonPayload["results"][number] = {
        title: result.title,
        url: result.url,
        snippet: result.snippet,
        source: result.source,
      };
      if (result.publishedAt !== undefined) entry.publishedAt = result.publishedAt;
      if (result.semanticScore !== undefined) entry.semanticScore = result.semanticScore;
      if (result.fusionScore !== undefined) entry.fusionScore = result.fusionScore;
      return entry;
    }),
    meta: cleanMeta,
  };
}

export function buildIndexHitJson(query: string, hits: KnowledgeChunkHit[]): IndexHitJsonPayload {
  return {
    query,
    hitCount: hits.length,
    hits: hits.map((hit) => ({
      title: hit.title,
      source: hit.source,
      text: hit.text,
      chunkIndex: hit.chunkIndex,
      score: hit.score,
      matchedBy: hit.matchedBy,
    })),
  };
}

export function buildAnswerJson(
  query: string,
  answer: string,
  sources: Array<{ url: string; title?: string }>,
): AnswerJsonPayload {
  return {
    query,
    answer,
    sources: sources.map((source, index) => ({
      index: index + 1,
      url: source.url,
      ...(source.title ? { title: source.title } : {}),
    })),
  };
}

export function formatToolResult(payload: unknown, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(payload, null, 2);
  }
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}
