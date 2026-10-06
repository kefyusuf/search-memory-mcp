import { beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { JwtVerificationKeyRing } from "../runtime/jwt-key-ring.js";
import { JwtAuthorizationAdapter } from "../runtime/jwt-authorization.js";
import { assertRequestContext, createHostedRequestContext } from "../runtime/request-context.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../runtime/invocation-admission.js";

let first: Awaited<ReturnType<typeof generateKeyPair>>; let second: typeof first;
const issuer = "https://auth.example.com"; const audience = "https://mcp.example.com/mcp";
beforeAll(async () => { first = await generateKeyPair("ES256"); second = await generateKeyPair("ES256"); });
const request = () => ({ workspaceId: "workspace-a", requestId: "r1", deadlineAt: Date.now() + 60_000, signal: new AbortController().signal });
const membership = { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] };
function setup(resolveMembership = vi.fn(async () => membership)) {
  const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]);
  return { ring, resolveMembership, adapter: new JwtAuthorizationAdapter({ issuer, audience, algorithm: "ES256", verificationKey: ring, resolveMembership }) };
}
async function bearer(kid: unknown = "old", key = first.privateKey, headers: Record<string, unknown> = {}) {
  return "Bearer " + await new SignJWT({ sub: "alice", iss: issuer, aud: audience, exp: Math.floor(Date.now() / 1000) + 120, scope: "memory:read" })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid, ...headers }).sign(key);
}

