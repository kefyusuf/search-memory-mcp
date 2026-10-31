import { timingSafeEqual, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { SignJWT } from "jose";
import { Pool } from "pg";
import { panelHtml } from "./panel.js";
import type { UsageSnapshot } from "./usage.js";

export type ProvisioningOptions = {
  adminPort: number;
  /** Operator bearer token; separate from user JWTs and never accepted on the MCP port. */
  adminToken: string;
  /** Operator-role DSN (DML on identity tables); the MCP ingress never sees this credential. */
  operatorDatabaseUrl: string;
  issuer: string;
  audience: string;
  /** Private key matching the hosted server's verification key; used to mint pilot user tokens. */
  tokenPrivateKey: CryptoKey;
  tokenAlgorithm: "ES256" | "RS256" | "EdDSA";
  bind?: string;
  /** Number of hosted-enabled tools, shown in the panel header. */
  hostedEnabledTools?: number;
  /** Live usage counters from the hosted server (in-memory, since server start). */
  usageSnapshot: () => UsageSnapshot;
};

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PERMISSIONS = ["memory:read", "memory:write", "search:read", "content:read", "knowledge:read", "knowledge:write", "status:read"];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOKEN_TTL_DAYS_MAX = 30;

function secretEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}
function validName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
function fail(response: ServerResponse, status: number, error: string): void {
  sendJson(response, status, { error });
}

export type ProvisioningServer = {
  server: Server;
  port: number;
  close(): Promise<void>;
};

