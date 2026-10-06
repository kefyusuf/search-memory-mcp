import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, request as httpRequest, type RequestOptions, type Server } from "node:http";
import { generateKeyPair, SignJWT } from "jose";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolDispatcher } from "../runtime/tool-dispatcher.js";
import { InMemoryInvocationAdmission } from "../runtime/invocation-admission.js";
import { assertRequestContext } from "../runtime/request-context.js";
import { createHostedHttpAuthHandler, type HostedHttpAuthOptions } from "../runtime/hosted-http-auth.js";

const issuer = "https://auth.example.com";
const resource = "https://mcp.example.com/team/mcp";
const metadata = "https://mcp.example.com/.well-known/oauth-protected-resource/team/mcp";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { keys = await generateKeyPair("ES256"); });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

async function bearer(claims: Record<string, unknown> = {}) {
  const token = await new SignJWT({ sub: "alice", iss: issuer, aud: resource, exp: Math.floor(Date.now() / 1000) + 120,
    scope: "memory:read", tenantId: "attacker", workspaceId: "attacker", ...claims })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt" }).sign(keys.privateKey);
  return `Bearer ${token}`;
}
async function setup(overrides: Partial<HostedHttpAuthOptions> = {}) {
  const resolveMembership = vi.fn(async () => ({ principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }));
  const onAuthorized = vi.fn(async (_req, res, context) => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(context)); });
  const options: HostedHttpAuthOptions = {
    authorization: { issuer, audience: resource, algorithm: "ES256", verificationKey: keys.publicKey, resolveMembership },
    allowedOrigins: ["https://app.example.com"], scopesSupported: ["memory:read"], requestTimeoutMs: 5000, onAuthorized, ...overrides,
  };
  const server = createServer(createHostedHttpAuthHandler(options)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const send = (path = "/team/mcp", headers: RequestOptions["headers"] = {}, method = "POST", body = "") =>
    new Promise<{ status: number; headers: Record<string, unknown>; text: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: Array.isArray(headers) ? headers : { host: "mcp.example.com", ...headers } }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
      }); req.on("error", reject); req.end(body);
    });
  return { send, resolveMembership, onAuthorized, options, port };
}

