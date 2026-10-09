import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllowedDirs, readLocalDocument } from "../documents/local-files.js";
import { createKnowledgeHandlers } from "../tools/knowledge.js";
import { KnowledgeIndex } from "../knowledge/index-store.js";
import { EntityGraph } from "../graph/entity-graph.js";
import { TokenBucket } from "../rate-limiter.js";
import { docx } from "./document-fixtures.js";

let root: string;
let allowed: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "smm-local-"));
  allowed = join(root, "docs");
  outside = join(root, "private");
  mkdirSync(join(allowed, "sub"), { recursive: true });
  mkdirSync(join(allowed, ".secret"));
  mkdirSync(outside);
  writeFileSync(join(allowed, "notes.md"), "# Notes\n\nPgBouncer pools connections.");
  writeFileSync(join(allowed, "sub", "report.docx"), docx(["Quarterly pooling report."], "Report"));
  writeFileSync(join(allowed, ".env"), "TOKEN=secret");
  writeFileSync(join(allowed, ".secret", "key.txt"), "secret");
  writeFileSync(join(outside, "id_rsa"), "secret");
  symlinkSync(join(outside, "id_rsa"), join(allowed, "link.txt"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("parseAllowedDirs", () => {
  it("splits on commas, trims, expands ~ and drops empty entries", () => {
    expect(parseAllowedDirs(undefined)).toEqual([]);
    expect(parseAllowedDirs(" ,  ")).toEqual([]);
    expect(parseAllowedDirs(`${allowed}, ~/Documents`, "/home/me")).toEqual([allowed, "/home/me/Documents"]);
  });
});

describe("readLocalDocument", () => {
  it("reads text and DOCX files inside an allowed directory", async () => {
    await expect(readLocalDocument(join(allowed, "notes.md"), { allowedDirs: [allowed] }))
      .resolves.toMatchObject({ format: "text", text: "# Notes\n\nPgBouncer pools connections." });
    await expect(readLocalDocument(join(allowed, "sub", "report.docx"), { allowedDirs: [allowed] }))
      .resolves.toMatchObject({ format: "docx", title: "Report", text: "Quarterly pooling report." });
  });

  it.each([
    ["reading is disabled", () => join(allowed, "notes.md"), () => [] as string[], "disabled"],
    ["the file is outside every allowed directory", () => join(outside, "id_rsa"), () => [allowed], "outside"],
    ["a relative path climbs out", () => join(allowed, "..", "private", "id_rsa"), () => [allowed], "outside"],
    ["a symlink points outside", () => join(allowed, "link.txt"), () => [allowed], "outside"],
    ["the file is hidden", () => join(allowed, ".env"), () => [allowed], "hidden"],
    ["a parent folder is hidden", () => join(allowed, ".secret", "key.txt"), () => [allowed], "hidden"],
    ["the path is a directory", () => join(allowed, "sub"), () => [allowed], "not_a_file"],
    ["the file does not exist", () => join(allowed, "missing.md"), () => [allowed], "not_found"],
  ])("refuses when %s", async (_label, path, dirs, code) => {
    await expect(readLocalDocument(path(), { allowedDirs: dirs() })).rejects.toMatchObject({ code });
  });

  it("refuses files above the size limit before reading them", async () => {
    await expect(readLocalDocument(join(allowed, "notes.md"), { allowedDirs: [allowed], maxBytes: 10 }))
      .rejects.toMatchObject({ code: "too_large" });
  });
});

describe("ingest_document with a path", () => {
  function tools(allowedDirs: string[]) {
    const knowledgeIndex = new KnowledgeIndex(":memory:", { enableEmbeddings: false });
    const entityGraph = new EntityGraph(":memory:");
    const handlers = createKnowledgeHandlers({
      knowledgeIndex, entityGraph, embed: async () => [],
      fetchContent: async () => ({ kind: "error", reason: "fetch_failed" }),
      fetchLimiter: new TokenBucket({ maxTokens: 1, refillRatePerSecond: 0 }),
      allowedDirs: () => allowedDirs,
    });
    return { handlers, knowledgeIndex, close: () => { knowledgeIndex.close(); entityGraph.close(); } };
  }

  it("indexes an allowed file with its real path as the source", async () => {
    const { handlers, knowledgeIndex, close } = tools([allowed]);
    const result = await handlers.ingest_document({ path: join(allowed, "sub", "report.docx") });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^Indexed document "Report"/);
    expect(knowledgeIndex.listDocs()[0]).toMatchObject({ title: "Report", category: "file" });
    expect(knowledgeIndex.listDocs()[0].source.endsWith(join("docs", "sub", "report.docx"))).toBe(true);
    close();
  });

  it("explains how to enable reading when it is disabled", async () => {
    const { handlers, close } = tools([]);
    const result = await handlers.ingest_document({ path: join(allowed, "notes.md") });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INGEST_ALLOWED_DIRS");
    close();
  });

  it("requires exactly one of content and path", async () => {
    const { handlers, close } = tools([allowed]);
    expect((await handlers.ingest_document({})).isError).toBe(true);
    expect((await handlers.ingest_document({ content: "x", path: join(allowed, "notes.md") })).isError).toBe(true);
    expect((await handlers.ingest_document({ content: "plain text still works" })).isError).toBeUndefined();
    close();
  });
});
