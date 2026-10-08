import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { once } from "node:events";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { SessionMemory } from "../memory/session-memory.js";
import { EntityGraph } from "../graph/entity-graph.js";

function openStores(path: string) {
  const opened: Array<{ close(): void }> = [];
  const track = <T extends { close(): void }>(store: T): T => { opened.push(store); return store; };
  try {
    return {
      cache: track(new SQLiteVectorStore(path)),
      index: track(new KnowledgeIndex(path, { enableEmbeddings: false })),
      memory: track(new SessionMemory(path)),
      graph: track(new EntityGraph(path)),
    };
  } catch (error) {
    opened.forEach(store => store.close());
    throw error;
  }
}

function removeFixture(directory: string) {
  if (dirname(resolve(directory)) !== resolve(tmpdir())) throw new Error("Fixture path escaped the temporary directory");
  rmSync(directory, { recursive: true, force: true });
}

it("keeps committed data and rolls back a spilled write after process termination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-memory-durability-"));
  const path = join(directory, "fixture.db");
  let stores: ReturnType<typeof openStores> | undefined;
  let child: ReturnType<typeof fork> | undefined;
  try {
    stores = openStores(path);
    await stores.cache.setContent("https://fixture.invalid/redis", "Redis cache guide", "docs");
    const vector = [1, ...Array(383).fill(0)];
    await stores.cache.add("fixture-vector", vector, { query: "Redis", results: [], timestamp: Date.now() });
    const committedText = "Committed fixture note " + "c".repeat(8 * 1024 * 1024);
    const note = stores.memory.remember(committedText);
    const doc = stores.index.ingest({ content: "Redis cache expiration", title: "Redis guide", source: "fixture:redis" });
    stores.graph.indexDocument({ docId: doc.id, source: doc.source, title: doc.title, content: doc.content });
    Object.values(stores).forEach(store => store.close());
    stores = undefined;

    child = fork(join(process.cwd(), "scripts/fixtures/sqlite-crash-writer.mjs"), [path], {
      execArgv: ["--loader", "ts-node/esm"],
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr?.on("data", data => { errors += String(data); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Crash fixture did not reach its checkpoint: " + errors)), 15000);
      child!.once("message", message => {
        clearTimeout(timer);
        if ((message as { stage?: string }).stage === "uncommitted-write") resolve();
        else reject(new Error("Unexpected crash checkpoint"));
      });
      child!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Crash fixture exited before checkpoint: " + errors));
      });
      child!.once("error", error => { clearTimeout(timer); reject(error); });
    });
    const exited = once(child, "exit");
    expect(child.kill("SIGKILL")).toBe(true);
    await exited;

    stores = openStores(path);
    expect(stores.memory.get(note.id)?.text).toBe(committedText);
    expect(stores.memory.list()).toHaveLength(1);
    expect((await stores.cache.getContent("https://fixture.invalid/redis"))?.content).toBe("Redis cache guide");
    expect((await stores.cache.search(vector, 1))[0]?.id).toBe("fixture-vector");
    expect((await stores.index.search("Redis")).some(hit => hit.source === "fixture:redis")).toBe(true);
    expect(stores.graph.docsForEntity("Redis").some(row => row.docId === doc.id)).toBe(true);
    const probe = new Database(path);
    try { expect(probe.pragma("integrity_check", { simple: true })).toBe("ok"); }
    finally { probe.close(); }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    if (stores) Object.values(stores).forEach(store => store.close());
    removeFixture(directory);
  }
}, 25000);

it("keeps the shared file in WAL mode as each store opens and reopens", () => {
  const directory = mkdtempSync(join(tmpdir(), "search-memory-journal-"));
  const path = join(directory, "fixture.db");
  const stores: Array<{ close(): void }> = [];
  const factories = [
    () => new SQLiteVectorStore(path),
    () => new KnowledgeIndex(path, { enableEmbeddings: false }),
    () => new SessionMemory(path),
    () => new EntityGraph(path),
  ];
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const create of factories) {
        stores.push(create());
        const probe = new Database(path);
        try { expect(probe.pragma("journal_mode", { simple: true })).toBe("wal"); }
        finally { probe.close(); }
      }
      stores.splice(0).forEach(store => store.close());
    }
  } finally {
    stores.forEach(store => store.close());
    removeFixture(directory);
  }
});
