import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";
import { createHostedRequestContext, createLocalRequestContext, PERMISSIONS } from "../runtime/request-context.js";

function hosted() {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], expiresAt: Date.now() + 60_000, scopes: PERMISSIONS },
    membership: { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: PERMISSIONS },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
  });
}
describe("WebSearchServer tool service", () => {
  beforeEach(() => { vi.stubEnv("CACHE_DB_PATH", ":memory:"); vi.stubEnv("NODE_ENV", "test"); });
  afterEach(() => vi.unstubAllEnvs());

  it("preserves local memory tools through the transport-independent entry point", async () => {
    const server = new WebSearchServer();
    const saved = await server.callTool("remember", { text: "Local note", session: "local-session" }, createLocalRequestContext());
    expect(saved.isError).not.toBe(true);
    const recalled = await server.callTool("recall", { session: "local-session" }, createLocalRequestContext());
    expect(recalled.content[0].text).toContain("Local note");
  });

  it("rejects hosted calls for every built-in tool until its dependencies are tenant-safe", async () => {
    const server = new WebSearchServer();
    for (const name of ["web_search", "fetch_content", "server_status", "ingest_document", "index_url", "search_index", "list_index", "remember", "recall", "forget", "find_related", "research"]) {
      const result = await server.callTool(name, { text: "Hosted leak" }, hosted());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Request rejected: execution_mode_unavailable");
    }
    const notes = await server.callTool("recall", {}, createLocalRequestContext());
    expect(notes.content[0].text).not.toContain("Hosted leak");
  });

  it("does not accept credentials or a local execution mode from arguments", async () => {
    const server = new WebSearchServer();
    const result = await server.callTool("remember", { text: "Leak", context: createLocalRequestContext(), mode: "local" }, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("Request rejected: invalid_context");
  });

  it("keeps unknown-tool and validation errors compatible with local clients", async () => {
    const server = new WebSearchServer();
    const unknown = await server.callTool("missing", {}, createLocalRequestContext());
    expect(unknown.content[0].text).toBe("Unknown tool: missing");
    const invalid = await server.callTool("web_search", { query: "" }, createLocalRequestContext());
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain("Invalid arguments:");
  });
});
