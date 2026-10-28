import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TenantStoreCache } from "../hosted/tenant-stores.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

function context(tenantId = "tenant-a", workspaceId = "workspace-a"): RequestContext {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], scopes: ["memory:read", "memory:write"], expiresAt: Date.now() + 60_000 },
    membership: { principalId: "alice", tenantId, workspaceId, permissions: ["memory:read", "memory:write"] },
    expectedAudience: "mcp", requestId: `r-${tenantId}-${workspaceId}`, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
  });
}

describe("TenantStoreCache", () => {
  let dir: string;
  afterEach(() => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* OS temp */ } } });

  it("opens one store per scope and isolates notes by tenant/workspace", () => {
    dir = mkdtempSync(join(tmpdir(), "tenant-cache-"));
    const cache = new TenantStoreCache({ appDbPath: join(dir, "app.db") });
    const a = cache.memoryFor(context("tenant-a", "workspace-a1"));
    const b = cache.memoryFor(context("tenant-b", "workspace-b1"));
    a.remember("A1 note", { session: "s" });
    b.remember("B1 note", { session: "s" });
    expect(cache.memoryFor(context("tenant-a", "workspace-a1")).list().map(n => n.text)).toEqual(["A1 note"]);
    expect(cache.memoryFor(context("tenant-b", "workspace-b1")).list().map(n => n.text)).toEqual(["B1 note"]);
    expect(cache.memoryFor(context("tenant-a", "workspace-a1"))).toBe(cache.memoryFor(context("tenant-a", "workspace-a1")));
    expect(cache.size).toBe(2);
    cache.close();
  });

  it("rejects local-mode contexts: the cache exists to scope hosted access", () => {
    dir = mkdtempSync(join(tmpdir(), "tenant-cache-"));
    const cache = new TenantStoreCache({ appDbPath: join(dir, "app.db") });
    expect(() => cache.memoryFor({ mode: "local" } as unknown as RequestContext)).toThrow(/invalid_context/);
    cache.close();
  });

  it("evicts the least recently used store beyond the cap and closes it", () => {
    dir = mkdtempSync(join(tmpdir(), "tenant-cache-"));
    const cache = new TenantStoreCache({ appDbPath: join(dir, "app.db"), maxStores: 2 });
    const first = cache.memoryFor(context("tenant-a", "workspace-a1"));
    first.remember("A1 note", { session: "s" });
    cache.memoryFor(context("tenant-a", "workspace-a2"));
    cache.memoryFor(context("tenant-b", "workspace-b1")); // evicts workspace-a1
    expect(cache.size).toBe(2);
    expect(() => first.getStats()).toThrow(); // closed on eviction
    // Reopening after eviction restores the persisted notes (same file).
    const reopened = cache.memoryFor(context("tenant-a", "workspace-a1"));
    expect(reopened.list().map(n => n.text)).toEqual(["A1 note"]);
    cache.close();
  });

  it("rejects an invalid cap at construction", () => {
    expect(() => new TenantStoreCache({ appDbPath: ":memory:", maxStores: 0 })).toThrow();
  });
});
