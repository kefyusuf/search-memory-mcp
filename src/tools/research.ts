import { z } from "zod";
import { extractAnswerFromDocuments } from "../answer-extraction.js";
import type { EntityGraph } from "../graph/entity-graph.js";
import type { KnowledgeIndex } from "../knowledge/index-store.js";
import type { TokenBucket } from "../rate-limiter.js";
import type { ContentLoader } from "./fetch.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { errorResult, textResult, type ToolResult } from "./types.js";

const ResearchSchema = z.object({
  query: z.string().min(1).refine((query) => query.trim().length > 0, "Query must not be blank").describe("Question or topic to research."),
  max_sources: z.number().int().min(1).max(5).optional().describe("Web pages to read (1-5, default 3)."),
  index: z.boolean().optional().describe("Add the pages read to the knowledge base (default true)."),
  domain: z.string().min(1).optional().describe("Optional domain filter for the web search."),
  from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive lower date bound (YYYY-MM-DD)."),
  to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Optional inclusive upper date bound (YYYY-MM-DD)."),
});

const LOCAL_HIT_LIMIT = 3;

export type ResearchSourceStatus = "indexed" | "already_indexed" | "not_indexed" | "fetch_failed" | "rate_limited";

export type ResearchSource = {
  origin: "web" | "local";
  url: string;
  title: string;
  status: ResearchSourceStatus;
  /** Publication date (YYYY-MM-DD) found in the page, when present. */
  publishedAt?: string;
  /** When the web page was fetched, or when the local document was indexed (ISO 8601). */
  fetchedAt?: string;
};

export type ResearchToolDeps = {
  /** The web_search handler; research asks it for JSON results. */
  search: (args: unknown) => Promise<ToolResult>;
  fetchContent: ContentLoader;
  fetchLimiter: TokenBucket;
  knowledgeIndex: KnowledgeIndex;
  entityGraph: EntityGraph;
  embed: (text: string) => Promise<number[]>;
};

type WebResult = { title: string; url: string };

const STATUS_LABELS: Record<ResearchSourceStatus, string> = {
  indexed: "added to knowledge base",
  already_indexed: "already in knowledge base",
  not_indexed: "not indexed",
  fetch_failed: "could not be read",
  rate_limited: "skipped (fetch rate limit)",
};

/** Status plus the dates that tell the reader how current a source is. */
function describeSource(source: ResearchSource): string {
  const parts = [STATUS_LABELS[source.status]];
  if (source.publishedAt) parts.push(`published ${source.publishedAt}`);
  if (source.fetchedAt) parts.push(`${source.origin === "local" ? "indexed" : "fetched"} ${source.fetchedAt.slice(0, 10)}`);
  return parts.join("; ");
}

/**
 * One call that checks the local knowledge base, searches the web, reads the
 * top pages, answers with citations from both, and keeps what it read.
 */
export function createResearchHandler(deps: ResearchToolDeps) {
  const { search, fetchContent, fetchLimiter, knowledgeIndex, entityGraph, embed } = deps;

  return async (args: unknown): Promise<ToolResult> => {
    const { query, max_sources = 3, index = true, domain, from_date, to_date } = ResearchSchema.parse(args);

    const localHits = await knowledgeIndex.search(query, LOCAL_HIT_LIMIT, { embed });
    const searchResult = await search({ query, max_results: Math.min(10, max_sources + 2), domain, from_date, to_date, format: "json" });
    const webResults = searchResult.isError
      ? []
      : ((searchResult.structuredContent?.results as WebResult[] | undefined) ?? []).slice(0, max_sources);
    const searchNote = searchResult.isError ? searchResult.content[0]?.text : undefined;

    if (webResults.length === 0 && localHits.length === 0) {
      return errorResult(searchNote ?? `No web results or local knowledge found for "${query}".`);
    }

    const sources: ResearchSource[] = [];
    const documents: Array<{ title: string; url: string; content: string }> = [];
    let indexedCount = 0;

    for (const result of webResults) {
      if (!fetchLimiter.tryConsume().allowed) {
        sources.push({ origin: "web", url: result.url, title: result.title, status: "rate_limited" });
        continue;
      }
      const page = await fetchContent(result.url, false);
      if (page.kind === "error") {
        sources.push({ origin: "web", url: result.url, title: result.title, status: "fetch_failed" });
        continue;
      }
      documents.push({ title: result.title, url: result.url, content: page.text });
      const dates = { ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}), fetchedAt: page.fetchedAt };

      let status: ResearchSourceStatus = "not_indexed";
      if (knowledgeIndex.findDocBySource(result.url)) {
        status = "already_indexed";
      } else if (index) {
        const doc = knowledgeIndex.ingest({ content: page.text, title: result.title, source: result.url, category: "research" });
        entityGraph.indexDocument({ docId: doc.id, source: doc.source, title: doc.title, content: doc.content });
        status = "indexed";
        indexedCount += 1;
      }
      sources.push({ origin: "web", url: result.url, title: result.title, status, ...dates });
    }

    const webUrls = new Set(webResults.map((result) => result.url));
    for (const hit of localHits) {
      if (webUrls.has(hit.source) || sources.some((source) => source.origin === "local" && source.url === hit.source)) continue;
      documents.push({ title: hit.title, url: hit.source, content: hit.text });
      const indexedAt = knowledgeIndex.getDoc(hit.docId)?.timestamp;
      sources.push({
        origin: "local", url: hit.source, title: hit.title, status: "already_indexed",
        ...(indexedAt ? { fetchedAt: new Date(indexedAt).toISOString() } : {}),
      });
    }

    const answer = extractAnswerFromDocuments(query, documents);
    const lines = sources.map((source, position) =>
      `${position + 1}. [${source.origin}] ${source.title} — ${source.url} (${describeSource(source)})`);
    const text = [
      wrapUntrusted(answer),
      "",
      "Research sources:",
      ...lines,
      ...(searchNote ? ["", `Web search note: ${searchNote}`] : []),
    ].join("\n");

    return textResult(text, { query, answer, sources, indexedCount });
  };
}
