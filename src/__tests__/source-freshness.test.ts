import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { SQLiteVectorStore } from "../cache/sqlite-store.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { ContentFetcher } from "../fetch-module.js";
import { extractDocument } from "../documents/extract.js";
import { normalizePublishedDate } from "../documents/dates.js";
import { InMemoryVectorStore } from "./helpers.js";
import { pdf } from "./document-fixtures.js";

const ARTICLE = (meta: string) => `<!DOCTYPE html><html><head><title>Pooling guide</title>${meta}</head><body><article>
<h1>Pooling guide</h1>${"<p>PgBouncer keeps a small pool of server connections and hands them to many clients. ".repeat(8)}</p>
</article></body></html>`;

describe("normalizePublishedDate", () => {
  it.each([
    ["2024-01-15T10:00:00Z", "2024-01-15"],
    ["2024-01-15", "2024-01-15"],
    ["D:20240115120000Z", "2024-01-15"],
    ["D:20230301", "2023-03-01"],
    ["not a date", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePublishedDate(input)).toBe(expected);
  });
});

describe("PDF publication date", () => {
  it("comes from the document creation date", async () => {
    const result = await extractDocument({ data: pdf("text", "<< /Title (Dated) /CreationDate (D:20240115120000Z) >>") });
    expect(result.publishedAt).toBe("2024-01-15");
  });
});

describe("SQLite content cache", () => {
  it("stores the publication date with the cached page", async () => {
    const store = new SQLiteVectorStore(":memory:", { useNativeVectors: false });
    await store.setContent("https://a.example", "text", "general", "2024-01-15");
    expect(await store.getContent("https://a.example")).toMatchObject({ content: "text", publishedAt: "2024-01-15" });
    await store.setContent("https://b.example", "text", "general");
    expect((await store.getContent("https://b.example"))?.publishedAt ?? null).toBeNull();
    store.close();
  });

  it("adds the column to a database created before it existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "smm-cache-"));
    const path = join(dir, "cache.db");
    const db = new Database(path);
    db.exec(`CREATE TABLE content_cache (
      execution_mode TEXT NOT NULL, tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      url TEXT NOT NULL, content TEXT NOT NULL, category TEXT NOT NULL, timestamp INTEGER NOT NULL,
      PRIMARY KEY (execution_mode, tenant_id, workspace_id, url));
      INSERT INTO content_cache VALUES ('local','local','local','https://old.example','old text','general',1);`);
    db.close();
    const store = new SQLiteVectorStore(path, { useNativeVectors: false });
    expect(await store.getContent("https://old.example")).toMatchObject({ content: "old text", publishedAt: null });
    await store.setContent("https://new.example", "new", "general", "2025-02-02");
    expect((await store.getContent("https://new.example"))?.publishedAt).toBe("2025-02-02");
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("ContentFetcher dates", () => {
  beforeEach(() => {
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  function fetcher() {
    const cache = new SemanticCache({ getEmbedding: async () => [], isAvailable: () => false }, new InMemoryVectorStore());
    return new ContentFetcher({ cache, getBrowserContext: async () => ({}) as BrowserContext, fetchWaitUntil: "networkidle" });
  }

  it("returns the page's publication date and when it was fetched, also from the cache", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-09T08:00:00Z"), toFake: ["Date"] });
    const instance = fetcher();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ARTICLE('<meta property="article:published_time" content="2024-03-05T09:00:00Z">'), { status: 200, headers: { "content-type": "text/html" } })));
    const first = await instance.fetchContent("https://guide.example/pooling");
    expect(first).toMatchObject({ kind: "content", source: "http", publishedAt: "2024-03-05", fetchedAt: "2026-10-09T08:00:00.000Z" });

    vi.setSystemTime(new Date("2026-10-09T09:30:00Z"));
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("should use cache"); }));
    const cached = await instance.fetchContent("https://guide.example/pooling");
    expect(cached).toMatchObject({ kind: "content", source: "content-cache", publishedAt: "2024-03-05", fetchedAt: "2026-10-09T08:00:00.000Z" });
  });

  it("leaves the publication date out when the page has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ARTICLE(""), { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetcher().fetchContent("https://guide.example/undated");
    expect(result.kind === "content" && result.publishedAt).toBeUndefined();
    expect(result.kind === "content" && result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
