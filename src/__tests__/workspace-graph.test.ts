import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntityGraph } from "../graph/entity-graph.js";
import { createHostedRequestContext, type RequestContext } from "../runtime/request-context.js";

function context(tenantId = "tenant-a", workspaceId = "workspace", permissions = ["knowledge:read", "knowledge:write"]): RequestContext {
  return createHostedRequestContext({
    authorization: { subject: "alice", audiences: ["mcp"], scopes: permissions, expiresAt: Date.now() + 60_000 },
    membership: { principalId: "alice", tenantId, workspaceId, permissions },
    expectedAudience: "mcp", requestId: "r1", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal,
  });
}

describe("workspace graph isolation", () => {
  let dir: string; let path: string; let graphs: EntityGraph[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "workspace-graph-")); path = join(dir, "graph.db"); graphs = []; });
  afterEach(() => { for (const graph of graphs) graph.close(); rmSync(dir, { recursive: true, force: true }); });
  function open(ctx?: RequestContext) {
    const graph = new EntityGraph(path, ctx ? { context: ctx } : {});
    graphs.push(graph); return graph;
  }
  function index(graph: EntityGraph, content: string, docId = "same-id", source = "same-source") {
    graph.indexDocument({ docId, source, title: docId, content });
  }

  it.each([["tenant-b", "workspace"], ["tenant-a", "other-workspace"]])(
    "keeps document replacement within scope when another scope is %s/%s", (tenant, workspace) => {
      const a = open(context()); const b = open(context(tenant, workspace));
      index(a, "Kubernetes runs PostgreSQL."); index(b, "Kubernetes runs Redis.");
      index(b, "Kubernetes runs Docker.");
      expect(a.entitiesForDoc("same-id").map(e => e.name)).toContain("PostgreSQL");
      expect(a.entitiesForDoc("same-id").map(e => e.name)).not.toContain("Docker");
      expect(b.entitiesForDoc("same-id").map(e => e.name)).toContain("Docker");
    },
  );

  it("filters document lookup before ranking and limit despite matching entity and source", () => {
    const a = open(context()); const b = open(context("tenant-b"));
    index(a, "Kubernetes runs PostgreSQL.", "alice-doc");
    index(b, "Kubernetes Kubernetes Kubernetes runs Redis.", "bob-doc");
    expect(a.docsForEntity("Kubernetes", 1).map(d => d.docId)).toEqual(["alice-doc"]);
    expect(a.entitiesForDoc("bob-doc")).toEqual([]);
  });

  it("isolates neighbor joins when both entity ids and document ids match", () => {
    const a = open(context()); const b = open(context("tenant-b"));
    index(a, "Kubernetes runs PostgreSQL."); index(b, "Kubernetes runs Redis.");
    expect(a.relatedEntities("Kubernetes").map(e => e.name)).toContain("PostgreSQL");
    expect(a.relatedEntities("Kubernetes").map(e => e.name)).not.toContain("Redis");
    expect(b.relatedEntities("Kubernetes").map(e => e.name)).not.toContain("PostgreSQL");
  });

  it("does not disclose another workspace's document, entity or link counts", () => {
    const a = open(context()); const b = open(context("tenant-a", "other-workspace"));
    index(a, "Kubernetes runs PostgreSQL.", "alice-doc");
    const ownStats = a.getStats();
    index(b, "Docker runs Redis.", "bob-doc");
    expect(a.getStats()).toEqual(ownStats);
    expect(open(context("empty-tenant")).getStats()).toEqual({ entityCount: 0, docCount: 0, linkCount: 0 });
  });

  it("migrates legacy links into local scope and preserves them after reopening", () => {
    const db = new Database(path);
    db.exec(`
      CREATE TABLE graph_entities (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, mention_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE graph_docs (doc_id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE graph_doc_entities (doc_id TEXT NOT NULL, entity_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(doc_id, entity_id));
      INSERT INTO graph_entities VALUES ('legacy-entity', 'Kubernetes', 2);
      INSERT INTO graph_docs VALUES ('legacy-doc', 'legacy-source', 'Legacy title', 1);
      INSERT INTO graph_doc_entities VALUES ('legacy-doc', 'legacy-entity', 2);
    `);
    db.close();
    const hosted = open(context("local", "local"));
    expect(hosted.docsForEntity("Kubernetes")).toEqual([]);
    index(hosted, "Kubernetes runs Redis.", "legacy-doc");
    const local = open();
    expect(local.docsForEntity("Kubernetes")).toEqual([{ docId: "legacy-doc", source: "legacy-source", title: "Legacy title", count: 2 }]);
    for (const graph of graphs) graph.close(); graphs = [];
    expect(open().entitiesForDoc("legacy-doc")).toEqual([{ name: "Kubernetes", count: 2 }]);
    expect(open(context("local", "local")).docsForEntity("Kubernetes")[0].source).toBe("same-source");
  });

  it("denies storage writes for read-only contexts without side effects", () => {
    const reader = open(context("tenant-a", "workspace", ["knowledge:read"]));
    expect(() => index(reader, "Forbidden PostgreSQL.")).toThrow("forbidden");
    expect(reader.getStats().docCount).toBe(0);
  });

  it("denies every graph read for write-only contexts", () => {
    const writer = open(context("tenant-a", "workspace", ["knowledge:write"]));
    index(writer, "Kubernetes runs PostgreSQL.");
    for (const read of [() => writer.entitiesForDoc("same-id"), () => writer.docsForEntity("Kubernetes"), () => writer.relatedEntities("Kubernetes"), () => writer.getStats()]) {
      expect(read).toThrow("forbidden");
    }
  });

  it("rejects a copied context before accessing the database", () => {
    expect(() => { const graph = new EntityGraph(path, { context: { ...context() } }); graphs.push(graph); }).toThrow("invalid_context");
  });
});
