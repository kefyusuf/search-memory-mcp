import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { JwtAuthorizationAdapter, type JwtAuthorizationOptions } from "../runtime/jwt-authorization.js";
import { assertRequestContext } from "../runtime/request-context.js";
const issuer = "https://auth.example.com"; const audience = "https://mcp.example.com/mcp";
let keys: Awaited<ReturnType<typeof generateKeyPair>>; let foreign: typeof keys;
beforeAll(async () => { keys = await generateKeyPair("ES256"); foreign = await generateKeyPair("ES256"); });
const request = () => ({ workspaceId: "workspace-a", requestId: "r1", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal });
function setup(overrides: Partial<JwtAuthorizationOptions> = {}) {
  const resolveMembership = vi.fn(async () => ({ principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }));
  const options: JwtAuthorizationOptions = { issuer, audience, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership, ...overrides };
  return { adapter: new JwtAuthorizationAdapter(options), resolveMembership, options };
}
async function token(payload: JWTPayload = {}, key = keys.privateKey, header: Record<string, unknown> = {}) {
  return new SignJWT({ iss: issuer, aud: audience, sub: "alice", exp: Math.floor(Date.now() / 1000) + 120,
    scope: "memory:read memory:write", tenantId: "attacker", workspaceId: "attacker", ...payload })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", ...header }).sign(key);
}
describe("verified hosted JWT authorization", () => {
  afterEach(() => vi.restoreAllMocks());
  it("supplies only the verified configured issuer to membership lookup", async () => {
    const { adapter, resolveMembership } = setup(); const input = { ...request(), issuer: "https://attacker.example" };
    await adapter.authenticate(`Bearer ${await token()}`, input);
    expect(resolveMembership).toHaveBeenCalledWith("alice", "workspace-a", { ...input, issuer });
    expect(Object.isFrozen(resolveMembership.mock.calls[0][2])).toBe(true);
  });
  it("verifies real signatures and uses membership instead of token workspace claims", async () => {
    const { adapter, resolveMembership } = setup(); const input = request();
    const context = await adapter.authenticate(`Bearer ${await token()}`, input);
    assertRequestContext(context);
    expect(context).toMatchObject({ mode: "hosted", principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] });
    expect(resolveMembership).toHaveBeenCalledWith("alice", "workspace-a", { ...input, issuer });
    expect(JSON.stringify(context)).not.toContain("attacker"); expect(Object.isFrozen(context)).toBe(true);
  });
  it.each([
    { iss: "https://other.example.com" }, { aud: "https://other.example.com" }, { sub: undefined }, { sub: " " },
    { exp: undefined }, { exp: 0 }, { exp: Math.floor(Date.now() / 1000) - 1 }, { nbf: Math.floor(Date.now() / 1000) + 300 },
    { scope: ["memory:read"] }, { scope: "memory:read\nmemory:write" },
  ])("rejects invalid signed claims without membership lookup: %j", async payload => {
    const { adapter, resolveMembership } = setup();
    await expect(adapter.authenticate(`Bearer ${await token(payload)}`, request())).rejects.toThrow("unauthenticated");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("rejects signatures from an untrusted key", async () => {
    const { adapter, resolveMembership } = setup();
    await expect(adapter.authenticate(`Bearer ${await token({}, foreign.privateKey)}`, request())).rejects.toThrow("unauthenticated");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("rejects a different signed algorithm even with the configured public key", async () => {
    const rsa = await generateKeyPair("RS256"); const { adapter } = setup({ verificationKey: rsa.publicKey });
    const signed = await token({}, rsa.privateKey, { alg: "RS256" });
    await expect(adapter.authenticate(`Bearer ${signed}`, request())).rejects.toThrow("unauthenticated");
  });
  it("rejects ID-token type confusion", async () => {
    const { adapter, resolveMembership } = setup();
    await expect(adapter.authenticate(`Bearer ${await token({}, keys.privateKey, { typ: "JWT" })}`, request())).rejects.toThrow("unauthenticated");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it.each([undefined, [], "", "Basic token", "Bearer a.b.c extra", "Bearer a.b.", "Bearer " + "x".repeat(8193)])("rejects malformed or oversized authorization headers", async header => {
    const { adapter, resolveMembership } = setup();
    await expect(adapter.authenticate(header, request())).rejects.toThrow("unauthenticated"); expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("supports scope-less tokens with no granted permissions and audience arrays", async () => {
    const { adapter } = setup(); const context = await adapter.authenticate(`bearer ${await token({ scope: undefined, aud: [audience, "other"] })}`, request());
    expect(context.permissions).toEqual([]);
  });
  it("denies missing or mismatched trusted memberships", async () => {
    for (const membership of [null, { principalId: "bob", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] },
      { principalId: "alice", tenantId: "tenant-a", workspaceId: "other", permissions: ["memory:read"] }]) {
      const { adapter } = setup({ resolveMembership: async () => membership });
      await expect(adapter.authenticate(`Bearer ${await token()}`, request())).rejects.toThrow("forbidden");
    }
  });
  it("rechecks cancellation after membership waits", async () => {
    const controller = new AbortController();
    const { adapter } = setup({ resolveMembership: async () => { controller.abort(); return { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }; } });
    await expect(adapter.authenticate(`Bearer ${await token()}`, { ...request(), signal: controller.signal })).rejects.toThrow("cancelled");
  });
  it("hides membership backend failures behind a controlled error", async () => {
    const { adapter } = setup({ resolveMembership: async () => { throw new Error("private backend details"); } });
    await expect(adapter.authenticate(`Bearer ${await token()}`, request())).rejects.toThrow("authorization_unavailable");
  });
  it("snapshots issuer/audience policy instead of using mutable caller configuration", async () => {
    const { adapter, options } = setup(); options.audience = "https://other.example.com"; options.issuer = "https://other.example.com";
    expect((await adapter.authenticate(`Bearer ${await token()}`, request())).tenantId).toBe("tenant-a");
  });
  it.each(["RS256", "EdDSA"] as const)("supports the explicitly selected %s access-token algorithm", async algorithm => {
    const pair = await generateKeyPair(algorithm); const { adapter } = setup({ algorithm, verificationKey: pair.publicKey });
    const signed = await token({}, pair.privateKey, { alg: algorithm });
    expect((await adapter.authenticate(`Bearer ${signed}`, request())).permissions).toEqual(["memory:read"]);
  });
  it("rejects modified payload bytes before membership lookup", async () => {
    const { adapter, resolveMembership } = setup(); const parts = (await token()).split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()); payload.scope = "knowledge:write";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    await expect(adapter.authenticate(`Bearer ${parts.join(".")}`, request())).rejects.toThrow("unauthenticated");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("ignores token-controlled remote key locations", async () => {
    const { adapter, resolveMembership } = setup(); const signed = await token({}, foreign.privateKey, { jku: "https://attacker.example/jwks" });
    await expect(adapter.authenticate(`Bearer ${signed}`, request())).rejects.toThrow("unauthenticated");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("uses a request snapshot across membership waits", async () => {
    let start!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }); const waiting = new Promise<void>(resolve => { finish = resolve; });
    const { adapter } = setup({ resolveMembership: async () => { start(); await waiting; return { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }; } });
    const input = request(); const pending = adapter.authenticate(`Bearer ${await token()}`, input); await started;
    input.workspaceId = "other"; input.requestId = "changed"; input.deadlineAt = 0; finish();
    expect(await pending).toMatchObject({ workspaceId: "workspace-a", requestId: "r1" });
  });
  it.each(["deadline_exceeded", "unauthenticated"])("rejects a context after membership waits past %s", async code => {
    const now = Date.now(); const input = { ...request(), deadlineAt: now + (code === "deadline_exceeded" ? 1000 : 300_000) };
    const { adapter } = setup({ resolveMembership: async () => { vi.spyOn(Date, "now").mockReturnValue(now + (code === "deadline_exceeded" ? 2000 : 200_000));
      return { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }; } });
    await expect(adapter.authenticate(`Bearer ${await token()}`, input)).rejects.toThrow(code);
  });
  it("preserves cancellation when a membership backend also fails", async () => {
    const controller = new AbortController(); const { adapter } = setup({ resolveMembership: async () => { controller.abort(); throw new Error("private backend failure"); } });
    await expect(adapter.authenticate(`Bearer ${await token()}`, { ...request(), signal: controller.signal })).rejects.toThrow("cancelled");
  });
  it("rejects pre-cancelled and invalid request inputs before membership lookup", async () => {
    const { adapter, resolveMembership } = setup(); const controller = new AbortController(); controller.abort(); const header = `Bearer ${await token()}`;
    await expect(adapter.authenticate(header, { ...request(), signal: controller.signal })).rejects.toThrow("cancelled");
    await expect(adapter.authenticate(header, { ...request(), deadlineAt: 0 })).rejects.toThrow("deadline_exceeded");
    await expect(adapter.authenticate(header, { ...request(), workspaceId: " " })).rejects.toThrow("invalid_context");
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("rejects private verification keys in server configuration", () => {
    expect(() => setup({ verificationKey: keys.privateKey })).toThrow("invalid_auth_configuration");
  });
  it.each([{ issuer: "http://auth.example.com" }, { audience: "https://mcp.example.com/mcp#fragment" }, { issuer: "https://user:password@auth.example.com" },
    { verificationKey: undefined }, { algorithm: "HS256" }, { resolveMembership: undefined }])("rejects invalid server configuration: %j", invalid => {
    expect(() => setup(invalid as Partial<JwtAuthorizationOptions>)).toThrow("invalid_auth_configuration");
  });
});