describe("hosted HTTP credential boundary", () => {
  it("serves public path-specific resource metadata with configured URLs", async () => {
    const { send, resolveMembership, onAuthorized } = await setup();
    const result = await send("/.well-known/oauth-protected-resource/team/mcp", { "x-forwarded-host": "attacker.example" }, "GET");
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual({ resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["memory:read"] });
    expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("returns a discoverable 401 challenge when bearer credentials are absent", async () => {
    const { send, resolveMembership, onAuthorized } = await setup(); const result = await send();
    expect(result.status).toBe(401); expect(result.headers["www-authenticate"]).toBe(`Bearer resource_metadata="${metadata}"`);
    expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("verifies signed credentials and passes only trusted workspace authority", async () => {
    const { send, resolveMembership, onAuthorized } = await setup();
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a", "x-tenant-id": "attacker", "x-request-id": "caller" });
    expect(result.status).toBe(200); const context = JSON.parse(result.text);
    expect(context).toMatchObject({ mode: "hosted", principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] });
    expect(context.requestId).not.toBe("caller"); expect(result.text).not.toContain("attacker");
    expect(resolveMembership).toHaveBeenCalledOnce(); expect(onAuthorized).toHaveBeenCalledOnce();
  });
  it.each([{ aud: "https://other.example.com" }, { exp: 0 }, { iss: "https://other.example.com" }])("rejects invalid credentials before protected work: %j", async claims => {
    const { send, resolveMembership, onAuthorized } = await setup(); const header = await bearer(claims);
    const result = await send(undefined, { authorization: header, "x-workspace-id": "workspace-a" });
    expect(result.status).toBe(401); expect(result.headers["www-authenticate"]).toContain(metadata);
    expect(result.text).not.toContain(header); expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("denies foreign workspace membership without protected handoff", async () => {
    const { send, onAuthorized } = await setup();
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-b" });
    expect(result.status).toBe(403); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it.each(["https://attacker.example", "null"])("denies unapproved Origin %s before identity lookup", async origin => {
    const { send, resolveMembership } = await setup();
    expect((await send(undefined, { origin, authorization: await bearer(), "x-workspace-id": "workspace-a" })).status).toBe(403);
    expect(resolveMembership).not.toHaveBeenCalled();
  });
  it("accepts an explicitly allowed origin and denies a forged Host", async () => {
    const { send, onAuthorized } = await setup(); const headers = { authorization: await bearer(), "x-workspace-id": "workspace-a", origin: "https://app.example.com" };
    expect((await send(undefined, headers)).status).toBe(200);
    expect((await send(undefined, { ...headers, host: "attacker.example" })).status).toBe(403);
    expect(onAuthorized).toHaveBeenCalledOnce();
  });
  it("rejects duplicate credentials, query tokens and invalid workspace selectors", async () => {
    const { send, resolveMembership, onAuthorized } = await setup(); const header = await bearer();
    expect((await send(undefined, ["Host", "mcp.example.com", "Authorization", header, "Authorization", header, "X-Workspace-Id", "workspace-a"])).status).toBe(401);
    expect((await send("/team/mcp?access_token=secret", { "x-workspace-id": "workspace-a" })).status).toBe(400);
    for (const workspace of [undefined, " ", "x".repeat(257)]) {
      expect((await send(undefined, { authorization: header, ...(workspace === undefined ? {} : { "x-workspace-id": workspace }) })).status).toBe(400);
    }
    expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("maps membership failures without exposing backend details", async () => {
    const { send, onAuthorized } = await setup({ authorization: { issuer, audience: resource, algorithm: "ES256", verificationKey: keys.publicKey,
      resolveMembership: async () => { throw new Error("database password private"); } } });
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a" });
    expect(result.status).toBe(503); expect(result.text).not.toContain("private"); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("enforces routes and methods before protected handoff", async () => {
    const { send, onAuthorized } = await setup();
    expect((await send("/other")).status).toBe(404); expect((await send(undefined, {}, "PUT")).status).toBe(405);
    expect((await send("/.well-known/oauth-protected-resource/team/mcp", {}, "POST")).status).toBe(405);
    const head = await send("/.well-known/oauth-protected-resource/team/mcp", {}, "HEAD"); expect(head.status).toBe(200); expect(head.text).toBe("");
    expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("returns a bounded timeout and cancels a pending membership lookup", async () => {
    let finish!: () => void; let signal!: AbortSignal;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const { send, onAuthorized } = await setup({ requestTimeoutMs: 250,
      authorization: { issuer, audience: resource, algorithm: "ES256", verificationKey: keys.publicKey,
        resolveMembership: async (_subject, _workspace, input) => { signal = input.signal; await waiting;
          return { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }; } } });
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a" });
    expect(result.status).toBe(504); expect(signal.aborted).toBe(true); finish();
    await new Promise(resolve => setImmediate(resolve)); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("cancels authentication when a client disconnects before handoff", async () => {
    let start!: () => void; let finish!: () => void; let aborted!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; }); const waiting = new Promise<void>(resolve => { finish = resolve; });
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const { port, onAuthorized } = await setup({ authorization: { issuer, audience: resource, algorithm: "ES256", verificationKey: keys.publicKey,
      resolveMembership: async (_subject, _workspace, input) => { input.signal.addEventListener("abort", aborted, { once: true }); start(); await waiting;
        return { principalId: "alice", tenantId: "tenant-a", workspaceId: "workspace-a", permissions: ["memory:read"] }; } } });
    const req = httpRequest({ host: "127.0.0.1", port, path: "/team/mcp", method: "POST",
      headers: { host: "mcp.example.com", authorization: await bearer(), "x-workspace-id": "workspace-a" } });
    req.on("error", () => {}); req.end(); await started; req.destroy(); await cancelled; finish();
    await new Promise(resolve => setImmediate(resolve)); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("hides failures from the authorized callback", async () => {
    const { send } = await setup({ onAuthorized: async () => { throw new Error("private handler details"); } });
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a" });
    expect(result.status).toBe(500); expect(result.text).not.toContain("private");
  });
  it("retains deadline cancellation when a streaming callback returns before the response closes", async () => {
    let closed!: () => void; let signal!: AbortSignal;
    const stopped = new Promise<void>(resolve => { closed = resolve; });
    const { port } = await setup({ requestTimeoutMs: 250, onAuthorized: async (_req, res, context) => {
      signal = context.signal; res.once("close", closed); res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    } });
    const req = httpRequest({ host: "127.0.0.1", port, path: "/team/mcp", method: "GET", headers: {
      host: "mcp.example.com", authorization: await bearer(), "x-workspace-id": "workspace-a" } }, res => { res.on("error", () => {}); res.resume(); });
    req.on("error", () => {}); req.end(); await stopped; expect(signal.aborted).toBe(true);
  }, 2000);
  it("passes authenticated contexts through a real stateless SDK MCP tool call", async () => {
    const dispatcher = new ToolDispatcher({ probe: { permission: "memory:read", modes: ["hosted"],
      handler: async (_args, context) => ({ content: [{ type: "text" as const, text: `${context.tenantId}/${context.workspaceId}` }] }) } },
      { admission: new InMemoryInvocationAdmission({ global: 4, tenant: 4, workspace: 4, principal: 4 }) });
    const { port, send } = await setup({ onAuthorized: async (req, res, context) => {
      const server = new McpServer({ name: "auth-boundary-probe", version: "1.0.0" }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      server.setRequestHandler(CallToolRequestSchema, request => dispatcher.call(request.params.name, request.params.arguments, context));
      res.once("close", () => { void server.close(); });
      await server.connect(transport); await transport.handleRequest(req, res);
    } });
    const client = new Client({ name: "probe-client", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/team/mcp`), {
        requestInit: { headers: { host: "mcp.example.com", authorization: await bearer(), "x-workspace-id": "workspace-a" } },
        // Native loopback requests preserve the production Host without DNS/TLS changes.
        fetch: async (_url, init) => {
          const result = await send("/team/mcp", Object.fromEntries(new Headers(init?.headers)), init?.method, init?.body as string);
          return new Response(result.text || null, { status: result.status, headers: result.headers as Record<string, string> });
        },
      }));
      const result = await client.callTool({ name: "probe", arguments: { tenantId: "attacker", workspaceId: "attacker" } });
      expect(result.content).toEqual([{ type: "text", text: "tenant-a/workspace-a" }]);
    } finally { await client.close(); }
  });
  it("snapshots HTTP policy and metadata before caller configuration changes", async () => {
    const { send, options } = await setup();
    (options.allowedOrigins as string[]).push("https://attacker.example"); (options.scopesSupported as string[]).push("memory:write");
    options.authorization.issuer = "https://attacker.example"; options.authorization.audience = "https://attacker.example/mcp";
    options.onAuthorized = async () => { throw new Error("changed callback"); }; options.requestTimeoutMs = 1;
    const data = await send("/.well-known/oauth-protected-resource/team/mcp", {}, "GET");
    expect(JSON.parse(data.text)).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: ["memory:read"] });
    expect((await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a" })).status).toBe(200);
    expect((await send(undefined, { origin: "https://attacker.example" })).status).toBe(403);
  });
  it.each([0, -1, NaN, 1.5, 2_147_483_648])("rejects invalid HTTP timeout %s", async requestTimeoutMs => {
    await expect(setup({ requestTimeoutMs })).rejects.toThrow("invalid_http_configuration");
  });
  it("rejects invalid origins and unsupported advertised scopes", async () => {
    for (const allowedOrigins of [["null"], ["http://app.example.com"], ["https://app.example.com/path"]]) {
      await expect(setup({ allowedOrigins })).rejects.toThrow("invalid_http_configuration");
    }
    await expect(setup({ scopesSupported: ["admin" as never] })).rejects.toThrow("invalid_http_configuration");
  });
  it("never treats body credentials as bearer authority", async () => {
    const { send, resolveMembership, onAuthorized } = await setup();
    const result = await send(undefined, { "content-type": "application/json", "x-workspace-id": "workspace-a" }, "POST",
      JSON.stringify({ access_token: await bearer(), tenantId: "tenant-a" }));
    expect(result.status).toBe(401); expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("rejects oversized authorization and duplicate workspace headers", async () => {
    const { send, resolveMembership, onAuthorized } = await setup();
    expect((await send(undefined, { authorization: "Bearer " + "a".repeat(8193), "x-workspace-id": "workspace-a" })).status).toBe(401);
    expect((await send(undefined, ["Host", "mcp.example.com", "Authorization", await bearer(),
      "X-Workspace-Id", "workspace-a", "X-Workspace-Id", "workspace-b"])).status).toBe(400);
    expect(resolveMembership).not.toHaveBeenCalled(); expect(onAuthorized).not.toHaveBeenCalled();
  });
  it("cancels delayed protected work and prevents late context-authorized effects", async () => {
    let finish!: () => void; let settled!: () => void; let effects = 0;
    const waiting = new Promise<void>(resolve => { finish = resolve; }); const done = new Promise<void>(resolve => { settled = resolve; });
    const { send } = await setup({ requestTimeoutMs: 250, onAuthorized: async (_req, res, context) => {
      try { await waiting; assertRequestContext(context); effects++; res.end("late"); } finally { settled(); }
    } });
    const result = await send(undefined, { authorization: await bearer(), "x-workspace-id": "workspace-a" });
    expect(result.status).toBe(504); finish(); await done; expect(effects).toBe(0);
  });
});
