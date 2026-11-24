import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as dns, type lookup as systemLookup, type LookupAddress } from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import {
  BlockedFetchUrlError,
  createGuardedHttpFetcher,
  guardedHttpFetch,
  isGuardedFetchRejection,
} from "../security/guarded-fetch.js";

// Transport seam is undici's fetch export; Agent stays real for instanceof checks.
const undiciFetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: undiciFetchMock };
});

describe("guarded outbound HTTP fetch", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("undici")>("undici");
    undiciFetchMock.mockReset();
    undiciFetchMock.mockImplementation(actual.fetch);
    vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
    vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses a per-request dispatcher while retaining the URL and headers", async () => {
    const mock = vi.fn().mockResolvedValue(new Response("ok"));
    undiciFetchMock.mockImplementation(mock);

    await guardedHttpFetch("https://example.com/test", {
      headers: { Accept: "text/html" },
      redirect: "follow",
    });
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0];
    expect(url).toBe("https://example.com/test");
    expect(init.headers).toEqual({ Accept: "text/html" });
    expect(init.redirect).toBe("manual");
    expect(init.dispatcher).toBeInstanceOf(Agent);
  });

  it("rejects non-public literals and unsupported protocols before fetch", async () => {
    const mock = vi.fn();
    undiciFetchMock.mockImplementation(mock);
    for (const url of [
      "http://127.0.0.1/admin",
      "https://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://169.254.169.254/latest/meta-data",
      "http://[::]/",
      "https://[2001:db8::1]/",
      "http://198.51.100.1/",
      "file:///etc/passwd",
    ]) {
      await expect(guardedHttpFetch(url)).rejects.toBeInstanceOf(BlockedFetchUrlError);
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it("stops a real Undici socket when DNS returns a private peer after public precheck", async () => {
    const server = createServer((_req, response) => response.end("should never connect"));
    let sockets = 0;
    server.on("connection", () => {
      sockets += 1;
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // URL validation sees a benign public DNS result; connection-time lookup
    // rebinds that hostname to a local IP. No TCP socket may reach the fixture.
    const resolver = ((
      _name: string,
      _options: unknown,
      cb: (error: NodeJS.ErrnoException | null, records: LookupAddress[]) => void,
    ) => queueMicrotask(() => cb(null, [{ address: "127.0.0.1", family: 4 }]))) as typeof systemLookup;
    const safeFetch = createGuardedHttpFetcher(resolver);

    try {
      const error = await safeFetch(`http://rebinding.example:${port}/secret`, {
        signal: AbortSignal.timeout(2500),
      }).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      // A real Undici/Node socket-policy denial must be classified as blocked
      // so the caller cannot retry the URL through the browser fallback.
      expect(isGuardedFetchRejection(error)).toBe(true);
      expect(sockets).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("checks DNS again at the transport boundary after a previous public result", async () => {
    const mock = vi.fn();
    undiciFetchMock.mockImplementation(mock);
    vi.mocked(dns.resolve4)
      .mockResolvedValueOnce(["93.184.216.34"] as never)
      .mockResolvedValueOnce(["127.0.0.1"] as never);

    // A previous unrelated public DNS result must not act as authorization.
    await guardedHttpFetch("https://example.com/first");
    await expect(guardedHttpFetch("https://example.com/second")).rejects.toBeInstanceOf(BlockedFetchUrlError);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
