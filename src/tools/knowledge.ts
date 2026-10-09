import { basename } from "node:path";
import { z } from "zod";
import type { EntityGraph } from "../graph/entity-graph.js";
import type { KnowledgeChunkHit, KnowledgeIndex } from "../knowledge/index-store.js";
import type { TokenBucket } from "../rate-limiter.js";
import { parseAllowedDirs, readLocalDocument } from "../documents/local-files.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { rewriteQuery } from "../search/query-rewrite.js";
import { validatePublicHttpUrl } from "../ssrf.js";
import { buildIndexHitJson, formatToolResult } from "../format/structured-output.js";
import type { ContentLoader, UrlValidator } from "./fetch.js";
import { blockedUrlError, errorResult, rateLimitError, textResult, type ToolResult } from "./types.js";

const IngestDocumentSchema = z.object({
  content: z.string().min(1).optional().describe("Document text to index (Markdown or plain text)."),
  path: z.string().min(1).optional().describe("Local file to index (PDF, DOCX, EPUB, HTML or text) inside INGEST_ALLOWED_DIRS."),
  title: z.string().optional().describe("Optional document title."),
  source: z.string().optional().describe("Optional source identifier, usually a URL or file path."),
  category: z.string().optional().describe("Optional category label, e.g. docs, notes, research."),
}).refine((input) => (input.content === undefined) !== (input.path === undefined), "Provide either content or path, not both.");

const IndexUrlSchema = z.object({
  url: z.string().url().describe("URL to fetch and index into the local knowledge base."),
  title: z.string().optional().describe("Optional title override for the indexed document."),
  force_refresh: z.boolean().optional().describe("If true, bypass content cache when fetching."),
});

const SearchIndexSchema = z.object({
  query: z.string().min(1).describe("Hybrid search query over the local knowledge index."),
  max_results: z.number().int().min(1).max(20).optional().describe("Maximum chunks to return (1-20, default 5)."),
  source: z.string().optional().describe("Optional source filter, usually a URL or file path."),
  format: z.enum(["text", "json"]).optional().describe("Response format: text (default) or json."),
});

const FindRelatedSchema = z.object({
  entity: z.string().min(1).describe("Entity name, e.g. Kubernetes or PgBouncer"),
  limit: z.number().int().min(1).max(20).optional().describe("Maximum related items (default 10)"),
});

export type KnowledgeToolDeps = {
  knowledgeIndex: KnowledgeIndex;
  entityGraph: EntityGraph;
  embed: (text: string) => Promise<number[]>;
  fetchContent: ContentLoader;
  fetchLimiter: TokenBucket;
  validateUrl?: UrlValidator;
  /** Directories ingest_document may read files from; empty disables local files. */
  allowedDirs?: () => string[];
};

