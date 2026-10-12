// P0-03C EXPERIMENT ONLY: real Chromium CDP response-stream semantics.
// Local fixture WITHOUT production guarded egress proxy. Not production proof.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { chromium, type CDPSession, type Page } from "playwright";
import { describe, expect, it } from "vitest";

const LIMIT = 256;
const SMALL = "<html><title>Small</title><body>SAFE-SMALL</body></html>";
const LARGE = "<html><title>Large</title><body>" + "x".repeat(8192) + "</body></html>";
type Paused = { requestId: string; resourceType: string; responseStatusCode?: number; responseHeaders?: { name: string; value: string }[] };
type Result = { path: string; paused: number; streamed: boolean; bytes: number; chunkMax: number; exceeded: boolean; failed: boolean; fulfilled: boolean; content: string; navigated: boolean; errors: string[] };

async function testPage(page: Page, session: CDPSession, url: string, path: string): Promise<Result> {
  const x: Result = { path, paused: 0, streamed: false, bytes: 0, chunkMax: 0, exceeded: false, failed: false, fulfilled: false, content: "", navigated: false, errors: [] };
  const work = new Set<Promise<void>>();
  async function onPause(e: Paused) {
    let handle: string | undefined;
    try {
      x.paused++;
      // CDP response bodies are unavailable for redirects; ignore subresources.
      if (!e.responseStatusCode || e.resourceType !== "Document" || (e.responseStatusCode >= 300 && e.responseStatusCode < 400)) {
        await session.send("Fetch.continueResponse", { requestId: e.requestId });
        return;
      }
      handle = (await session.send("Fetch.takeResponseBodyAsStream", { requestId: e.requestId })).stream;
      x.streamed = true;
      const chunks: Buffer[] = [];
      for (let n = 0; n < 400; n++) {
        const r = await session.send("IO.read", { handle, size: 64 });
        const b = Buffer.from(r.data, r.base64Encoded ? "base64" : "utf8");
        x.bytes += b.byteLength;
        x.chunkMax = Math.max(x.chunkMax, b.byteLength);
        if (x.bytes > LIMIT) {
          x.exceeded = true;
          await session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
          x.failed = true;
          return;
        }
        chunks.push(b);
        if (r.eof) break;
      }
      // Re-supply ONLY <=LIMIT responses. The CDP stream cannot resume as-is.
      const body = Buffer.concat(chunks);
      const headers = (e.responseHeaders ?? []).filter(h => !["content-length", "content-encoding", "transfer-encoding"].includes(h.name.toLowerCase()));
      headers.push({ name: "content-length", value: String(body.byteLength) });
      await session.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: e.responseStatusCode, responseHeaders: headers, body: body.toString("base64") });
      x.fulfilled = true;
    } catch (err) {
      x.errors.push(String(err));
      await session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "Failed" }).catch(() => {});
    } finally {
      if (handle) await session.send("IO.close", { handle }).catch(() => {});
    }
  }
  session.on("Fetch.requestPaused", (raw: unknown) => {
    const task = onPause(raw as Paused);
    work.add(task);
    void task.finally(() => work.delete(task));
  });
  await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    x.navigated = true;
    x.content = await page.locator("body").innerText();
  } catch (err) { x.errors.push(String(err).slice(0, 230)); }
  await Promise.allSettled([...work]);
  await session.send("Fetch.disable").catch(() => {});
  return x;
}

describe("P0-03C experimental CDP early body budget (not production integration)", () => {
  it("probes real Chromium plain, gzip, chunked and redirect responses", async () => {
    const server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/redirect") { res.writeHead(302, { location: "/small" }); res.end(); return; }
      const large = path.includes("large"), zip = path.includes("gzip"), chunked = path.includes("chunked");
      const data = Buffer.from(large ? LARGE : SMALL);
      const bytes = zip ? gzipSync(data) : data;
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (zip) res.setHeader("content-encoding", "gzip");
      if (!chunked) res.setHeader("content-length", String(bytes.byteLength));
      res.writeHead(200);
      if (chunked) {
        for (let i = 0; i < bytes.byteLength; i += 45) res.write(bytes.subarray(i, i + 45));
        res.end();
      } else res.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const results: Result[] = [];
    try {
      browser = await chromium.launch({ headless: true, args: ["--disable-quic", "--disable-background-networking"] });
      for (const path of ["/small", "/large-chunked", "/small-gzip", "/large-gzip-chunked", "/redirect"]) {
        const context = await browser.newContext({ serviceWorkers: "block" });
        try {
          const page = await context.newPage();
          const session = await context.newCDPSession(page);
          results.push(await testPage(page, session, origin + path, path));
          await session.detach();
        } finally { await context.close(); }
      }
      console.log("P0_03C_CHROMIUM_SPIKE", JSON.stringify(results));
      for (const x of results) {
        const over = x.path.includes("large");
        expect(x.streamed, x.path + " must take CDP stream").toBe(true);
        expect(x.paused, x.path + " must intercept response").toBeGreaterThan(0);
        expect(x.chunkMax, x.path + " per-read bytes").toBeLessThanOrEqual(64);
        expect(x.exceeded, x.path + " actual body boundary").toBe(over);
        if (over) {
          expect(x.failed, x.path + " must abort before buffering whole body").toBe(true);
          expect(x.fulfilled).toBe(false);
          expect(x.navigated).toBe(false);
        } else {
          expect(x.fulfilled).toBe(true);
          expect(x.navigated).toBe(true);
          expect(x.content).toContain("SAFE-SMALL");
        }
      }
    } finally {
      if (browser) await browser.close().catch(() => {});
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 90_000);
});
