import { describe, expect, it } from "vitest";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFINITIONS } from "../tools/definitions.js";

const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

describe("tool annotations", () => {
  it("are valid MCP tool metadata with a title for every tool", () => {
    const parsed = ListToolsResultSchema.parse({ tools: TOOL_DEFINITIONS });
    for (const tool of parsed.tools) {
      expect(tool.annotations?.title, tool.name).toEqual(expect.any(String));
    }
  });

  it.each(["web_search", "fetch_content", "server_status", "search_index", "list_index", "recall", "find_related"])(
    "marks %s as read-only",
    (name) => {
      expect(byName.get(name)?.annotations).toMatchObject({ readOnlyHint: true });
    },
  );

  it.each(["ingest_document", "index_url", "remember"])("marks %s as an additive write", (name) => {
    expect(byName.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("marks forget as destructive and idempotent", () => {
    expect(byName.get("forget")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it("marks only tools that reach the internet as open-world", () => {
    const openWorld = TOOL_DEFINITIONS.filter((tool) => tool.annotations?.openWorldHint).map((tool) => tool.name).sort();
    expect(openWorld).toEqual(["fetch_content", "index_url", "web_search"]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.annotations?.openWorldHint, tool.name).toEqual(expect.any(Boolean));
    }
  });
});
