import { describe, expect, it } from "vitest";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { createHostedRequestContext, createLocalRequestContext } from "../runtime/request-context.js";

function hosted(permissions = ["memory:read"]) {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], expiresAt: Date.now() + 60_000, scopes: permissions },
    membership: { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 30_000, signal: new AbortController().signal,
  });
}
describe("transport-independent tool dispatch", () => {
  it("denies missing permission before a write can occur", async () => {
    const notes: string[] = [];
    const dispatcher = new ToolDispatcher({ remember: { permission: "memory:write", modes: ["hosted"], handler: async () => { notes.push("secret"); return {}; } } });
    await expect(dispatcher.call("remember", {}, hosted())).rejects.toThrow("forbidden");
    expect(notes).toEqual([]);
  });
  it("uses trusted context instead of caller-supplied tenant/session/context fields", async () => {
    const notes = new Map([["workspace-a", "Alice private note"], ["workspace-b", "Bob private note"]]);
    const dispatcher = new ToolDispatcher({ recall: { permission: "memory:read", modes: ["hosted"], handler: async (_args, context) => notes.get(context.workspaceId) } });
    expect(await dispatcher.call("recall", { tenantId: "tenant-b", session: "workspace-b", context: { workspaceId: "workspace-b" } }, hosted())).toBe("Alice private note");
  });
  it("blocks local storage handlers for hosted callers even with write scopes", async () => {
    const data: string[] = [];
    const dispatcher = new ToolDispatcher({ remember: { permission: "memory:write", modes: ["local"], handler: async () => { data.push("note"); return "saved"; } } });
    await expect(dispatcher.call("remember", {}, hosted(["memory:write"]))).rejects.toThrow("execution_mode_unavailable");
    expect(data).toEqual([]);
    expect(await dispatcher.call("remember", {}, createLocalRequestContext())).toBe("saved");
  });
  it("rejects missing/forged contexts and unknown tool names without executing a handler", async () => {
    let executions = 0;
    const dispatcher = new ToolDispatcher({ recall: { permission: "memory:read", modes: ["local"], handler: async () => { executions++; return {}; } } });
    await expect(dispatcher.call("recall", {}, undefined)).rejects.toThrow("invalid_context");
    await expect(dispatcher.call("recall", {}, { ...createLocalRequestContext() })).rejects.toThrow("invalid_context");
    await expect(dispatcher.call("toString", {}, createLocalRequestContext())).rejects.toThrow("unknown_tool");
    expect(executions).toBe(0);
  });
  it("checks request cancellation before handler side effects", async () => {
    let executions = 0;
    const controller = new AbortController();
    const context = createLocalRequestContext({ signal: controller.signal });
    controller.abort();
    const dispatcher = new ToolDispatcher({ recall: { permission: "memory:read", modes: ["local"], handler: async () => { executions++; return {}; } } });
    await expect(dispatcher.call("recall", {}, context)).rejects.toThrow("cancelled");
    expect(executions).toBe(0);
  });
});
