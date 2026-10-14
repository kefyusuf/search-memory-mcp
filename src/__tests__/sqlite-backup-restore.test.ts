import { expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync, statSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { SessionMemory } from "../memory/session-memory.js";
import { EntityGraph } from "../graph/entity-graph.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

// Replace only model inference; the database, FTS and native vector operations are real.
vi.mock("../cache/embedding.js", () => ({
  TransformersEmbeddingProvider: class {
    async getEmbedding() { return [1, ...Array(383).fill(0)]; }
  },
}));

it("restores committed WAL data from a SQLite backup into an independent database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-memory-backup-"));
  const path = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  const restoredPath = join(directory, "restored.db");
  const opened: Array<{ close(): void }> = [];
  const indexes: KnowledgeIndex[] = [];
  const track = <T extends { close(): void }>(store: T): T => { opened.push(store); return store; };
  const open = (dbPath: string) => {
    const cache = track(new SQLiteVectorStore(dbPath));
    const index = track(new KnowledgeIndex(dbPath));
    indexes.push(index);
    return { cache, index, memory: track(new SessionMemory(dbPath)), graph: track(new EntityGraph(dbPath)) };
  };
  try {
    const source = open(path);
    const content = "Redis cache fixture " + "x".repeat(512 * 1024);
    const vector = [1, ...Array(383).fill(0)];
    await source.cache.setContent("https://fixture.invalid/redis", content, "docs");
    await source.cache.add("fixture-vector", vector, {
      query: "Redis", results: [], timestamp: Date.now(), namespace: "fixture",
    });
    const doc = source.index.ingest({ content: "Redis cache expiration", title: "Redis fixture", source: "fixture:redis" });
    source.graph.indexDocument({ docId: doc.id, title: doc.title, source: doc.source, content: doc.content });
    await source.index.flush();
    expect(source.index.getStats().vectorCount).toBe(1);
    // Hold an older read snapshot so automatic checkpoints cannot absorb the marker.
    const reader = track(new Database(path, { readonly: true, fileMustExist: true }));
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM session_notes").get();
    const note = source.memory.remember("Keep the original fixture note", { topic: "backup", tags: ["fixture"], session: "test" });
    expect(statSync(path + "-wal").size).toBeGreaterThan(0);

    // Negative control: no checkpoint has copied these commits into the main file.
    const incompletePath = join(directory, "main-file-only.db");
    copyFileSync(path, incompletePath, constants.COPYFILE_EXCL);
    let copiedNote = null;
    try {
      const incompleteMemory = track(new SessionMemory(incompletePath));
      copiedNote = incompleteMemory.get(note.id);
    } catch (error) {
      // A partial checkpoint can also make the main-file-only image unreadable.
      expect(error).toMatchObject({ code: "SQLITE_CORRUPT" });
    }
    expect(copiedNote).toBeNull();
    reader.exec("ROLLBACK");

    // Application writes are quiescent, but all four source connections remain open.
    const progress = await reader.backup(backupPath);
    expect(progress.remainingPages).toBe(0);
    expect(progress.totalPages).toBeGreaterThan(0);

    source.memory.delete(note.id);
    const laterNote = source.memory.remember("This note was written after the backup");
    await source.cache.setContent("https://fixture.invalid/redis", "Later source content", "docs");
    copyFileSync(backupPath, restoredPath, constants.COPYFILE_EXCL);
    const restored = open(restoredPath);
    expect(restored.memory.get(note.id)).toEqual(note);
    expect(restored.memory.get(laterNote.id)).toBeNull();
    expect((await restored.cache.getContent("https://fixture.invalid/redis"))?.content).toBe(content);
    expect((await restored.cache.search(vector, 1, "fixture"))[0]?.id).toBe("fixture-vector");
    expect(restored.index.listDocs().map(row => row.id)).toEqual([doc.id]);
    expect((await restored.index.search("expiration"))[0]?.docId).toBe(doc.id);
    expect(restored.index.getStats().vectorCount).toBe(1);
    expect((await restored.index.search("nonlexicalquery", 1, { embed: async () => vector }))[0]?.matchedBy).toBe("vector");
    expect(restored.graph.docsForEntity("Redis")[0]?.docId).toBe(doc.id);
    expect(restored.graph.entitiesForDoc(doc.id)).toEqual(source.graph.entitiesForDoc(doc.id));
    const probe = track(new Database(restoredPath));
    expect(probe.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(probe.pragma("foreign_key_check")).toEqual([]);

    restored.memory.remember("Independent restored write");
    expect(source.memory.get(note.id)).toBeNull();
    expect(source.memory.list().map(row => row.id)).toEqual([laterNote.id]);
    expect((await source.cache.getContent("https://fixture.invalid/redis"))?.content).toBe("Later source content");
  } finally {
    for (const index of indexes) await index.flush();
    opened.reverse().forEach(store => store.close());
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unsafe backup fixture path");
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

it("TR-01: a physical SQLite backup retains every scope, not just tenant A", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-memory-tr01-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup.db");
  const restoredPath = join(directory, "restored.db");
  const opened: Array<{ close(): void }> = [];
  const indexes: KnowledgeIndex[] = [];
  const track = <T extends { close(): void }>(store: T): T => { opened.push(store); return store; };
  const scopes = [
    { tenant: "tenant-a", workspace: "A1", label: "A1" },
    { tenant: "tenant-a", workspace: "A2", label: "A2" },
    { tenant: "tenant-b", workspace: "B1", label: "B1" },
  ] as const;
  const permissions = ["content:read", "cache:manage", "knowledge:read", "knowledge:write", "memory:read", "memory:write"] as const;
  const context = (tenant: string, workspace: string): RequestContext => createHostedRequestContext({
    authorization: { subject: "synthetic-principal", audiences: ["mcp"], scopes: permissions, expiresAt: Date.now() + 60_000 },
    membership: { principalId: "synthetic-principal", tenantId: tenant, workspaceId: workspace, permissions },
    expectedAudience: "mcp", requestId: "synthetic-tr01", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
  });
  const open = (dbPath: string, ctx: RequestContext) => {
    const cache = track(new SQLiteVectorStore(dbPath, { context: ctx, useNativeVectors: false }));
    const index = track(new KnowledgeIndex(dbPath, { context: ctx, enableEmbeddings: false }));
    indexes.push(index);
    return { cache, index, memory: track(new SessionMemory(dbPath, { context: ctx })), graph: track(new EntityGraph(dbPath, { context: ctx })) };
  };
  const sameUrl = "https://fixture.invalid/same-resource";
  try {
    const sources = scopes.map(scope => ({ scope, stores: open(sourcePath, context(scope.tenant, scope.workspace)) }));
    for (const { scope, stores } of sources) {
      await stores.cache.setContent(sameUrl, "private-content-" + scope.label, "docs");
      stores.memory.remember("private-note-" + scope.label, { session: "shared-session" });
      stores.index.ingest({ source: "shared-source", title: scope.label, content: "private-document-" + scope.label });
      stores.graph.indexDocument({ docId: "shared-graph-id", source: "shared-source", title: scope.label, content: "Kubernetes uses PostgreSQL." });
      await stores.index.flush();
    }

    // No producer writes during the Online Backup API call; original source stays intact.
    const reader = track(new Database(sourcePath, { readonly: true, fileMustExist: true }));
    const progress = await reader.backup(backupPath);
    expect(progress.remainingPages).toBe(0);
    expect(progress.totalPages).toBeGreaterThan(0);
    copyFileSync(backupPath, restoredPath, constants.COPYFILE_EXCL);

    // A trusted raw-file inspection sees ALL three scopes in each persisted store.
    // This physical image must never be described or exposed as a tenant-A export.
    const probe = track(new Database(restoredPath, { readonly: true, fileMustExist: true }));
    const expected = scopes.map(scope => ({
      execution_mode: "hosted", tenant_id: scope.tenant, workspace_id: scope.workspace, n: 1,
    }));
    for (const table of ["content_cache", "session_notes", "knowledge_docs", "graph_docs"]) {
      const result = probe.prepare(
        "SELECT execution_mode, tenant_id, workspace_id, COUNT(*) AS n FROM " + table +
        " GROUP BY execution_mode, tenant_id, workspace_id ORDER BY tenant_id, workspace_id"
      ).all();
      expect(result).toEqual(expected);
    }
    expect(probe.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(probe.pragma("foreign_key_check")).toEqual([]);

    // Normal scoped reads on the restored file still isolate A1, A2 and B1.
    for (const scope of scopes) {
      const restored = open(restoredPath, context(scope.tenant, scope.workspace));
      expect((await restored.cache.getContent(sameUrl))?.content).toBe("private-content-" + scope.label);
      expect(restored.memory.list().map(note => note.text)).toEqual(["private-note-" + scope.label]);
      expect(restored.index.listDocs().map(doc => doc.title)).toEqual([scope.label]);
      expect(restored.graph.getStats().docCount).toBe(1);
    }
  } finally {
    for (const index of indexes) await index.flush();
    opened.reverse().forEach(store => store.close());
    if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Unsafe TR-01 fixture path");
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
