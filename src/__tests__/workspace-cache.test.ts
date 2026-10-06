import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

const vector = [1, ...Array(383).fill(0)];
const result = (name: string) => ({ query: "same query", namespace: "same-plan", timestamp: Date.now(), results: [{ title: name, url: "https://same.example", snippet: name, source: "test" }] });
function context(tenantId = "tenant-a", workspaceId = "workspace", permissions = ["search:read", "content:read", "status:read", "cache:manage"], signal = new AbortController().signal) {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], scopes: permissions, expiresAt: Date.now() + 60_000 },
    membership: { principalId: "alice", tenantId, workspaceId, permissions },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 60_000, signal,
  });
}
describe.each([true, false])("workspace cache with native vectors=%s", useNativeVectors => {
  let dir: string; let path: string; let stores: SQLiteVectorStore[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "workspace-cache-")); path = join(dir, "cache.db"); stores = []; });
  afterEach(() => { for (const store of stores) store.close(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  function open(ctx?: RequestContext) {
    const store = new SQLiteVectorStore(path, { useNativeVectors, ...(ctx ? { context: ctx } : {}) }); stores.push(store); return store;
  }
  it.each([["tenant-b", "workspace"], ["tenant-a", "other-workspace"]])("isolates matching urls and ids from %s/%s", async (tenant, workspace) => {
    const a = open(context()); const b = open(context(tenant, workspace));
    await a.setContent("https://same.example", "Alice private", "docs");
    await b.setContent("https://same.example", "Bob private", "docs");
    await a.add("same-id", vector, result("Alice")); await b.add("same-id", vector, result("Bob"));
    expect((await a.getContent("https://same.example"))?.content).toBe("Alice private");
    expect((await a.search(vector, 1, "same-plan"))[0].metadata.results[0].title).toBe("Alice");
    expect((await b.search(vector, 1, "same-plan"))[0].metadata.results[0].title).toBe("Bob");
    expect(a.getStats()).toEqual({ contentCount: 1, vectorCount: 1 });
    expect(open(context("empty")).getStats()).toEqual({ contentCount: 0, vectorCount: 0 });
  });
  it("filters ownership and namespace before nearest-neighbor limit", async () => {
    const a = open(context()); const b = open(context("tenant-b"));
    await a.add("own", [0.8, 0.6, ...Array(382).fill(0)], result("Alice"));
    await b.add("closer", vector, result("Bob"));
    await a.add("wrong-plan", vector, { ...result("Wrong plan"), namespace: "other-plan" });
    expect((await a.search(vector, 1, "same-plan")).map(hit => hit.id)).toEqual(["own"]);
  });
  it("prevents a legacy local key from overwriting a known hosted physical key", async () => {
    const hosted = open(context()); await hosted.add("shared", vector, result("Private hosted"));
    const db = new Database(path);
    const table = useNativeVectors ? "semantic_cache_metadata" : "vector_cache_fallback";
    let physicalId: string;
    try { physicalId = (db.prepare(`SELECT id FROM ${table} WHERE entry_id = ?`).get("shared") as { id: string }).id; }
    finally { db.close(); }
    await expect(open().add(physicalId, vector, result("Overwrite"))).rejects.toThrow("cache_key_conflict");
    expect((await hosted.search(vector, 1))[0].metadata.results[0].title).toBe("Private hosted");
  });
  it("refreshes an owned semantic key without changing another workspace's matching key", async () => {
    const a = open(context()); const b = open(context("tenant-b"));
    await a.add("same", vector, result("Old")); await b.add("same", vector, result("Bob"));
    await a.add("same", vector, result("Refreshed"));
    expect((await a.search(vector, 1))[0].metadata.results[0].title).toBe("Refreshed");
    expect((await b.search(vector, 1))[0].metadata.results[0].title).toBe("Bob");
    expect(a.getStats().vectorCount).toBe(1);
  });
  it("clears only the owning workspace including matching ids and urls", async () => {
    const a = open(context()); const b = open(context("tenant-b"));
    for (const [store, name] of [[a, "Alice"], [b, "Bob"]] as const) {
      await store.add("same", vector, result(name)); await store.setContent("https://same.example", name, "docs");
    }
    await a.clear(); expect(a.getStats()).toEqual({ contentCount: 0, vectorCount: 0 });
    expect((await b.search(vector, 1))[0].metadata.results[0].title).toBe("Bob");
    expect((await b.getContent("https://same.example"))?.content).toBe("Bob");
  });
  it("preserves the previous vector and metadata when a refresh fails", async () => {
    const store = open(context()); await store.add("same", vector, result("Previous"));
    const invalid = result("Broken"); Object.assign(invalid, { cycle: invalid });
    await expect(store.add("same", [0, 1, ...Array(382).fill(0)], invalid)).rejects.toThrow();
    const [hit] = await store.search(vector, 1);
    expect(hit.metadata.results[0].title).toBe("Previous");
    expect(hit.score).toBeCloseTo(1);
    expect(store.getStats().vectorCount).toBe(1);
  });
  it("expires content only in the owning workspace", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const a = open(context()); const b = open(context("tenant-b"));
    await a.setContent("https://same.example", "Alice", "docs"); await b.setContent("https://same.example", "Bob", "docs");
    clock.mockReturnValue(1_800_000_000_100);
    expect(a.deleteExpiredContent(10)).toBe(1);
    expect(await a.getContent("https://same.example")).toBeNull();
    expect((await b.getContent("https://same.example"))?.content).toBe("Bob");
  });
  it("preserves legacy caches in local scope after migration and reopen", async () => {
    const db = new Database(path); sqliteVec.load(db);
    db.exec(`
      CREATE TABLE content_cache(url TEXT PRIMARY KEY, content TEXT NOT NULL, category TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE semantic_cache_metadata(id TEXT PRIMARY KEY, metadata TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE VIRTUAL TABLE semantic_cache_vec USING vec0(id TEXT PRIMARY KEY, embedding float[384]);
      CREATE TABLE vector_cache_fallback(id TEXT PRIMARY KEY, vector TEXT NOT NULL, metadata TEXT NOT NULL, timestamp INTEGER NOT NULL);
    `);
    db.prepare("INSERT INTO content_cache VALUES (?, ?, ?, ?)").run("https://same.example", "Legacy private", "docs", Date.now());
    db.prepare("INSERT INTO semantic_cache_metadata VALUES (?, ?, ?)").run("legacy", JSON.stringify(result("Legacy native")), Date.now());
    db.prepare("INSERT INTO semantic_cache_vec(id, embedding) VALUES (?, ?)").run("legacy", new Float32Array(vector));
    db.prepare("INSERT INTO vector_cache_fallback VALUES (?, ?, ?, ?)").run("legacy", JSON.stringify(vector), JSON.stringify(result("Legacy fallback")), Date.now()); db.close();
    const hosted = open(context("local", "local"));
    expect(await hosted.getContent("https://same.example")).toBeNull(); expect(await hosted.search(vector, 1)).toEqual([]);
    await hosted.setContent("https://same.example", "Hosted private", "docs"); await hosted.add("legacy", vector, result("Hosted"));
    for (const store of stores) store.close(); stores = [];
    const local = open();
    expect((await local.getContent("https://same.example"))?.content).toBe("Legacy private");
    expect((await local.search(vector, 1))[0].metadata.results[0].title).toBe(useNativeVectors ? "Legacy native" : "Legacy fallback");
    await local.clear(); // Clear both persisted vector backends, even when one is inactive.
    expect((await open(context("local", "local")).search(vector, 1))[0].metadata.results[0].title).toBe("Hosted");
    const check = new Database(path); sqliteVec.load(check);
    try {
      expect((check.prepare("SELECT count(*) AS n FROM semantic_cache_metadata WHERE id = 'legacy'").get() as { n: number }).n).toBe(0);
      expect((check.prepare("SELECT count(*) AS n FROM vector_cache_fallback WHERE id = 'legacy'").get() as { n: number }).n).toBe(0);
      expect((check.prepare("SELECT count(*) AS n FROM semantic_cache_vec WHERE id = 'legacy'").get() as { n: number }).n).toBe(0);
    } finally { check.close(); }
  });
  it("rejects forged contexts and insufficient permissions", async () => {
    expect(() => { const store = new SQLiteVectorStore(path, { context: {} as RequestContext, useNativeVectors }); stores.push(store); }).toThrow("invalid_context");
    const searchOnly = open(context("tenant-a", "workspace", ["search:read"]));
    await searchOnly.add("own", vector, result("Own"));
    await expect(searchOnly.setContent("https://same.example", "Forbidden", "docs")).rejects.toThrow("forbidden");
    await expect(searchOnly.getContent("https://same.example")).rejects.toThrow("forbidden");
    await expect(searchOnly.clear()).rejects.toThrow("forbidden");
    expect(() => searchOnly.deleteExpiredContent(1)).toThrow("forbidden");
    expect(() => searchOnly.getStats()).toThrow("forbidden");
    expect(await searchOnly.search(vector, 1)).toHaveLength(1);
  });
  it("propagates authorization failure through SemanticCache before inference", async () => {
    const store = open(context("tenant-a", "workspace", ["content:read"])); let inferences = 0;
    const cache = new SemanticCache({ getEmbedding: async () => { inferences++; return vector; }, isAvailable: () => true }, store);
    await expect(cache.get("secret")).rejects.toThrow("forbidden");
    await expect(cache.set("secret", [])).rejects.toThrow("forbidden");
    await expect(cache.clearSearchCache()).rejects.toThrow("forbidden");
    expect(inferences).toBe(0);
  });
  it("rechecks cancellation after SemanticCache waits for embedding", async () => {
    const controller = new AbortController(); const store = open(context("tenant-a", "workspace", undefined, controller.signal));
    let finish!: (vector: number[]) => void;
    const cache = new SemanticCache({ getEmbedding: () => new Promise(resolve => { finish = resolve; }), isAvailable: () => true }, store);
    const pending = cache.get("secret"); controller.abort(); finish(vector);
    await expect(pending).rejects.toThrow("cancelled");
  });
  it("does not turn cancellation plus inference failure into a normal cache miss", async () => {
    const controller = new AbortController(); const store = open(context("tenant-a", "workspace", undefined, controller.signal));
    let fail!: (error: Error) => void;
    const cache = new SemanticCache({ getEmbedding: () => new Promise((_resolve, reject) => { fail = reject; }), isAvailable: () => true }, store);
    const pending = cache.get("secret"); controller.abort(); fail(new Error("inference stopped"));
    await expect(pending).rejects.toThrow("cancelled");
  });
});
