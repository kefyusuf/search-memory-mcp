import { afterEach, describe, expect, it, vi } from "vitest";
import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createGuardedLookup, isPublicConnectionAddress } from "../security/guarded-lookup.js";

function fakeResolver(answers: LookupAddress[], error: NodeJS.ErrnoException | null = null): typeof systemLookup {
  return ((_hostname: string, _options: unknown, callback: (err: NodeJS.ErrnoException | null, records: LookupAddress[]) => void) => {
    queueMicrotask(() => callback(error, answers));
  }) as typeof systemLookup;
}

function query(
  answers: LookupAddress[],
  options: { all: boolean; family?: 0 | 4 | 6 } = { all: true },
  error: NodeJS.ErrnoException | null = null,
): Promise<{ error: NodeJS.ErrnoException | null; answer: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    const lookup = createGuardedLookup(fakeResolver(answers, error));
    lookup("rebinding.example", options, (err, answer, family) => resolve({ error: err, answer, family }));
  });
}

describe("guarded socket DNS lookup (not yet integrated with ContentFetcher)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts only publicly routed IPv4 and IPv6 endpoints", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:808:808"]) {
      expect(isPublicConnectionAddress(ip)).toBe(true);
    }
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1",
      "192.168.1.5", "198.18.0.1", "203.0.113.1", "224.0.0.1",
      "255.255.255.255", "::1", "::", "fc00::1", "fe80::1",
      "2001:db8::1", "3fff::1", "2001:2::1", "2001:10::1",
      "2002::1", "::ffff:7f00:1", "::ffff:c0a8:101",
    ]) {
      expect(isPublicConnectionAddress(ip)).toBe(false);
    }
  });

  it("pins the socket lookup result and keeps its address family", async () => {
    const records: LookupAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const all = await query(records, { all: true });
    expect(all).toEqual({ error: null, answer: records, family: undefined });

    const one = await query(records, { all: false });
    expect(one).toEqual({ error: null, answer: "8.8.8.8", family: 4 });
  });

  it("fails closed on empty, mixed, malformed or private answers", async () => {
    const forbidden: LookupAddress[][] = [
      [],
      [{ address: "127.0.0.1", family: 4 }],
      [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.10", family: 4 }],
      [{ address: "8.8.8.8", family: 6 }],
      [{ address: "::ffff:7f00:1", family: 6 }],
    ];
    for (const records of forbidden) {
      const result = await query(records);
      expect(result.error).toMatchObject({ code: "EACCES" });
    }
  });

  it("does not authorize a connection when DNS errors", async () => {
    const error = Object.assign(new Error("lookup failed"), { code: "ENOTFOUND" });
    const result = await query([], { all: true }, error);
    expect(result.error).toMatchObject({ code: "ENOTFOUND" });
  });

  it("blocks a real local HTTP socket after a connect-time DNS change", async () => {
    const server = createServer((_request, response) => response.end("unsafe"));
    let connections = 0;
    server.on("connection", () => { connections += 1; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const lookup = createGuardedLookup(fakeResolver([{ address: "127.0.0.1", family: 4 }]));
      // The URL looks like a domain, while socket lookup tries to return
      // loopback. The guard must stop the socket before it reaches the fixture.
      await new Promise<void>((resolve, reject) => {
        const req = request(`http://rebinding.example:${port}/`, { lookup, agent: false }, (response) => {
          response.resume();
          reject(new Error("Unsafe socket unexpectedly reached HTTP server"));
        });
        req.once("error", (error: NodeJS.ErrnoException) => {
          try {
            expect(error.code).toBe("EACCES");
            resolve();
          } catch (assertionError) { reject(assertionError); }
        });
        req.end();
      });
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
