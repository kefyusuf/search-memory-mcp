// P0-03C EXPERIMENT ONLY: real Chromium CDP response-stream semantics.
// Local fixture WITHOUT production guarded egress proxy. Not production proof.
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { chromium, type CDPSession, type Page } from "playwright";
import { openGuardedBrowserContext } from "../security/browser-egress-proxy.js";
import { describe, expect, it } from "vitest";

const LIMIT = 256;
const SMALL = "<html><title>Small</title><body>SAFE-SMALL</body></html>";
const LARGE = "<html><title>Large</title><body>" + "x".repeat(8192) + "</body></html>";
type Paused = { requestId: string; resourceType: string; responseStatusCode?: number; responseHeaders?: { name: string; value: string }[] };
type Result = { path: string; paused: number; streamed: boolean; bytes: number; chunkMax: number; exceeded: boolean; failed: boolean; fulfilled: boolean; content: string; navigated: boolean; httpStatus?: number; errors: string[] };

async function testPage(page: Page, session: CDPSession, url: string, path: string, budget = LIMIT): Promise<Result> {
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
        if (x.bytes > budget) {
          x.exceeded = true;
          await session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" });
          x.failed = true;
          return;
        }
        chunks.push(b);
        if (r.eof) break;
      }
      // Re-supply ONLY in-budget responses. The CDP stream cannot resume as-is.
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
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
    x.httpStatus = response?.status();
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

  it("probes CDP streaming alongside the production guarded HTTPS context and private-redirect policy", async () => {
    let privateConnections = 0;
    let privateRequests = 0;
    const privateServer = createServer((_req, res) => {
      privateRequests++;
      res.end("PRIVATE_DESTINATION_MUST_NEVER_BE_READ");
    });
    privateServer.on("connection", () => { privateConnections++; });
    await new Promise<void>(resolve => privateServer.listen(0, "127.0.0.1", resolve));
    const privatePort = (privateServer.address() as AddressInfo).port;
    const privateUrl = "http://127.0.0.1:" + privatePort + "/private-redirect";
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let opened: Awaited<ReturnType<typeof openGuardedBrowserContext>> | undefined;
    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-quic",
          "--disable-background-networking",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
      // EXACT production context factory: keep loopback proxy bypass override,
      // public-IP connected-address checks, TLS, and blocked service workers.
      opened = await openGuardedBrowserContext(browser);
      const context = opened.context;

      const safePage = await context.newPage();
      let allowedRouteCount = 0;
      await safePage.route("**/*", async route => {
        allowedRouteCount++;
        await route.continue();
      });
      const safeSession = await context.newCDPSession(safePage);
      try {
        const safe = await testPage(safePage, safeSession, "https://example.com/", "guarded-https", 16 * 1024);
        console.log("P0_03C_GUARDED_HTTPS", JSON.stringify(safe));
        expect(allowedRouteCount).toBeGreaterThan(0);
        expect(safe.streamed).toBe(true);
        expect(safe.fulfilled).toBe(true);
        expect(safe.exceeded).toBe(false);
        expect(safe.navigated).toBe(true);
        expect(safe.httpStatus).toBe(200);
        expect(new URL(safePage.url()).hostname).toBe("example.com");
        expect(safe.content.trim().length).toBeGreaterThan(30);
        expect(safe.bytes).toBeGreaterThan(0);
        expect(safe.bytes).toBeLessThanOrEqual(16 * 1024);
      } finally {
        await safeSession.detach().catch(() => {});
        await safePage.close().catch(() => {});
      }

      const redirectPage = await context.newPage();
      const routeUrls: string[] = [];
      await redirectPage.route("**/*", async route => {
        routeUrls.push(route.request().url());
        await route.continue();
      });
      // As in the existing egress acceptance script: a synthesized initial
      // public 302 must NOT make the private target reachable by Chromium.
      await redirectPage.route("https://safe-redirect.invalid/start", async route => {
        await route.fulfill({ status: 302, headers: { location: privateUrl }, body: "" });
      });
      const redirectSession = await context.newCDPSession(redirectPage);
      try {
        const redirected = await testPage(redirectPage, redirectSession,
          "https://safe-redirect.invalid/start", "guarded-private-redirect", 16 * 1024);
        console.log("P0_03C_GUARDED_PRIVATE_REDIRECT", JSON.stringify({
          ...redirected, routeUrls, privateConnections, privateRequests,
        }));
        expect(routeUrls).toContain(privateUrl);
        expect(privateConnections).toBe(0);
        expect(privateRequests).toBe(0);
        expect(redirected.content).not.toContain("PRIVATE_DESTINATION_MUST_NEVER_BE_READ");
        expect(redirected.httpStatus).toBe(403);
      } finally {
        await redirectSession.detach().catch(() => {});
        await redirectPage.close().catch(() => {});
      }
    } finally {
      if (opened) {
        await opened.context.close().catch(() => {});
        await opened.proxy.close().catch(() => {});
      }
      if (browser) await browser.close().catch(() => {});
      await new Promise<void>(resolve => privateServer.close(() => resolve()));
    }
  }, 90_000);
});
