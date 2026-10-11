import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns, lookup as systemLookup, type LookupAddress } from "node:dns";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import type { Browser, BrowserContext } from "playwright";
import { openGuardedBrowserContext, startBrowserEgressProxy, type BrowserEgressProxy } from "../security/browser-egress-proxy.js";

function fakeResolver(records: LookupAddress[]): typeof systemLookup {
  return ((_host: string, _opts: unknown, cb: (err: NodeJS.ErrnoException | null, records: LookupAddress[]) => void) => {
    queueMicrotask(() => cb(null, records));
  }) as typeof systemLookup;
}

async function proxyGet(proxy: BrowserEgressProxy, targetUrl: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    const req = httpRequest({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port),
      path: targetUrl,
      method: "GET",
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function proxyConnect(proxy: BrowserEgressProxy, authority: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxy.url);
    const socket = netConnect({ host: "127.0.0.1", port: Number(proxyUrl.port) });
    let received = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("CONNECT timed out")));
    socket.once("error", reject);
    socket.on("data", (data: Buffer) => {
      received += data.toString("latin1");
      if (received.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.once("connect", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    socket.once("end", () => {
      if (!received.includes("\r\n\r\n")) reject(new Error("Proxy terminated CONNECT without response"));
    });
  });
}

describe("browser outbound proxy (core only, not yet wired into Chromium)", () => {
  let proxy: BrowserEgressProxy | undefined;

  beforeEach(() => {
    // Public-looking Node precheck for reserved host. Connected-peer resolution
    // below is injected separately and returns the unsafe loopback destination.
    vi.spyOn(dns, "resolve4").mockResolvedValue(["8.8.8.8"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(async () => {
    if (proxy) await proxy.close();
    proxy = undefined;
    vi.restoreAllMocks();
  });

  it("binds to local loopback and refuses direct private HTTP URLs", async () => {
    proxy = await startBrowserEgressProxy();
    expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
    expect((await proxyGet(proxy, "http://127.0.0.1:1234/private")).status).toBe(403);
    expect((await proxyGet(proxy, "http://[::1]:1234/private")).status).toBe(403);
    expect((await proxyGet(proxy, "file:///etc/passwd")).status).toBe(403);
    expect((await proxyGet(proxy, "/relative-path")).status).toBe(403);
  });

  it("rejects a DNS rebinding destination before opening any HTTP socket", async () => {
    const destination = createServer((_request, response) => response.end("private"));
    let connects = 0;
    destination.on("connection", () => { connects += 1; });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const port = (destination.address() as AddressInfo).port;

    try {
      proxy = await startBrowserEgressProxy(fakeResolver([{ address: "127.0.0.1", family: 4 }]));
      const result = await proxyGet(proxy, `http://browser-egress-probe.invalid:${port}/private`);
      expect(result.status).toBe(403);
      expect(connects).toBe(0);
    } finally {
      await new Promise<void>((resolve) => destination.close(resolve));
    }
  });

  it("rejects mixed public/private DNS results at the socket boundary", async () => {
    proxy = await startBrowserEgressProxy(fakeResolver([
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]));
    const result = await proxyGet(proxy, "http://browser-egress-probe.invalid:81/private");
    expect(result.status).toBe(403);
  });

  it("rejects HTTPS CONNECT to a private literal or a rebinding hostname", async () => {
    proxy = await startBrowserEgressProxy(fakeResolver([{ address: "127.0.0.1", family: 4 }]));
    expect(await proxyConnect(proxy, "127.0.0.1:443")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "[::1]:443")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "browser-egress-probe.invalid:443")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "browser-egress-probe.invalid:80")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "browser-egress-probe.invalid:65536")).toContain("403 Denied");
  });

  it("enforces the CONNECT authority-form syntax", async () => {
    proxy = await startBrowserEgressProxy();
    expect(await proxyConnect(proxy, "browser-egress-probe.invalid")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "user@browser-egress-probe.invalid:443")).toContain("403 Denied");
    expect(await proxyConnect(proxy, "browser-egress-probe.invalid:443/path")).toContain("403 Denied");
  });

  it("configures production Chromium context with mandatory proxy and blocked service workers", async () => {
    const fakeContext = { close: vi.fn() } as unknown as BrowserContext;
    const newContext = vi.fn(async (_opts: unknown) => fakeContext);
    const browser = { newContext } as unknown as Pick<Browser, "newContext">;

    const opened = await openGuardedBrowserContext(browser, { userAgent: "Security fixture" });
    try {
      expect(opened.context).toBe(fakeContext);
      expect(newContext).toHaveBeenCalledTimes(1);
      const options = newContext.mock.calls[0][0] as {
        userAgent: string; serviceWorkers: string;
        proxy: { server: string; bypass: string };
      };
      expect(options.userAgent).toBe("Security fixture");
      expect(options.serviceWorkers).toBe("block");
      expect(options.proxy.server).toBe(opened.proxy.url);
      expect(options.proxy.bypass).toBe("<-loopback>");
      expect(new URL(options.proxy.server).hostname).toBe("127.0.0.1");
    } finally {
      await opened.proxy.close();
    }
  });

  it("closes proxy and propagates error when a browser context cannot start", async () => {
    let proxyUrl = "";
    const browser = {
      newContext: async (options: { proxy?: { server?: string } }) => {
        proxyUrl = options.proxy?.server ?? "";
        throw new Error("browser context denied");
      },
    } as unknown as Pick<Browser, "newContext">;
    await expect(openGuardedBrowserContext(browser)).rejects.toThrow("browser context denied");
    expect(proxyUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const port = Number(new URL(proxyUrl).port);
    await expect(new Promise((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve("unexpected proxy still listening"); });
      socket.once("error", reject);
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("stops listening and cannot serve new proxy requests after close", async () => {
    proxy = await startBrowserEgressProxy();
    const url = proxy.url;
    await proxy.close();
    proxy = undefined;
    const direct = new URL(url);
    await expect(new Promise((resolve, reject) => {
      const socket = netConnect({ host: "127.0.0.1", port: Number(direct.port) });
      socket.once("connect", () => { socket.destroy(); resolve("connected"); });
      socket.once("error", reject);
    })).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });
});
