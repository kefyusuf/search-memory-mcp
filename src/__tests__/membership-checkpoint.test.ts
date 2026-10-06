import { beforeAll, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { JwtAuthorizationAdapter } from "../runtime/jwt-authorization.js";
import { assertRequestContext, assertRequestAuthorization, type WorkspaceMembership } from "../runtime/request-context.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../runtime/invocation-admission.js";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair("ES256"); });
async function fixture() {
  let membership: WorkspaceMembership | null = { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] };
  const resolve = vi.fn(async () => membership);
  const adapter = new JwtAuthorizationAdapter({ issuer: "https://auth.example.com", audience: "https://mcp.example.com/mcp", algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership: resolve });
  const token = await new SignJWT({ scope: "memory:read memory:write" }).setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).setIssuer("https://auth.example.com").setAudience("https://mcp.example.com/mcp").setSubject("alice").setExpirationTime("2m").sign(keys.privateKey);
  const controller = new AbortController();
  const context = await adapter.authenticate(`Bearer ${token}`, { workspaceId: "workspace-a", requestId: "r1", deadlineAt: Date.now() + 60000, signal: controller.signal });
  const admission = new InMemoryInvocationAdmission({ global: 1, tenant: 1, workspace: 1, principal: 1 });
  return { context, resolve, admission, controller, set: (value: WorkspaceMembership | null) => { membership = value; }, dispatcher: (handler: () => Promise<string>) => new ToolDispatcher({ recall: { permission: "memory:read", modes: ["hosted"], handler } }, { admission }) };
}
it("denies a revoked membership before handler effects and never revives the context", async () => {
  const f = await fixture(); const handler = vi.fn(async () => "private"); f.set(null);
  await expect(f.dispatcher(handler).call("recall", {}, f.context)).rejects.toThrow("forbidden"); expect(handler).not.toHaveBeenCalled();
  f.set({ principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] });
  expect(() => assertRequestContext(f.context)).toThrow("forbidden");
});
it.each(["tenant", "principal", "workspace", "permissions"])("denies changed %s before a handler runs", async field => {
  const f = await fixture(); const next = { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] };
  if (field === "permissions") next.permissions = []; else next[`${field}Id` as "tenantId"] = "other";
  f.set(next); const handler = vi.fn(async () => "private");
  await expect(f.dispatcher(handler).call("recall", {}, f.context)).rejects.toThrow("forbidden"); expect(handler).not.toHaveBeenCalled();
});
it("withholds a late result after revocation and releases admission", async () => {
  const f = await fixture(); await expect(f.dispatcher(async () => { f.set(null); return "private"; }).call("recall", {}, f.context)).rejects.toThrow("forbidden");
  const other = await fixture(); const release = await f.admission.acquire(other.context); await release();
});
it("supports an explicit checkpoint before effects after a wait", async () => {
  const f = await fixture(); let effects = 0;
  await expect(f.dispatcher(async () => { f.set(null); await assertRequestAuthorization(f.context); effects++; return "private"; }).call("recall", {}, f.context)).rejects.toThrow("forbidden"); expect(effects).toBe(0);
});
it("contains backend errors and fails closed for subsequent synchronous checks", async () => {
  const f = await fixture(); f.resolve.mockRejectedValueOnce(new Error("secret connection details"));
  await expect(assertRequestAuthorization(f.context)).rejects.toThrow("authorization_unavailable");
  expect(() => assertRequestContext(f.context)).toThrow("authorization_unavailable");
});
it("coalesces concurrent checkpoints without adding grants", async () => {
  const f = await fixture(); f.set({ principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read", "memory:write"] });
  await Promise.all([assertRequestAuthorization(f.context), assertRequestAuthorization(f.context)]);
  expect(f.resolve).toHaveBeenCalledTimes(2); expect(f.context.permissions).toEqual(["memory:read"]);
});
it("rejects cancellation during checkpoint lookup without handler effects", async () => {
  const f = await fixture(); f.resolve.mockImplementationOnce(async () => { f.controller.abort(); return null; });
  const handler = vi.fn(async () => "private");
  await expect(f.dispatcher(handler).call("recall", {}, f.context)).rejects.toThrow("cancelled"); expect(handler).not.toHaveBeenCalled();
});
it("rejects deadlines reached during checkpoint lookup", async () => {
  const f = await fixture(); const now = vi.spyOn(Date, "now");
  f.resolve.mockImplementationOnce(async () => { now.mockReturnValue(f.context.deadlineAt); return null; });
  try { await expect(assertRequestAuthorization(f.context)).rejects.toThrow("deadline_exceeded"); }
  finally { now.mockRestore(); }
});
it("does not expose checkpoint callbacks in serialized or copied contexts", async () => {
  const f = await fixture(); expect(JSON.stringify(f.context)).not.toContain("revalidate");
  await expect(assertRequestAuthorization({ ...f.context })).rejects.toThrow("invalid_context");
  expect(f.resolve).toHaveBeenCalledTimes(1);
});
