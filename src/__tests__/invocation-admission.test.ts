import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryInvocationAdmission, type ConcurrencyLimits } from "../runtime/invocation-admission.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { createHostedRequestContext, createLocalRequestContext, type RequestContext } from "../runtime/request-context.js";

const generous = { global: 10, tenant: 10, workspace: 10, principal: 10 };
function hosted(tenantId = "a", workspaceId = "w", principalId = "alice", signal = new AbortController().signal) {
  return createHostedRequestContext({
    authorization: { subject: principalId, audiences: ["mcp"], scopes: ["memory:read"], expiresAt: Date.now() + 60_000 },
    membership: { principalId, tenantId, workspaceId, permissions: ["memory:read"] }, expectedAudience: "mcp",
    requestId: "same-request-id", deadlineAt: Date.now() + 60_000, signal,
  });
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function dispatcher(admission: InMemoryInvocationAdmission, handler: () => Promise<string>) {
  return new ToolDispatcher({ recall: { permission: "memory:read", modes: ["hosted", "local"], handler } }, { admission });
}

describe("hosted invocation admission", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ["global", hosted("b", "other", "bob")],
    ["tenant", hosted("a", "other", "bob")],
    ["workspace", hosted("a", "w", "bob")],
    ["principal", hosted("b", "other", "alice")],
  ] as const)("enforces the %s dimension atomically", (dimension, second) => {
    const admission = new InMemoryInvocationAdmission({ ...generous, [dimension]: 1 });
    const release = admission.acquire(hosted());
    expect(() => admission.acquire(second)).toThrow("concurrency_exceeded");
    release(); const next = admission.acquire(second); next();
  });
  it("isolates identical workspace labels across tenants", () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, workspace: 1 });
    const a = admission.acquire(hosted()); const b = admission.acquire(hosted("b", "w", "bob"));
    a(); b();
  });
  it("does not leak global capacity after a lower dimension rejects", () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 2, tenant: 1 });
    const a = admission.acquire(hosted());
    expect(() => admission.acquire(hosted("a", "other", "bob"))).toThrow("concurrency_exceeded");
    const b = admission.acquire(hosted("b", "w", "bob")); a(); b();
  });
  it("releases a grant at most once without releasing another active call", () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 });
    const a = admission.acquire(hosted()); a();
    const b = admission.acquire(hosted()); a();
    expect(() => admission.acquire(hosted())).toThrow("concurrency_exceeded"); b();
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid limits: %s", invalid => {
    for (const dimension of Object.keys(generous)) {
      expect(() => new InMemoryInvocationAdmission({ ...generous, [dimension]: invalid } as ConcurrencyLimits)).toThrow("invalid_concurrency_limits");
    }
  });
  it("takes an immutable policy snapshot", () => {
    const limits = { ...generous, global: 1 }; const admission = new InMemoryInvocationAdmission(limits);
    limits.global = 10; const release = admission.acquire(hosted());
    expect(() => admission.acquire(hosted())).toThrow("concurrency_exceeded"); release();
  });
  it("rejects forged or cancelled contexts before allocating capacity", () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 });
    expect(() => admission.acquire({ ...hosted() } as RequestContext)).toThrow("invalid_context");
    const controller = new AbortController(); const context = hosted("a", "w", "alice", controller.signal); controller.abort();
    expect(() => admission.acquire(context)).toThrow("cancelled");
    admission.acquire(hosted())();
  });
  it("shares capacity between dispatchers and ignores caller quota fields and repeated request ids", async () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }); const hold = deferred(); let starts = 0;
    const first = dispatcher(admission, async () => { starts++; await hold.promise; return "done"; });
    const second = dispatcher(admission, async () => { starts++; return "other"; });
    const pending = first.call("recall", {}, hosted());
    try {
      await expect(second.call("recall", { tenantId: "b", requestId: "new", bypassQuota: true }, hosted())).rejects.toThrow("concurrency_exceeded");
      expect(starts).toBe(1);
    } finally { hold.resolve(); await pending; }
    expect(await second.call("recall", {}, hosted())).toBe("other");
  });
  it("releases capacity after a rejected handler", async () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 });
    await expect(dispatcher(admission, async () => { throw new Error("failed"); }).call("recall", {}, hosted())).rejects.toThrow("failed");
    expect(await dispatcher(admission, async () => "next").call("recall", {}, hosted())).toBe("next");
  });
  it("retains capacity after cancellation until the underlying handler actually settles", async () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }); const hold = deferred(); const started = deferred();
    const controller = new AbortController(); const context = hosted("a", "w", "alice", controller.signal);
    const first = dispatcher(admission, async () => { started.resolve(); await hold.promise; return "private"; });
    const next = dispatcher(admission, async () => "next");
    const pending = first.call("recall", {}, context); await started.promise; controller.abort();
    try { await expect(next.call("recall", {}, hosted())).rejects.toThrow("concurrency_exceeded"); }
    finally { hold.resolve(); await expect(pending).rejects.toThrow("cancelled"); }
    expect(await next.call("recall", {}, hosted())).toBe("next");
  });
  it("does not count local calls against hosted capacity", async () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }); const hold = deferred();
    const pending = dispatcher(admission, async () => { await hold.promise; return "hosted"; }).call("recall", {}, hosted());
    try { expect(await dispatcher(admission, async () => "local").call("recall", {}, createLocalRequestContext())).toBe("local"); }
    finally { hold.resolve(); await pending; }
  });
  it("does not execute after cancellation while awaiting an asynchronous admission grant", async () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }); const grant = deferred();
    const controller = new AbortController(); const context = hosted("a", "w", "alice", controller.signal); let executions = 0;
    const first = new ToolDispatcher({ recall: { permission: "memory:read", modes: ["hosted"], handler: async () => { executions++; return "private"; } } }, {
      admission: { acquire: async ctx => { const release = admission.acquire(ctx); await grant.promise; return release; } },
    });
    const pending = first.call("recall", {}, context); controller.abort(); grant.resolve();
    await expect(pending).rejects.toThrow("cancelled"); expect(executions).toBe(0);
    expect(await dispatcher(admission, async () => "next").call("recall", {}, hosted())).toBe("next");
  });
  it("rechecks cancellation after asynchronous grant release before returning results", async () => {
    const controller = new AbortController();
    const first = new ToolDispatcher({ recall: { permission: "memory:read", modes: ["hosted"], handler: async () => "private" } }, {
      admission: { acquire: () => async () => { await Promise.resolve(); controller.abort(); } },
    });
    await expect(first.call("recall", {}, hosted("a", "w", "alice", controller.signal))).rejects.toThrow("cancelled");
  });
  it.each(["deadline_exceeded", "unauthenticated"])("rejects late results and releases capacity after %s", async code => {
    const now = Date.now(); const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 });
    const context = createHostedRequestContext({
      authorization: { subject: "alice", audiences: ["mcp"], scopes: ["memory:read"], expiresAt: now + (code === "unauthenticated" ? 100 : 1000) },
      membership: { principalId: "alice", tenantId: "a", workspaceId: "w", permissions: ["memory:read"] }, expectedAudience: "mcp",
      requestId: "r1", deadlineAt: now + (code === "deadline_exceeded" ? 100 : 1000), signal: new AbortController().signal,
    });
    const first = dispatcher(admission, async () => { vi.spyOn(Date, "now").mockReturnValue(now + 200); return "private"; });
    await expect(first.call("recall", {}, context)).rejects.toThrow(code);
    vi.restoreAllMocks();
    expect(await dispatcher(admission, async () => "next").call("recall", {}, hosted())).toBe("next");
  });
});

