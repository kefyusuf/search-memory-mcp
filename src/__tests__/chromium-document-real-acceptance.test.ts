// P0-03C: opt-in real Chromium integration. The local fixture deliberately
// bypasses URL precheck ONLY within this test; production egress stays guarded.
// External HTTPS test uses the unmodified production guarded context factory.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { chromium, type BrowserContext } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentFetcher } from "../fetch-module.js";
import { SemanticCache } from "../cache/semantic-cache.js";
import { InMemoryVectorStore } from "./helpers.js";
import { openGuardedBrowserContext } from "../security/browser-egress-proxy.js";

const BODY = `<html><head><title>Real Chromium Budget</title></head><body><article><p>${"Real renderer acceptance content. ".repeat(90)}</p></article></body></html>`;
const LIMIT = 512;
const UNICODE_BODY = `<html><head><title>Multilingual article</title></head><body><article><p>${"İstanbul — 日本語 — Ελληνικά — 🌍 ".repeat(80)}</p></article></body></html>`;
const RESOURCES_BODY = `<html><head><title>Resource isolation</title><script src="/large-script"></script></head><body><article><p>${"Main document with an external script and an iframe. ".repeat(75)}</p></article><iframe src="/large-iframe"></iframe></body></html>`;

function fetcherFor(context: BrowserContext, budget: number, readerUrl?: string) {
  const cache = new SemanticCache(
    { getEmbedding: async () => new Array(384).fill(0.01), isAvailable: () => true },
    new InMemoryVectorStore(),
  );
  const fetcher = new ContentFetcher({
    cache,
    getBrowserContext: async () => context,
    forcePlaywright: () => true,
    fetchWaitUntil: "domcontentloaded",
    maxHtmlBytes: budget,
    ...(readerUrl ? { readerFallbackUrl: readerUrl } : {}),
  });
  return { fetcher, cache };
}

describe.skipIf(process.env.P0_03C_REAL_BROWSER !== "1")("P0-03C ContentFetcher real Chromium acceptance", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("enforces the main document budget through actual Chromium for plain, chunked, gzip, Brotli and redirect", async () => {
    const web = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/redirect") {
        res.writeHead(302, { location: "/small" }); res.end(); return;
      }
      if (path === "/large-script") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("/* " + "script-data ".repeat(5000) + " */"); return;
      }
      const html = path === "/small"
        ? BODY
        : path === "/unicode"
          ? UNICODE_BODY
          : path === "/with-resources"
            ? RESOURCES_BODY
        : path === "/short"
          ? "<html><title>Small</title><body>plain</body></html>"
          : BODY + "x".repeat(8192);
      const raw = Buffer.from(html);
      const gz = path.includes("gzip");
      const br = path.includes("brotli");
      const chunked = path.includes("chunked");
      const bytes = gz ? gzipSync(raw) : br ? brotliCompressSync(raw) : raw;
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (gz || br) res.setHeader("content-encoding", gz ? "gzip" : "br");
      if (!chunked) res.setHeader("content-length", String(bytes.byteLength));
      res.writeHead(200);
      if (chunked) {
        for (let i = 0; i < bytes.byteLength; i += 96) res.write(bytes.subarray(i, i + 96));
        res.end();
      } else res.end(bytes);
    });
    await new Promise<void>(resolve => web.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
    const browser = await chromium.launch({ headless: true, args: ["--disable-quic", "--disable-background-networking"] });
    try {
      const cases = [
        { path: "/small", budget: Buffer.byteLength(BODY), success: true },
        { path: "/unicode", budget: Buffer.byteLength(UNICODE_BODY), success: true },
        { path: "/with-resources", budget: Buffer.byteLength(RESOURCES_BODY), success: true },
        { path: "/large-chunked", budget: LIMIT, success: false },
        { path: "/large-gzip-chunked", budget: LIMIT, success: false },
        { path: "/large-brotli-chunked", budget: LIMIT, success: false },
        { path: "/redirect", budget: Buffer.byteLength(BODY), success: true },
      ];
      for (const check of cases) {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const { fetcher, cache } = fetcherFor(context, check.budget, "https://markdown.new/");
        // Isolated fixture only: no actual external/private access is attempted.
        // This is NOT a substitute for the guarded context acceptance below.
        vi.spyOn(fetcher as never, "isFetchUrlAllowed" as never).mockResolvedValue(true as never);
        const nodeFetch = vi.fn();
        vi.stubGlobal("fetch", nodeFetch);
        const reader = vi.spyOn(fetcher as never, "fetchViaReader" as never);
        try {
          const result = await fetcher.fetchContent(origin + check.path, true);
          if (check.success) {
            expect(result.kind, check.path).toBe("content");
            if (result.kind === "content") {
              expect(result.source).toBe("playwright");
              if (check.path === "/unicode") expect(result.text).toContain("İstanbul");
              if (check.path === "/with-resources") expect(result.text).toContain("Main document");
            }
          } else {
            expect(result, check.path).toEqual({ kind: "error", reason: "fetch_failed" });
          }
          expect(reader, check.path + " must not invoke reader").not.toHaveBeenCalled();
          expect(nodeFetch, check.path + " must not send alternate HTTP request").not.toHaveBeenCalled();
        } finally {
          fetcher.close(); cache.close();
          await context.close();
          vi.unstubAllGlobals();
          vi.restoreAllMocks();
        }
      }
    } finally {
      await browser.close();
      await new Promise<void>(resolve => web.close(() => resolve()));
    }
  }, 120_000);

  it("retains production guarded HTTPS egress while rejecting an oversized main document without reader fallback", async () => {
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-quic", "--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    });
    let opened: Awaited<ReturnType<typeof openGuardedBrowserContext>> | null = null;
    try {
      opened = await openGuardedBrowserContext(browser);
      const context = opened.context;
      const { fetcher, cache } = fetcherFor(context, 256, "https://markdown.new/");
      const nodeFetch = vi.fn();
      vi.stubGlobal("fetch", nodeFetch);
      const reader = vi.spyOn(fetcher as never, "fetchViaReader" as never);
      try {
        const result = await fetcher.fetchContent("https://example.com/", true);
        expect(result).toEqual({ kind: "error", reason: "fetch_failed" });
        expect(reader).not.toHaveBeenCalled();
        expect(nodeFetch).not.toHaveBeenCalled();
      } finally {
        fetcher.close(); cache.close();
      }
    } finally {
      if (opened) {
        await opened.context.close().catch(() => {});
        await opened.proxy.close().catch(() => {});
      }
      await browser.close();
    }
  }, 120_000);
});
