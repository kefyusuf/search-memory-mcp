import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedRequestContext, createLocalRequestContext, assertRequestContext } from "../runtime/request-context.js";

const NOW = 1_800_000_000_000;
function options() {
  return {
    authorization: { subject: "alice", audiences: ["mcp-service"], expiresAt: NOW + 60_000, scopes: ["memory:read", "memory:write"] },
    membership: { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] },
    expectedAudience: "mcp-service", requestId: "request-1", deadlineAt: NOW + 30_000,
    signal: new AbortController().signal,
  };
}
describe("request context", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it("rejects missing authorization and membership for another principal", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(() => createHostedRequestContext({ ...options(), authorization: null })).toThrow("unauthenticated");
    expect(() => createHostedRequestContext({ ...options(), membership: { ...options().membership, principalId: "bob" } })).toThrow("forbidden");
    vi.restoreAllMocks();
  });
  it("rejects expired or wrong-audience authorization", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    expect(() => createHostedRequestContext({ ...options(), authorization: { ...options().authorization, expiresAt: NOW } })).toThrow("unauthenticated");
    expect(() => createHostedRequestContext({ ...options(), expectedAudience: "other-service" })).toThrow("unauthenticated");
    vi.restoreAllMocks();
  });
  it("intersects membership grants with scopes and keeps an immutable snapshot", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const input = options();
    const context = createHostedRequestContext(input);
    input.membership.permissions.push("memory:write");
    input.authorization.scopes.push("admin");
    expect(context.permissions).toEqual(["memory:read"]);
    expect(context).toMatchObject({ mode: "hosted", principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a" });
    expect(() => (context.permissions as string[]).push("memory:write")).toThrow();
    expect(() => Object.assign(context, { tenantId: "tenant-b" })).toThrow();
    vi.restoreAllMocks();
  });
  it("rejects copied contexts and rechecks expiry after issuance", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const context = createHostedRequestContext(options());
    expect(() => assertRequestContext({ ...context })).toThrow("invalid_context");
    vi.mocked(Date.now).mockReturnValue(NOW + 60_000);
    expect(() => assertRequestContext(context)).toThrow("unauthenticated");
    vi.restoreAllMocks();
  });
  it("rejects aborted or expired requests before execution", () => {
    const controller = new AbortController();
    const context = createLocalRequestContext({ signal: controller.signal });
    controller.abort();
    expect(() => assertRequestContext(context)).toThrow("cancelled");
    const expired = createLocalRequestContext({ deadlineAt: Date.now() - 1 });
    expect(() => assertRequestContext(expired)).toThrow("deadline_exceeded");
  });
});
