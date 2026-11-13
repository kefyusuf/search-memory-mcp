import { describe, expect, it } from "vitest";
import { isValidAdminToken, resolveAdminBind, resolveRateLimits } from "../hosted/config.js";

describe("resolveRateLimits", () => {
  it("stays concurrency-only when no rate window is configured", () => {
    expect(resolveRateLimits({})).toBeUndefined();
    expect(resolveRateLimits({ HOSTED_RATE_WINDOW_MS: "  " })).toBeUndefined();
  });

  it("returns the configured policy when the window and every dimension are set", () => {
    expect(
      resolveRateLimits({
        HOSTED_RATE_WINDOW_MS: "60000",
        HOSTED_RATE_GLOBAL: "100",
        HOSTED_RATE_TENANT: "40",
        HOSTED_RATE_WORKSPACE: "20",
        HOSTED_RATE_PRINCIPAL: "10",
      }),
    ).toEqual({ global: 100, tenant: 40, workspace: 20, principal: 10, windowMs: 60000 });
  });

  const valid = {
    HOSTED_RATE_WINDOW_MS: "1000",
    HOSTED_RATE_GLOBAL: "10",
    HOSTED_RATE_TENANT: "10",
    HOSTED_RATE_WORKSPACE: "10",
    HOSTED_RATE_PRINCIPAL: "10",
  };

  it("requires every dimension explicitly once the window is set", () => {
    expect(() => resolveRateLimits({ HOSTED_RATE_WINDOW_MS: "1000", HOSTED_RATE_GLOBAL: "10" })).toThrow(
      /HOSTED_RATE_TENANT/,
    );
  });

  it.each(["0", "-1", "1.5", "abc", ""])("rejects an invalid dimension budget: %s", (invalid) => {
    for (const name of ["HOSTED_RATE_GLOBAL", "HOSTED_RATE_TENANT", "HOSTED_RATE_WORKSPACE", "HOSTED_RATE_PRINCIPAL"]) {
      expect(() => resolveRateLimits({ ...valid, [name]: invalid })).toThrow(new RegExp(name));
    }
  });

  it.each(["0", "-1", "1.5", "abc"])("rejects an invalid rate window: %s", (invalid) => {
    expect(() => resolveRateLimits({ ...valid, HOSTED_RATE_WINDOW_MS: invalid })).toThrow(/HOSTED_RATE_WINDOW_MS/);
  });
});

describe("resolveAdminBind", () => {
  it("defaults the admin surface to loopback", () => {
    expect(resolveAdminBind({})).toBe("127.0.0.1");
    expect(resolveAdminBind({ HOSTED_ADMIN_BIND: "   " })).toBe("127.0.0.1");
  });

  it("honors an explicit admin bind without inheriting the public MCP bind", () => {
    expect(resolveAdminBind({ HOSTED_ADMIN_BIND: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveAdminBind({ HOSTED_ADMIN_BIND: " 10.0.0.1 " })).toBe("10.0.0.1");
    expect(resolveAdminBind({ HOSTED_BIND: "0.0.0.0" })).toBe("127.0.0.1");
  });
});

describe("isValidAdminToken", () => {
  it("requires at least 32 characters", () => {
    expect(isValidAdminToken("")).toBe(false);
    expect(isValidAdminToken("a".repeat(31))).toBe(false);
    expect(isValidAdminToken("a".repeat(32))).toBe(true);
    expect(isValidAdminToken("a".repeat(64))).toBe(true);
  });
});
