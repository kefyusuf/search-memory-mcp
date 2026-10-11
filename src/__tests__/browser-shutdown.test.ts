import { afterEach, describe, expect, it, vi } from "vitest";
import { connect as connectSocket } from "node:net";
import type { Browser, BrowserContext } from "playwright";
import { WebSearchServer } from "../index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function proxyIsClosed(url: string): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const { port } = new URL(url);
    const socket = connectSocket({ host: "127.0.0.1", port: Number(port) });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
}

describe("WebSearchServer guarded Chromium shutdown", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("waits for a pending guarded context, then closes its proxy without leaking it", async () => {
    const gate = deferred<BrowserContext>();
    const contextClose = vi.fn(async () => {});
    const context = { close: contextClose } as unknown as BrowserContext;
    let allocatedProxyUrl = "";
    const newContext = vi.fn(async (options: { proxy: { server: string } }) => {
      allocatedProxyUrl = options.proxy.server;
      return await gate.promise;
    });
    const browserClose = vi.fn(async () => {});
    const browser = { newContext, close: browserClose } as unknown as Browser;

    // Prototype-only fixture avoids constructing persistence/embedding systems:
    // this directly exercises the same lifecycle methods used by the server.
    const subject = Object.create(WebSearchServer.prototype) as WebSearchServer & {
      getBrowserContext(): Promise<BrowserContext>;
      closeBrowserResources(): Promise<void>;
      browser: Browser | null;
      browserLaunch: Promise<Browser> | null;
      browserContext: BrowserContext | null;
      browserContextLaunch: Promise<BrowserContext> | null;
      browserShuttingDown: boolean;
      browserEgressProxy: unknown;
    };
    subject.browser = browser;
    subject.browserLaunch = null;
    subject.browserContext = null;
    subject.browserContextLaunch = null;
    subject.browserShuttingDown = false;
    subject.browserEgressProxy = null;

    const pending = subject.getBrowserContext();
    // Avoid unhandled rejection between signal and test's awaited assertion.
    const observedPending = pending.then(
      () => ({ fulfilled: true }),
      (error: Error) => ({ fulfilled: false, message: error.message }),
    );
    await vi.waitFor(() => expect(newContext).toHaveBeenCalledOnce());
    expect(allocatedProxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Simulate shutdown between beginning context allocation and completion.
    const stopping = subject.closeBrowserResources();
    gate.resolve(context);
    await stopping;
    const outcome = await observedPending;
    expect(outcome).toMatchObject({ fulfilled: false, message: "Browser is shutting down" });
    expect(contextClose).toHaveBeenCalledOnce();
    expect(browserClose).toHaveBeenCalledOnce();
    expect(await proxyIsClosed(allocatedProxyUrl)).toBe(true);

    // Later fetches must not start a fresh, unproxied browser context.
    await expect(subject.getBrowserContext()).rejects.toThrow("Browser is shutting down");
    expect(newContext).toHaveBeenCalledOnce();
  });

  it("still closes the browser when in-flight context startup rejects", async () => {
    const browserClose = vi.fn(async () => {});
    const browser = { close: browserClose } as unknown as Browser;
    const gate = deferred<BrowserContext>();
    const subject = Object.create(WebSearchServer.prototype) as WebSearchServer & {
      closeBrowserResources(): Promise<void>;
      browser: Browser | null;
      browserLaunch: Promise<Browser> | null;
      browserContext: BrowserContext | null;
      browserContextLaunch: Promise<BrowserContext> | null;
      browserShuttingDown: boolean;
      browserEgressProxy: unknown;
    };
    subject.browser = browser;
    subject.browserLaunch = null;
    subject.browserContext = null;
    subject.browserEgressProxy = null;
    subject.browserShuttingDown = false;
    subject.browserContextLaunch = gate.promise;
    const stopping = subject.closeBrowserResources();
    gate.reject(new Error("context launch failed"));
    await expect(stopping).resolves.toBeUndefined();
    expect(browserClose).toHaveBeenCalledOnce();
    expect(subject.browserShuttingDown).toBe(true);
  });
});
