import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminRateLimiter } from "../hosted/admin-rate-limit.js";
import { resolveAdminRateLimit } from "../hosted/config.js";

describe("resolveAdminRateLimit", () => {
  it("is disabled unless configured", () => {
    expect(resolveAdminRateLimit({})).toBeUndefined();
    expect(resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "  ", HOSTED_ADMIN_RATE_WINDOW_MS: "" })).toBeUndefined();
  });

  it("requires both variables together", () => {
    expect(() => resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "5" })).toThrow("HOSTED_ADMIN_RATE_WINDOW_MS");
    expect(() => resolveAdminRateLimit({ HOSTED_ADMIN_RATE_WINDOW_MS: "60000" })).toThrow("HOSTED_ADMIN_RATE_LIMIT");
  });

  it("rejects invalid values", () => {
    expect(() =>
      resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "0", HOSTED_ADMIN_RATE_WINDOW_MS: "1000" }),
    ).toThrow();
    expect(() =>
      resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "5.5", HOSTED_ADMIN_RATE_WINDOW_MS: "1000" }),
    ).toThrow();
    expect(() => resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "5", HOSTED_ADMIN_RATE_WINDOW_MS: "abc" })).toThrow();
  });

  it("parses a valid pair", () => {
    expect(resolveAdminRateLimit({ HOSTED_ADMIN_RATE_LIMIT: "30", HOSTED_ADMIN_RATE_WINDOW_MS: "60000" })).toEqual({
      limit: 30,
      windowMs: 60000,
    });
  });
});

describe("admin rate limiter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an invalid configuration", () => {
    expect(() => new AdminRateLimiter({ limit: 0, windowMs: 1000 })).toThrow("invalid_admin_rate_limit");
    expect(() => new AdminRateLimiter({ limit: 2, windowMs: -1 })).toThrow("invalid_admin_rate_limit");
    expect(() => new AdminRateLimiter({ limit: Number.NaN, windowMs: 1000 })).toThrow("invalid_admin_rate_limit");
  });

  it("allows up to the limit per peer, then blocks within the window", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const limiter = new AdminRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(false);
  });

  it("keys peers independently", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const limiter = new AdminRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(false);
    expect(limiter.check("10.0.0.2")).toBe(true);
  });

  it("does not reset at a wall-clock window boundary", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(999);
    const limiter = new AdminRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check("127.0.0.1")).toBe(true);
    clock.mockReturnValue(1000);
    expect(limiter.check("127.0.0.1")).toBe(false);
    clock.mockReturnValue(1999);
    expect(limiter.check("127.0.0.1")).toBe(true);
  });

  it("expires individual timestamps rather than resetting the whole window", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const limiter = new AdminRateLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.check("127.0.0.1")).toBe(true);
    clock.mockReturnValue(500);
    expect(limiter.check("127.0.0.1")).toBe(true);
    clock.mockReturnValue(999);
    expect(limiter.check("127.0.0.1")).toBe(false);
    clock.mockReturnValue(1000);
    expect(limiter.check("127.0.0.1")).toBe(true);
  });

  it("sweeps idle peers so history stays bounded", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const limiter = new AdminRateLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.check("10.0.0.1")).toBe(true);
    clock.mockReturnValue(5000);
    expect(limiter.check("10.0.0.2")).toBe(true);
    // The idle peer's window has been swept out, so its full budget is available again.
    expect(limiter.check("10.0.0.1")).toBe(true);
  });
});
