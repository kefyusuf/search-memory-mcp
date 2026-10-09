import { RESEARCH_OUTPUT_SCHEMA, SEARCH_INDEX_OUTPUT_SCHEMA, SERVER_STATUS_OUTPUT_SCHEMA, WEB_SEARCH_OUTPUT_SCHEMA } from "./output-schemas.js";

/**
 * MCP tool advertisements. Names must match the handlers registered in WebSearchServer.
 * Annotations are client hints only: openWorldHint marks tools that contact external sites,
 * and internal cache writes do not make a tool non-read-only.
 */

export const TOOL_DEFINITIONS = [
  {
    name: "web_search",
    annotations: { title: "Web search", readOnlyHint: true, openWorldHint: true },
    description: "Search the web and return results. Use domain to restrict results to a site. Use strategy=aggregate for all configured providers, or strategy=auto for intent-aware provider planning. Use deep=true to fetch pages and extract a direct answer (slower). Use deep=false (default) for a quick ranked list of URLs and snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        expand_query: { type: "boolean", description: "Search up to two extra query variants and fuse results (default: false; increases provider requests)" },
        deep: { type: "boolean", description: "Fetch pages and extract answer (default: false)" },
        max_results: { type: "number", description: "Number of results to return, 1-10 (default: 5)" },
        domain: { type: "string", description: "Optional domain filter, for example react.dev or github.com" },
        from_date: { type: "string", description: "Optional inclusive lower date bound YYYY-MM-DD" },
        to_date: { type: "string", description: "Optional inclusive upper date bound YYYY-MM-DD" },
        format: { type: "string", enum: ["text", "json"], description: "Response format (default: text)" },
        strategy: {
          type: "string",
          enum: ["fallback", "aggregate", "auto"],
          description: "fallback tries providers in order; aggregate queries all configured providers; auto detects intent and selects a configured-provider plan (default: fallback)",
        },
      },
      required: ["query"],
    },
    outputSchema: WEB_SEARCH_OUTPUT_SCHEMA,
  },
  {
    name: "research",
    annotations: { title: "Research a question", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Research a question in one call: checks the local knowledge base, searches the web, reads the top pages, and returns an answer with citations from both. Pages it reads are added to the knowledge base (index=false to skip), so later research and search_index can reuse them.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question or topic to research" },
        max_sources: { type: "number", description: "Web pages to read, 1-5 (default 3)" },
        index: { type: "boolean", description: "Add pages read to the knowledge base (default true)" },
        domain: { type: "string", description: "Optional domain filter for the web search" },
        from_date: { type: "string", description: "Optional inclusive lower date bound YYYY-MM-DD" },
        to_date: { type: "string", description: "Optional inclusive upper date bound YYYY-MM-DD" },
      },
      required: ["query"],
    },
    outputSchema: RESEARCH_OUTPUT_SCHEMA,
  },
  {
    name: "fetch_content",
    annotations: { title: "Fetch page as Markdown", readOnlyHint: true, openWorldHint: true },
    description: "Fetch a webpage and return its content as clean Markdown. PDF, DOCX and EPUB links are converted to text. Uses smart caching based on content type.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        force_refresh: { type: "boolean" },
      },
      required: ["url"],
    },
  },
  {
    name: "server_status",
    annotations: { title: "Server status", readOnlyHint: true, openWorldHint: false },
    description: "Returns the current status of the MCP server: active search providers, cache statistics, model load state, and uptime. Use this to check if the server is healthy before issuing search requests.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    outputSchema: SERVER_STATUS_OUTPUT_SCHEMA,
  },
  {
    name: "ingest_document",
    annotations: { title: "Add document to knowledge base", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Index a document into the local knowledge base for later hybrid search (FTS + vectors). Pass content, or path to a local PDF, DOCX, EPUB, HTML or text file inside INGEST_ALLOWED_DIRS (local files are disabled unless that is set; hidden files are never read). Use this to remember reference material the agent will cite later.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Document text (Markdown or plain text); omit when using path" },
        path: { type: "string", description: "Local file path inside INGEST_ALLOWED_DIRS; omit when using content" },
        title: { type: "string", description: "Optional title" },
        source: { type: "string", description: "Optional source URL or path" },
        category: { type: "string", description: "Optional category label" },
      },
      required: [],
    },
  },
  {
    name: "index_url",
    annotations: { title: "Index web page into knowledge base", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    description: "Fetch a URL and index its clean Markdown into the local knowledge base for later hybrid search. Works for web pages and PDF, DOCX and EPUB links.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch and index" },
        title: { type: "string", description: "Optional title override" },
        force_refresh: { type: "boolean", description: "Bypass content cache when fetching" },
      },
      required: ["url"],
    },
  },
  {
    name: "search_index",
    annotations: { title: "Search knowledge base", readOnlyHint: true, openWorldHint: false },
    description: "Hybrid search (keyword + semantic) over the local knowledge base. Returns matching chunks with source citations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Maximum chunks to return, 1-20 (default 5)" },
        source: { type: "string", description: "Optional source filter (URL or path)" },
        format: { type: "string", enum: ["text", "json"], description: "Response format (default: text)" },
      },
      required: ["query"],
    },
    outputSchema: SEARCH_INDEX_OUTPUT_SCHEMA,
  },
  {
    name: "list_index",
    annotations: { title: "List knowledge base documents", readOnlyHint: true, openWorldHint: false },
    description: "List documents currently stored in the local knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum documents to return (default 50)" },
      },
      required: [],
    },
  },
  {
    name: "remember",
    annotations: { title: "Remember note", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Store a short fact or note in session memory for later turns. Keep notes concise and specific.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Fact or note to remember" },
        topic: { type: "string", description: "Optional topic label" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        session: { type: "string", description: "Optional session id" },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    annotations: { title: "Recall notes", readOnlyHint: true, openWorldHint: false },
    description: "Recall notes from session memory. Pass a query to search, or omit it to list recent notes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional search text" },
        topic: { type: "string", description: "Optional topic filter" },
        session: { type: "string", description: "Optional session filter" },
        limit: { type: "number", description: "Maximum notes to return, 1-50 (default 10)" },
      },
      required: [],
    },
  },
  {
    name: "forget",
    annotations: { title: "Forget note", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Delete a note from session memory by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Note id returned by remember" },
      },
      required: ["id"],
    },
  },
  {
    name: "find_related",
    annotations: { title: "Find related entities", readOnlyHint: true, openWorldHint: false },
    description: "Explore the entity graph built from indexed documents. Returns documents and co-occurring entities for a given entity name.",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "Entity name, e.g. Kubernetes" },
        limit: { type: "number", description: "Maximum related items, 1-20 (default 10)" },
      },
      required: ["entity"],
    },
  },
];
