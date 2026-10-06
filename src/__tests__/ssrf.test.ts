import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { promises as dns } from "node:dns";
import { isPrivateIP, isPrivateHost, validatePublicHttpUrl } from "../ssrf.js";

beforeEach(() => {
  vi.spyOn(dns, "resolve4").mockResolvedValue(["93.184.216.34"] as never);
  vi.spyOn(dns, "resolve6").mockResolvedValue([] as never);
});

afterEach(() => vi.restoreAllMocks());

describe("isPrivateIP", () => {
  it("should block loopback (127.x.x.x)", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });

  it("should block RFC 1918 10.x.x.x", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  it("should block RFC 1918 172.16-31.x.x", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
    expect(isPrivateIP("172.31.255.255")).toBe(true);
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  it("should block RFC 1918 192.168.x.x", () => {
    expect(isPrivateIP("192.168.1.1")).toBe(true);
    expect(isPrivateIP("192.168.255.255")).toBe(true);
  });

  it("should block link-local 169.254.x.x", () => {
    expect(isPrivateIP("169.254.1.1")).toBe(true);
  });

  it("should block CGNAT 100.64-127.x.x", () => {
    expect(isPrivateIP("100.64.0.1")).toBe(true);
    expect(isPrivateIP("100.127.255.255")).toBe(true);
    expect(isPrivateIP("100.128.0.1")).toBe(false);
  });

  it("should block current network 0.x.x.x", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
    expect(isPrivateIP("0.1.2.3")).toBe(true);
  });

  it("should block IPv6 loopback", () => {
    expect(isPrivateIP("::1")).toBe(true);
    expect(isPrivateIP("0:0:0:0:0:0:0:1")).toBe(true);
  });

  it("should block IPv6 ULA (fc00::/7)", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
    expect(isPrivateIP("fd00::1")).toBe(true);
  });

  it("should block IPv6 link-local (fe80::/10)", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  it("should handle IPv4-mapped IPv6", () => {
    expect(isPrivateIP("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIP("::ffff:10.0.0.1")).toBe(true);
  });

  it("should allow public IPs", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
    expect(isPrivateIP("1.1.1.1")).toBe(false);
    expect(isPrivateIP("142.250.80.46")).toBe(false);
  });
});

describe("isPrivateHost", () => {
  it("blocks a hostname when any IPv4 answer is private", async () => {
    vi.mocked(dns.resolve4).mockResolvedValue(["93.184.216.34", "10.0.0.1"] as never);
    expect(await isPrivateHost("mixed.example")).toBe(true);
  });

  it("blocks a hostname resolving to a private IPv6 address", async () => {
    vi.mocked(dns.resolve6).mockResolvedValue(["fd00::1"] as never);
    expect(await isPrivateHost("private.example")).toBe(true);
  });

  it("should block localhost string", async () => {
    expect(await isPrivateHost("localhost")).toBe(true);
    expect(await isPrivateHost("localhost6")).toBe(true);
  });

  it("should block 0.0.0.0", async () => {
    expect(await isPrivateHost("0.0.0.0")).toBe(true);
  });

  it("should block private IP strings directly", async () => {
    expect(await isPrivateHost("127.0.0.1")).toBe(true);
    expect(await isPrivateHost("192.168.1.1")).toBe(true);
    expect(await isPrivateHost("10.0.0.1")).toBe(true);
  });

  it("should allow public hostnames", async () => {
    expect(await isPrivateHost("google.com")).toBe(false);
    expect(await isPrivateHost("example.com")).toBe(false);
  });
});

describe("validatePublicHttpUrl", () => {
  it("rejects unsupported protocols before network access", async () => {
    await expect(validatePublicHttpUrl("file:///etc/passwd")).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_protocol",
    });
    await expect(validatePublicHttpUrl("ftp://example.com/file")).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_protocol",
    });
    await expect(validatePublicHttpUrl("data:text/plain,hello")).resolves.toMatchObject({
      ok: false,
      reason: "unsupported_protocol",
    });
  });

  it("rejects private HTTP hosts", async () => {
    await expect(validatePublicHttpUrl("http://127.0.0.1:8080/admin")).resolves.toMatchObject({
      ok: false,
      reason: "private_host",
      hostname: "127.0.0.1",
    });
  });

  it("accepts public HTTP URLs", async () => {
    await expect(validatePublicHttpUrl("https://example.com/page")).resolves.toMatchObject({
      ok: true,
    });
  });
});