export function createKnowledgeHandlers({
  knowledgeIndex,
  entityGraph,
  embed,
  fetchContent,
  fetchLimiter,
  validateUrl = validatePublicHttpUrl,
  allowedDirs = () => parseAllowedDirs(process.env.INGEST_ALLOWED_DIRS),
}: KnowledgeToolDeps) {
  const ingest = (input: { content: string; title?: string; source?: string; category?: string }) => {
    const doc = knowledgeIndex.ingest(input);
    const entityCount = entityGraph.indexDocument({
      docId: doc.id,
      source: doc.source,
      title: doc.title,
      content: doc.content,
    });
    return { doc, entityCount };
  };

  return {
    async ingest_document(args: unknown): Promise<ToolResult> {
      try {
        const { content, path, title, source, category } = IngestDocumentSchema.parse(args);
        const input = path === undefined
          ? { content: content as string, title, source, category }
          : await (async () => {
              const file = await readLocalDocument(path, { allowedDirs: allowedDirs() });
              return { content: file.text, title: title ?? file.title ?? basename(file.path), source: source ?? file.path, category: category ?? "file" };
            })();
        const { doc, entityCount } = ingest(input);
        return textResult(`Indexed document "${doc.title}" (${doc.id.slice(0, 12)}…)\nSource: ${doc.source}\nChunks: ${doc.chunkCount}\nEntities: ${entityCount}\nCategory: ${doc.category}`);
      } catch (error) {
        return errorResult(`Failed to ingest document: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async index_url(args: unknown): Promise<ToolResult> {
      const limited = rateLimitError(fetchLimiter, "index_url", "RATE_LIMIT_FETCH_PER_MIN", "20");
      if (limited) return limited;

      const { url, title, force_refresh } = IndexUrlSchema.parse(args);
      const validation = await validateUrl(url);
      if (!validation.ok) return blockedUrlError(validation.hostname ?? url);

      const result = await fetchContent(url, force_refresh ?? false);
      if (result.kind === "error") {
        return errorResult(`Could not fetch page for indexing: ${result.reason}`);
      }

      try {
        const { doc, entityCount } = ingest({ content: result.text, title: title || url, source: url, category: "web" });
        return textResult(`Indexed ${url}\nTitle: ${doc.title}\nChunks: ${doc.chunkCount}\nEntities: ${entityCount}\nDoc ID: ${doc.id.slice(0, 12)}…`);
      } catch (error) {
        return errorResult(`Failed to index page: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async search_index(args: unknown): Promise<ToolResult> {
      const { query, max_results = 5, source, format = "text" } = SearchIndexSchema.parse(args);
      const effectiveQuery = rewriteQuery(query) || query;
      const hits = await knowledgeIndex.search(effectiveQuery, max_results, { source, embed });

      const payload = buildIndexHitJson(query, hits);
      if (format === "json") {
        return textResult(formatToolResult(payload, "json"), payload);
      }

      if (hits.length === 0) {
        return textResult(`No knowledge-index chunks matched "${query}". Use ingest_document or index_url to add content first.`, payload);
      }

      const lines = hits.map((hit: KnowledgeChunkHit, index: number) => {
        const excerpt = hit.text.length > 400 ? `${hit.text.slice(0, 400)}…` : hit.text;
        return `${index + 1}. [Source ${index + 1}] "${hit.title}" (${hit.source})\n   match=${hit.matchedBy} score=${hit.score.toFixed(4)} chunk=${hit.chunkIndex}\n   ${excerpt}`;
      });
      const sources = hits.map((hit: KnowledgeChunkHit, index: number) => `Source ${index + 1}: ${hit.source} — ${hit.title}`).join("\n");
      // Indexed documents often come from the web, so hits are untrusted too.
      return textResult(`Knowledge index hits for "${query}":\n\n${wrapUntrusted(lines.join("\n\n"))}\n\nSources:\n${sources}`, payload);
    },

    async list_index(args: unknown): Promise<ToolResult> {
      const limit = typeof args === "object" && args !== null && "limit" in args
        ? Number((args as { limit?: unknown }).limit) || 50
        : 50;

      const docs = knowledgeIndex.listDocs(limit);
      const stats = knowledgeIndex.getStats();
      if (docs.length === 0) {
        return textResult("Knowledge index is empty. Use ingest_document or index_url to add content.");
      }

      const lines = docs.map((doc, index) =>
        `${index + 1}. ${doc.title} (${doc.source}) — ${doc.chunkCount} chunks, ${doc.category}, id=${doc.id.slice(0, 12)}…`
      );
      return textResult(`Knowledge index: ${stats.docCount} docs, ${stats.chunkCount} chunks, ${stats.vectorCount} vectors\n\n${lines.join("\n")}`);
    },

    async find_related(args: unknown): Promise<ToolResult> {
      const { entity, limit = 10 } = FindRelatedSchema.parse(args);
      const docs = entityGraph.docsForEntity(entity, limit);
      const neighbors = entityGraph.relatedEntities(entity, limit);

      if (docs.length === 0 && neighbors.length === 0) {
        return textResult(`No graph links found for entity "${entity}". Ingest documents first with ingest_document or index_url.`);
      }

      const lines: string[] = [`Entity graph for "${entity}":`];
      if (docs.length > 0) {
        lines.push("", "Documents:");
        docs.forEach((doc, index) => {
          lines.push(`  ${index + 1}. ${doc.title} (${doc.source}) — mentions=${doc.count}`);
        });
      }
      if (neighbors.length > 0) {
        lines.push("", "Related entities:");
        neighbors.forEach((neighbor, index) => {
          lines.push(`  ${index + 1}. ${neighbor.name} — cooccurrence=${neighbor.cooccurrence}`);
        });
      }
      return textResult(lines.join("\n"));
    },
  };
}
