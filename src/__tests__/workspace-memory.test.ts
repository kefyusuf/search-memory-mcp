import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionMemory } from "../memory/session-memory.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

function context(tenantId = "tenant-a", workspaceId = "shared-name", permissions = ["memory:read", "memory:write"]): RequestContext {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], scopes: permissions, expiresAt: Date.now() + 60_000 },
    membership: { principalId: "alice", tenantId, workspaceId, permissions },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
  });
}

describe("workspace memory isolation", () => {
  let dir: string;
  let path: string;
  let stores: SessionMemory[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "workspace-memory-")); path = join(dir, "notes.db"); stores = []; });
  afterEach(() => { for (const store of stores) store.close(); rmSync(dir, { recursive: true, force: true }); });
  function open(ctx?: RequestContext, maxNotes = 500) {
    const store = new SessionMemory(path, { maxNotes, ...(ctx ? { context: ctx } : {}) });
    stores.push(store);
    return store;
  }

  it("isolates reads by both tenant and workspace despite matching session and topic", () => {
    const a = open(context());
    const b = open(context("tenant-b"));
    const otherWorkspace = open(context("tenant-a", "other-workspace"));
    a.remember("Alice private pooling note", { session: "same", topic: "postgres" });
    const bob = b.remember("Bob private pooling note", { session: "same", topic: "postgres" });
    otherWorkspace.remember("Other workspace pooling note", { session: "same", topic: "postgres" });
    expect(a.list({ session: "same", topic: "postgres" }).map(n => n.text)).toEqual(["Alice private pooling note"]);
    expect(a.search("pooling").map(n => n.text)).toEqual(["Alice private pooling note"]);
    expect(a.get(bob.id)).toBeNull();
    expect(a.getStats()).toEqual({ count: 1, sessions: 1 });
  });

  it("cannot delete a foreign id or clear another workspace's matching session", () => {
    const a = open(context()); const b = open(context("tenant-b"));
    a.remember("Alice", { session: "same" });
    const bob = b.remember("Bob", { session: "same" });
    expect(a.delete(bob.id)).toBe(false);
    expect(a.clear("same")).toBe(1);
    expect(b.get(bob.id)?.text).toBe("Bob");
    a.remember("Alice again");
    expect(a.clear()).toBe(1);
    expect(b.list()).toHaveLength(1);
  });

  it("evicts only the writing workspace when its capacity is reached", () => {
    const b = open(context("tenant-b")); const bob = b.remember("Bob survives");
    const a = open(context(), 1);
    a.remember("Alice old"); a.remember("Alice latest");
    expect(a.list().map(n => n.text)).toEqual(["Alice latest"]);
    expect(b.get(bob.id)?.text).toBe("Bob survives");
  });

  it("keeps legacy rows local across migration and reopen, even for hosted local-named tenants", () => {
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE session_notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, topic TEXT NOT NULL, tags TEXT NOT NULL, session TEXT NOT NULL, timestamp INTEGER NOT NULL)");
    legacy.prepare("INSERT INTO session_notes VALUES (?, ?, ?, ?, ?, ?)").run("legacy-id", "Legacy private note", "general", "[]", "same", 1);
    legacy.close();
    const hosted = open(context("local", "local"));
    expect(hosted.get("legacy-id")).toBeNull();
    hosted.remember("Hosted note");
    const local = open();
    expect(local.list().map(n => n.text)).toEqual(["Legacy private note"]);
    for (const store of stores) store.close();
    stores = [];
    expect(open(context("local", "local")).list().map(n => n.text)).toEqual(["Hosted note"]);
    expect(open().get("legacy-id")?.text).toBe("Legacy private note");
  });

  it("rejects forged contexts instead of falling back to local access", () => {
    expect(() => { const store = new SessionMemory(path, { context: {} as RequestContext }); stores.push(store); }).toThrow("invalid_context");
  });

  it("denies writes for read-only membership without changing stored notes", () => {
    const reader = open(context("tenant-a", "shared-name", ["memory:read"]));
    expect(() => reader.remember("Forbidden")).toThrow("forbidden");
    expect(() => reader.delete("any-id")).toThrow("forbidden");
    expect(() => reader.clear()).toThrow("forbidden");
    expect(reader.list()).toEqual([]);
  });

  it("denies every read path for write-only membership", () => {
    const writer = open(context("tenant-a", "shared-name", ["memory:write"]));
    const note = writer.remember("Secret");
    for (const read of [() => writer.get(note.id), () => writer.list(), () => writer.search(""), () => writer.getStats()]) {
      expect(read).toThrow("forbidden");
    }
  });
});
