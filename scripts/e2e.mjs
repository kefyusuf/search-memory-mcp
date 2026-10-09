#!/usr/bin/env node
/**
 * End-to-end scenario against the compiled server over stdio, through the MCP SDK client
 * (which also validates structured output against each tool's outputSchema).
 *
 * Local steps (memory, local files, knowledge base, entity graph) must pass anywhere.
 * Web steps need internet access; when web search is unavailable they are reported as SKIP.
 *
 * Usage: npm run build && npm run e2e
 * Exit code is 1 when any step fails.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { strToU8, zipSync } from "fflate";

const WEB_TIMEOUT_MS = 120_000;
const root = mkdtempSync(join(tmpdir(), "search-memory-e2e-"));
const docs = join(root, "docs");
mkdirSync(docs);

function pdf(text, info) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    info,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(body);
}

writeFileSync(join(docs, "pooling.pdf"), pdf("PgBouncer pools PostgreSQL connections for Kubernetes services", "<< /Title (Pooling handbook) /CreationDate (D:20240115120000Z) >>"));
writeFileSync(join(docs, "notes.docx"), zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
  "word/document.xml": strToU8('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Transaction pooling lets many clients share a few server connections.</w:t></w:r></w:p></w:body></w:document>'),
}));
writeFileSync(join(docs, ".env"), "SECRET=should-never-be-read");
writeFileSync(join(root, "outside.txt"), "outside the allowed directory");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["build/index.js"],
  env: {
    ...process.env,
    CACHE_DB_PATH: join(root, "e2e.db"),
    INGEST_ALLOWED_DIRS: docs,
    SEARCH_PROVIDERS: process.env.SEARCH_PROVIDERS ?? "duckduckgo,marginalia,bing",
    ENABLE_CROSSLINGUAL: "false",
  },
  stderr: "ignore",
});
const client = new Client({ name: "search-memory-e2e", version: "1.0.0" });

const results = [];
const text = (result) => result.content?.[0]?.text ?? "";
async function call(name, args, timeout = 60_000) {
  return client.callTool({ name, arguments: args }, undefined, { timeout });
}
async function step(name, run) {
  const started = Date.now();
  try {
    const outcome = await run();
    results.push({ name, status: outcome?.skip ? "SKIP" : "PASS", detail: outcome?.skip ?? outcome?.detail ?? "", ms: Date.now() - started });
  } catch (error) {
    results.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await client.connect(transport);

  await step("tools/list: 12 tools with annotations", async () => {
    const { tools } = await client.listTools();
    expect(tools.length === 12, `expected 12 tools, got ${tools.length}`);
    expect(tools.every((tool) => tool.annotations?.title), "a tool has no annotations");
    return { detail: tools.map((tool) => tool.name).join(", ") };
  });

  await step("server_status", async () => {
    const result = await call("server_status", {});
    expect(Array.isArray(result.structuredContent?.providers), "no providers in status");
    return { detail: `providers: ${result.structuredContent.config.searchProviders.join(", ")}` };
  });

  await step("remember / recall / forget", async () => {
    const saved = await call("remember", { text: "The e2e user prefers PostgreSQL", topic: "prefs" });
    const id = /id=([^,]+)/.exec(text(saved))?.[1];
    expect(id, `remember failed: ${text(saved)}`);
    expect(text(await call("recall", { query: "PostgreSQL" })).includes(id), "recall did not find the note");
    expect(text(await call("forget", { id })) === `Deleted note ${id}`, "forget failed");
    expect(!text(await call("recall", { query: "PostgreSQL" })).includes(id), "note still recalled after forget");
  });

  await step("ingest_document: text content", async () => {
    const result = await call("ingest_document", { content: "Kubernetes runs PgBouncer as a sidecar.", title: "Sidecar note", source: "e2e-note" });
    expect(!result.isError, text(result));
  });

  await step("ingest_document: local PDF with title", async () => {
    const result = await call("ingest_document", { path: join(docs, "pooling.pdf") });
    expect(!result.isError && text(result).includes('"Pooling handbook"'), text(result));
  });

  await step("ingest_document: local DOCX", async () => {
    const result = await call("ingest_document", { path: join(docs, "notes.docx") });
    expect(!result.isError, text(result));
  });

  await step("ingest_document: refuses hidden and outside files", async () => {
    const hidden = await call("ingest_document", { path: join(docs, ".env") });
    const outside = await call("ingest_document", { path: join(root, "outside.txt") });
    expect(hidden.isError && text(hidden).includes("hidden"), `hidden file not refused: ${text(hidden)}`);
    expect(outside.isError && text(outside).includes("outside"), `outside file not refused: ${text(outside)}`);
  });

  await step("list_index", async () => {
    const result = await call("list_index", {});
    expect(/Knowledge index: 3 docs/.test(text(result)), text(result).split("\n")[0]);
  });

  await step("search_index: finds PDF text", async () => {
    const result = await call("search_index", { query: "PgBouncer PostgreSQL connections" });
    const hits = result.structuredContent?.hits ?? [];
    expect(hits.some((hit) => hit.title === "Pooling handbook"), `hits: ${hits.map((hit) => hit.title).join(", ")}`);
    return { detail: `${hits.length} hits` };
  });

  await step("find_related: entity graph", async () => {
    const result = await call("find_related", { entity: "PgBouncer" });
    expect(text(result).includes("Documents:"), text(result));
  });

  let webAvailable = false;
  await step("web_search", async () => {
    const result = await call("web_search", { query: "Node.js release schedule" }, WEB_TIMEOUT_MS);
    const attempts = result.structuredContent?.providerAttempts ?? [];
    if (result.isError) return { skip: `web search unavailable: ${text(result).slice(0, 160)}` };
    expect((result.structuredContent?.resultCount ?? 0) > 0, "no results");
    webAvailable = true;
    return { detail: attempts.map((attempt) => `${attempt.provider}:${attempt.status}`).join(" ") };
  });

  const webStep = (name, run) => step(name, async () => (webAvailable ? run() : { skip: "web search unavailable" }));

  await webStep("fetch_content: HTML page", async () => {
    const result = await call("fetch_content", { url: "https://nodejs.org/en/about" }, WEB_TIMEOUT_MS);
    expect(!result.isError && text(result).length > 200, text(result).slice(0, 160));
  });

  await webStep("index_url: PDF link", async () => {
    const result = await call("index_url", { url: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf" }, WEB_TIMEOUT_MS);
    expect(!result.isError, text(result).slice(0, 160));
  });

  await webStep("research: cited answer with dates", async () => {
    const result = await call("research", { query: "What is the Node.js release schedule?", max_sources: 2 }, WEB_TIMEOUT_MS);
    const sources = result.structuredContent?.sources ?? [];
    expect(!result.isError && sources.length > 0, text(result).slice(0, 200));
    expect(sources.filter((source) => source.origin === "web" && source.status !== "fetch_failed").every((source) => source.fetchedAt), "web source without fetchedAt");
    return { detail: `${sources.length} sources, ${result.structuredContent.indexedCount} indexed` };
  });
} finally {
  await client.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}

const width = Math.max(...results.map((result) => result.name.length));
for (const result of results) {
  console.log(`${result.status.padEnd(4)}  ${result.name.padEnd(width)}  ${String(result.ms).padStart(6)} ms  ${result.detail}`);
}
const failed = results.filter((result) => result.status === "FAIL").length;
const skipped = results.filter((result) => result.status === "SKIP").length;
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