export async function startProvisioningServer(options: ProvisioningOptions): Promise<ProvisioningServer> {
  const pool = new Pool({ connectionString: options.operatorDatabaseUrl, connectionTimeoutMillis: 2000 });
  pool.on("error", () => {});

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const header = request.headers.authorization ?? "";
    const authorized = typeof header === "string" && header.startsWith("Bearer ")
      && secretEqual(header.slice("Bearer ".length), options.adminToken);
    if (!authorized) { fail(response, 401, "unauthenticated"); return; }

    const path = (request.url ?? "").split("?")[0];
    try {
      // Operator panel (Faz D, minimal scope): token-protected, no external assets.
      if (request.method === "GET" && path === "/admin/panel") {
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(panelHtml({ audience: options.audience, issuer: options.issuer, hostedEnabledTools: options.hostedEnabledTools ?? 0 }));
        return;
      }

      if (request.method === "GET" && path === "/admin/usage") {
        sendJson(response, 200, options.usageSnapshot());
        return;
      }

      if (request.method === "GET" && path === "/admin/workspaces") {
        const workspaces = (await pool.query("SELECT workspace_id, tenant_id, disabled_at FROM mcp_identity.workspaces ORDER BY workspace_id")).rows;
        const memberships = (await pool.query("SELECT issuer, principal_id, workspace_id, permissions, revoked_at FROM mcp_identity.workspace_memberships ORDER BY principal_id")).rows;
        sendJson(response, 200, { workspaces, memberships });
        return;
      }

      if (request.method !== "POST") { fail(response, 405, "method_not_allowed"); return; }

      const chunks: Buffer[] = [];
      let size = 0;
      const body: Record<string, unknown> = await new Promise((resolve, reject) => {
        request.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) { reject(new Error("payload_too_large")); request.destroy(); return; }
          chunks.push(chunk);
        });
        request.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
          catch { reject(new Error("invalid_json")); }
        });
        request.on("error", reject);
      });

      if (path === "/admin/workspaces") {
        const { workspaceId, tenantId } = body as { workspaceId?: unknown; tenantId?: unknown };
        if (!validName(workspaceId) || (tenantId !== undefined && !validName(tenantId))) { fail(response, 400, "invalid_workspace_id"); return; }
        const tenant = (tenantId as string) ?? (workspaceId as string);
        await pool.query("INSERT INTO mcp_identity.workspaces(workspace_id,tenant_id) VALUES ($1,$2) ON CONFLICT (workspace_id) DO NOTHING", [workspaceId, tenant]);
        sendJson(response, 200, { ok: true, workspaceId, tenantId: tenant, created: true });
        return;
      }

      if (path === "/admin/memberships") {
        const { principalId, workspaceId, issuer: membershipIssuer, permissions } = body as Record<string, unknown>;
        if (!validName(principalId) || !validName(workspaceId)) { fail(response, 400, "invalid_membership_id"); return; }
        const perms = Array.isArray(permissions) && permissions.every(p => typeof p === "string") ? permissions as string[] : DEFAULT_PERMISSIONS;
        await pool.query(
          "INSERT INTO mcp_identity.workspace_memberships(issuer,principal_id,workspace_id,permissions) VALUES ($1,$2,$3,$4) ON CONFLICT (issuer,principal_id,workspace_id) DO NOTHING",
          [options.issuer, principalId, workspaceId, perms],
        );
        sendJson(response, 200, { ok: true, principalId, workspaceId, permissions: perms });
        return;
      }

      if (path === "/admin/memberships/revoke") {
        const { principalId, workspaceId } = body as Record<string, unknown>;
        if (!validName(principalId) || !validName(workspaceId)) { fail(response, 400, "invalid_membership_id"); return; }
        const result = await pool.query("UPDATE mcp_identity.workspace_memberships SET revoked_at=now() WHERE issuer=$1 AND principal_id=$2 AND workspace_id=$3 AND revoked_at IS NULL", [options.issuer, principalId, workspaceId]);
        sendJson(response, result.rowCount === 1 ? 200 : 404, result.rowCount === 1 ? { ok: true, revoked: principalId } : { error: "membership_not_found" });
        return;
      }

      if (path === "/admin/workspaces/disable") {
        const { workspaceId } = body as Record<string, unknown>;
        if (!validName(workspaceId)) { fail(response, 400, "invalid_workspace_id"); return; }
        const result = await pool.query("UPDATE mcp_identity.workspaces SET disabled_at=now() WHERE workspace_id=$1 AND disabled_at IS NULL", [workspaceId]);
        sendJson(response, result.rowCount === 1 ? 200 : 404, result.rowCount === 1 ? { ok: true, disabled: workspaceId } : { error: "workspace_not_found" });
        return;
      }

      if (path === "/admin/tokens") {
        const { principalId, workspaceId, ttlDays } = body as Record<string, unknown>;
        if (!validName(principalId) || !validName(workspaceId)) { fail(response, 400, "invalid_token_request"); return; }
        const days = ttlDays === undefined ? 7 : Number(ttlDays);
        if (!Number.isSafeInteger(days) || days < 1 || days > TOKEN_TTL_DAYS_MAX) { fail(response, 400, "invalid_ttl"); return; }
        // Only currently-active members get tokens, and permissions come from
        // the membership row (never from the request).
        const membership = await pool.query("SELECT m.permissions FROM mcp_identity.workspace_memberships m JOIN mcp_identity.workspaces w ON w.workspace_id = m.workspace_id WHERE m.issuer=$1 AND m.principal_id=$2 AND m.workspace_id=$3 AND m.revoked_at IS NULL AND w.disabled_at IS NULL", [options.issuer, principalId, workspaceId]);
        if (membership.rowCount !== 1) { fail(response, 404, "membership_not_found"); return; }
        const permissions = membership.rows[0].permissions as string[];
        const token = await new SignJWT({ sub: principalId, iss: options.issuer, aud: options.audience, exp: Math.floor(Date.now() / 1000) + days * 86_400, scope: permissions.join(" ") })
          .setProtectedHeader({ alg: options.tokenAlgorithm, typ: "at+jwt" }).sign(options.tokenPrivateKey);
        sendJson(response, 200, { token, mcpEndpoint: options.audience, issuer: options.issuer, principalId, workspaceId, expiresInDays: days });
        return;
      }

      fail(response, 404, "not_found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "payload_too_large") { fail(response, 413, "payload_too_large"); return; }
      if (message === "invalid_json") { fail(response, 400, "invalid_json"); return; }
      if (message?.startsWith("duplicate key") || message?.includes("duplicate key")) { fail(response, 409, "already_exists"); return; }
      fail(response, 500, "internal_error");
    }
  };

  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(options.adminPort, options.bind ?? "127.0.0.1", resolve));
  const bound = server.address();
  const boundPort = bound && typeof bound === "object" ? bound.port : options.adminPort;
  return {
    server,
    port: boundPort,
    async close() {
      // Keep-alive sockets from operator clients must not hold the close open.
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await pool.end();
    },
  };
}
