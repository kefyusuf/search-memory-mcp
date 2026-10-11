import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns, lookup as systemLookup, type LookupAddress } from "node:dns";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { startBrowserEgressProxy, type BrowserEgressProxy } from "../security/browser-egress-proxy.js";

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