describe("hosted invocation sliding-window rate limits", () => {
  afterEach(() => vi.restoreAllMocks());
  const rate = { ...generous, windowMs: 1000 };
  it.each([
    ["global", () => hosted("b", "other", "bob")],
    ["tenant", () => hosted("a", "other", "bob")],
    ["workspace", () => hosted("a", "w", "bob")],
    ["principal", () => hosted("b", "other", "alice")],
  ] as const)("limits completed invocations by %s within the window", (dimension, second) => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, [dimension]: 1 } });
    admission.acquire(hosted())();
    expect(() => admission.acquire(second())).toThrow("rate_exceeded");
  });
  it("does not reset at a wall-clock window boundary", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(999);
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 1 } });
    admission.acquire(hosted())(); clock.mockReturnValue(1000);
    expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
    clock.mockReturnValue(1999); admission.acquire(hosted())();
  });
  it("does not refund accepted rate capacity when a grant is released twice", () => {
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 1 } });
    const release = admission.acquire(hosted()); release(); release();
    expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
  });
  it("expires individual accepted timestamps rather than resetting the whole window", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 2 } });
    admission.acquire(hosted())(); clock.mockReturnValue(500); admission.acquire(hosted())();
    clock.mockReturnValue(999); expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
    clock.mockReturnValue(1000); admission.acquire(hosted())();
    clock.mockReturnValue(1001); expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
    clock.mockReturnValue(1500); admission.acquire(hosted())();
  });
  it("does not refill when the wall clock jumps forward", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 1 } });
    admission.acquire(hosted())(); vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
    expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
  });
  it("does not allocate a concurrency grant on rate rejection", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }, { rateLimits: { ...rate, global: 1 } });
    admission.acquire(hosted())(); expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
    clock.mockReturnValue(1100); admission.acquire(hosted())();
  });
  it("does not charge rejected rate attempts to unrelated dimensions", () => {
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 2, tenant: 1 } });
    admission.acquire(hosted())();
    expect(() => admission.acquire(hosted("a", "other", "bob"))).toThrow("rate_exceeded");
    admission.acquire(hosted("b", "w", "bob"))();
  });
  it("does not charge concurrency rejection to rate capacity", () => {
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }, { rateLimits: { ...rate, global: 2 } });
    const release = admission.acquire(hosted());
    expect(() => admission.acquire(hosted())).toThrow("concurrency_exceeded"); release();
    admission.acquire(hosted())();
    expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
  });
  it("keeps active concurrency grants after their rate timestamps expire", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const admission = new InMemoryInvocationAdmission({ ...generous, global: 1 }, { rateLimits: { ...rate, global: 1 } });
    const release = admission.acquire(hosted()); clock.mockReturnValue(1100);
    expect(() => admission.acquire(hosted())).toThrow("concurrency_exceeded"); release();
    admission.acquire(hosted())();
  });
  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid rate settings: %s", invalid => {
    for (const dimension of [...Object.keys(generous), "windowMs"]) {
      expect(() => new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, [dimension]: invalid } })).toThrow("invalid_rate_limits");
    }
  });
  it("snapshots rate limits and isolates tenant-qualified workspace keys", () => {
    const limits = { ...rate, workspace: 1 }; const admission = new InMemoryInvocationAdmission(generous, { rateLimits: limits });
    limits.workspace = 10; admission.acquire(hosted())();
    expect(() => admission.acquire(hosted())).toThrow("rate_exceeded");
    admission.acquire(hosted("b", "w", "bob"))();
  });
  it("retains accepted rate usage for failed handlers across shared dispatchers", async () => {
    const admission = new InMemoryInvocationAdmission(generous, { rateLimits: { ...rate, global: 1 } });
    await expect(dispatcher(admission, async () => { throw new Error("failed"); }).call("recall", {}, hosted())).rejects.toThrow("failed");
    await expect(dispatcher(admission, async () => "bypass").call("recall", { requestId: "new", tenantId: "other" }, hosted())).rejects.toThrow("rate_exceeded");
    expect(await dispatcher(admission, async () => "local").call("recall", {}, createLocalRequestContext())).toBe("local");
  });
});