describe("deployment-owned JWT verification key rotation", () => {
  it("keeps retained key leases valid while overlapping old and new keys", () => {
    const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]); const lease = ring.select("old");
    ring.replace([{ kid: "new", key: second.publicKey }, { kid: "old", key: first.publicKey }]);
    expect(ring.select("new").key).toBe(second.publicKey); expect(lease.isCurrent()).toBe(true);
  });
  it("revokes removed/replaced key leases and never revives an old lease after re-addition", () => {
    const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]); const lease = ring.select("old");
    ring.replace([]); expect(lease.isCurrent()).toBe(false); expect(() => ring.select("old")).toThrow("unauthenticated");
    ring.replace([{ kid: "old", key: first.publicKey }]); expect(lease.isCurrent()).toBe(false);
    const readded = ring.select("old"); expect(readded.isCurrent()).toBe(true);
    ring.replace([{ kid: "old", key: second.publicKey }]); expect(readded.isCurrent()).toBe(false);
  });
  it("publishes no partial replacement when any entry is invalid", () => {
    const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]); const lease = ring.select("old");
    expect(() => ring.replace([{ kid: "new", key: second.publicKey }, { kid: "private", key: first.privateKey }])).toThrow("invalid_key_ring");
    expect(lease.isCurrent()).toBe(true); expect(() => ring.select("new")).toThrow("unauthenticated");
  });
  it("snapshots caller entries and keeps the configured algorithm immutable", () => {
    const entries = [{ kid: "old", key: first.publicKey }]; const ring = new JwtVerificationKeyRing("ES256", entries);
    entries[0].kid = "changed"; entries[0].key = second.publicKey; entries.length = 0;
    expect(ring.select("old").key).toBe(first.publicKey); expect(Object.isFrozen(ring)).toBe(true);
  });
  it.each([undefined, "", "unknown", "../key", "a".repeat(129), 1])("denies unknown/malformed kid %j without fallback", kid => {
    const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]);
    expect(() => ring.select(kid)).toThrow("unauthenticated");
  });
  it("limits each published key set and rejects duplicate identifiers", () => {
    expect(() => new JwtVerificationKeyRing("ES256", Array.from({ length: 33 }, (_, i) => ({ kid: `key-${i}`, key: first.publicKey })))).toThrow("invalid_key_ring");
    expect(() => new JwtVerificationKeyRing("ES256", [{ kid: "same", key: first.publicKey }, { kid: "same", key: second.publicKey }])).toThrow("invalid_key_ring");
  });
  it.each(["", "../key", "a".repeat(129)])("rejects invalid configured key identifier %j", kid => {
    expect(() => new JwtVerificationKeyRing("ES256", [{ kid, key: first.publicKey }])).toThrow("invalid_key_ring");
  });
  it("rejects private, mismatched and unsupported keys or algorithms", async () => {
    expect(() => new JwtVerificationKeyRing("ES256", [{ kid: "key", key: first.privateKey }])).toThrow("invalid_key_ring");
    const rsa = await generateKeyPair("RS256");
    expect(() => new JwtVerificationKeyRing("ES256", [{ kid: "key", key: rsa.publicKey }])).toThrow("invalid_key_ring");
    expect(() => new JwtVerificationKeyRing("HS256" as never, [])).toThrow("invalid_key_ring");
  });
  it("verifies both overlapping keys and rejects retired signatures before lookup", async () => {
    const { adapter, ring, resolveMembership } = setup(); const oldToken = await bearer(); const newToken = await bearer("new", second.privateKey);
    ring.replace([{ kid: "old", key: first.publicKey }, { kid: "new", key: second.publicKey }]);
    assertRequestContext(await adapter.authenticate(oldToken, request())); assertRequestContext(await adapter.authenticate(newToken, request()));
    ring.replace([{ kid: "new", key: second.publicKey }]); resolveMembership.mockClear();
    await expect(adapter.authenticate(oldToken, request())).rejects.toThrow("unauthenticated"); expect(resolveMembership).not.toHaveBeenCalled();
    assertRequestContext(await adapter.authenticate(newToken, request()));
  });
  it("requires a configured kid and ignores token-provided trust URLs/keys", async () => {
    const { adapter, resolveMembership } = setup();
    for (const header of [await bearer("old", first.privateKey, { kid: undefined }), await bearer("unknown", second.privateKey, { jku: "https://attacker.example/jwks" }), await bearer("old", second.privateKey)]) {
      await expect(adapter.authenticate(header, request())).rejects.toThrow("unauthenticated");
    }
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("rejects adapter/ring algorithm disagreement", () => {
    const ring = new JwtVerificationKeyRing("ES256", [{ kid: "old", key: first.publicKey }]);
    expect(() => new JwtAuthorizationAdapter({ issuer, audience, algorithm: "RS256", verificationKey: ring, resolveMembership: async () => membership })).toThrow("invalid_auth_configuration");
  });
  it("denies contexts when their key is retired during membership resolution", async () => {
    let ring!: JwtVerificationKeyRing;
    const built = setup(vi.fn(async () => { ring.replace([]); return membership; })); ring = built.ring;
    await expect(built.adapter.authenticate(await bearer(), request())).rejects.toThrow("unauthenticated");
  });
  it("invalidates already-issued contexts and does not expose the key lease in request data", async () => {
    const { adapter, ring } = setup(); const context = await adapter.authenticate(await bearer(), request());
    expect(Object.keys(context)).not.toContain("isCurrent"); expect(JSON.stringify(context)).not.toContain("old");
    ring.replace([]); expect(() => assertRequestContext(context)).toThrow("unauthenticated");
    ring.replace([{ kid: "old", key: first.publicKey }]); expect(() => assertRequestContext(context)).toThrow("unauthenticated");
  });
  it("rejects a result when rotation happens while an admitted tool is running", async () => {
    const { adapter, ring } = setup(); const context = await adapter.authenticate(await bearer(), request());
    const admission = new InMemoryInvocationAdmission({ global: 1, tenant: 1, workspace: 1, principal: 1 });
    const dispatcher = new ToolDispatcher({ probe: { permission: "memory:read", modes: ["hosted"], handler: async () => { ring.replace([]); return "private"; } } }, { admission });
    await expect(dispatcher.call("probe", {}, context)).rejects.toThrow("unauthenticated");
    ring.replace([{ kid: "old", key: first.publicKey }]); const next = await adapter.authenticate(await bearer(), request());
    const release = admission.acquire(next); expect(typeof release).toBe("function"); release();
  });
  it.each(["RS256", "EdDSA"] as const)("verifies real %s signatures with an explicitly compatible ring", async algorithm => {
    const pair = await generateKeyPair(algorithm); const ring = new JwtVerificationKeyRing(algorithm, [{ kid: "key", key: pair.publicKey }]);
    const adapter = new JwtAuthorizationAdapter({ issuer, audience, algorithm, verificationKey: ring, resolveMembership: async () => membership });
    const signed = await bearer("key", pair.privateKey, { alg: algorithm });
    assertRequestContext(await adapter.authenticate(signed, request()));
  });
  it("rejects incompatible EC curves and RSA hash parameters", async () => {
    const ec = await generateKeyPair("ES384");
    expect(() => new JwtVerificationKeyRing("ES256", [{ kid: "key", key: ec.publicKey }])).toThrow("invalid_key_ring");
    const rsa = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", hash: "SHA-384", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ["sign", "verify"]);
    expect(() => new JwtVerificationKeyRing("RS256", [{ kid: "key", key: rsa.publicKey }])).toThrow("invalid_key_ring");
  });
  it("fails closed when a server-owned live trust lease is invalid or throws", () => {
    for (const isCurrent of [false, () => false, () => "truthy", () => { throw new Error("private key policy details"); }]) {
      expect(() => createHostedRequestContext({ authorization: { subject: "alice", audiences: [audience], expiresAt: Date.now() + 60_000, scopes: ["memory:read"], isCurrent: isCurrent as never },
        membership, expectedAudience: audience, ...request() })).toThrow("unauthenticated");
    }
    let valid = true; const authorization = { subject: "alice", audiences: [audience], expiresAt: Date.now() + 60_000, scopes: ["memory:read"], isCurrent: () => valid };
    const context = createHostedRequestContext({ authorization, membership, expectedAudience: audience, ...request() });
    authorization.isCurrent = () => true; valid = false;
    expect(() => assertRequestContext(context)).toThrow("unauthenticated");
  });
});
