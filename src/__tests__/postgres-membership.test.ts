import { describe, expect, it } from "vitest";
import { PostgresMembershipResolver, type PostgresMembershipOptions } from "../identity/postgres-membership.js";

const options: PostgresMembershipOptions = { connectionString: "postgresql://reader@127.0.0.1/test", issuer: "https://auth.example.com", maxConcurrentLookups: 2, lookupTimeoutMs: 500 };
describe("PostgreSQL membership configuration", () => {
  it.each([0, -1, NaN, 1.5, 257])("rejects invalid lookup capacity %s", maxConcurrentLookups => {
    expect(() => new PostgresMembershipResolver({ ...options, maxConcurrentLookups })).toThrow("invalid_membership_configuration");
  });
  it.each([0, -1, NaN, 1.5, 30_001])("rejects invalid lookup timeout %s", lookupTimeoutMs => {
    expect(() => new PostgresMembershipResolver({ ...options, lookupTimeoutMs })).toThrow("invalid_membership_configuration");
  });
  it.each(["", "https://db.example.com/test", "postgresql://reader@127.0.0.1/test?statement_timeout=0", "postgresql://127.0.0.1/"])("rejects incomplete or policy-overriding DSN %s", connectionString => {
    expect(() => new PostgresMembershipResolver({ ...options, connectionString })).toThrow("invalid_membership_configuration");
  });
  it.each(["http://auth.example.com", "https://user:password@auth.example.com", "https://auth.example.com/#fragment"])("rejects invalid issuer %s", issuer => {
    expect(() => new PostgresMembershipResolver({ ...options, issuer })).toThrow("invalid_membership_configuration");
  });
  it("creates no connection for invalid/cancelled requests and rejects work after close", async () => {
    const resolver = new PostgresMembershipResolver(options); const controller = new AbortController(); controller.abort();
    const input = { issuer: options.issuer, workspaceId: "w", requestId: "r", deadlineAt: Date.now() + 60_000, signal: controller.signal };
    try {
      await expect(resolver.resolveMembership("alice", "w", input)).rejects.toThrow("cancelled");
      await expect(resolver.resolveMembership(" ", "w", { ...input, signal: new AbortController().signal })).rejects.toThrow("invalid_context");
    } finally { await resolver.close(); }
    await expect(resolver.resolveMembership("alice", "w", { ...input, signal: new AbortController().signal })).rejects.toThrow("authorization_unavailable");
  });
  it("requires verified TLS for non-loopback databases", async () => {
    const remote = { ...options, connectionString: "postgresql://reader@db.example.com/test" };
    expect(() => new PostgresMembershipResolver(remote)).toThrow("invalid_membership_configuration");
    expect(() => new PostgresMembershipResolver({ ...remote, ssl: { rejectUnauthorized: false } })).toThrow("invalid_membership_configuration");
    const resolver = new PostgresMembershipResolver({ ...remote, ssl: true }); await resolver.close();
  });
  it("rejects expired or mismatched request envelopes before connecting", async () => {
    const resolver = new PostgresMembershipResolver(options);
    const input = { issuer: options.issuer, workspaceId: "w", requestId: "r", deadlineAt: Date.now() - 1, signal: new AbortController().signal };
    try {
      await expect(resolver.resolveMembership("alice", "w", input)).rejects.toThrow("deadline_exceeded");
      await expect(resolver.resolveMembership("alice", "other", { ...input, deadlineAt: Date.now() + 1000 })).rejects.toThrow("invalid_context");
      await expect(resolver.resolveMembership("x".repeat(257), "w", { ...input, deadlineAt: Date.now() + 1000 })).rejects.toThrow("invalid_context");
    } finally { await resolver.close(); }
  });
});
