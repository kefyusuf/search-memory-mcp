import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { JwtAuthorizationAdapter, type JwtAuthorizationOptions } from "./jwt-authorization.js";
import { assertRequestContext, InvocationError, PERMISSIONS, type Permission, type RequestContext } from "./request-context.js";

export type HostedHttpAuthOptions = {
  authorization: JwtAuthorizationOptions;
  requestTimeoutMs: number;
  allowedOrigins: readonly string[];
  scopesSupported: readonly Permission[];
  onAuthorized: (request: IncomingMessage, response: ServerResponse, context: RequestContext) => Promise<void>;
};

/** Authentication ingress only. Bootstrap must explicitly supply a safe transport callback. */
export function createHostedHttpAuthHandler(options: HostedHttpAuthOptions) {
  const authorization = new JwtAuthorizationAdapter(options.authorization);
  const resource = new URL(options.authorization.audience);
  if (resource.href !== options.authorization.audience ||
      !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0 || options.requestTimeoutMs > 2_147_483_647 ||
      !Array.isArray(options.allowedOrigins) || !options.allowedOrigins.every(isSecureOrigin) ||
      !Array.isArray(options.scopesSupported) || !options.scopesSupported.every(scope => PERMISSIONS.includes(scope)) ||
      typeof options.onAuthorized !== "function") throw new InvocationError("invalid_http_configuration");
  const origins = new Set(options.allowedOrigins);
  const timeoutMs = options.requestTimeoutMs;
  const onAuthorized = options.onAuthorized;
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  const metadataPath = new URL(metadataUrl).pathname;
  const metadata = JSON.stringify({ resource: resource.href, authorization_servers: [options.authorization.issuer],
    bearer_methods_supported: ["header"], scopes_supported: [...new Set(options.scopesSupported)] });
  const challenge = `Bearer resource_metadata="${metadataUrl}"`;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const fail = (status: number, code: string, headers: Record<string, string> = {}) => reply(response, status, JSON.stringify({ error: code }), headers);
    // Proxy headers never select trusted URLs. The proxy must preserve the configured resource Host.
    if (headerCount(request, "host") !== 1 || request.headers.host !== resource.host ||
        headerCount(request, "origin") > 1 || (request.headers.origin !== undefined && !origins.has(request.headers.origin))) {
      fail(403, "forbidden"); return;
    }
    // Exact origin-form routes: query/body credentials cannot replace the Authorization header.
    const path = request.url ?? "";
    if (path.includes("?") || path.includes("#") || !path.startsWith("/") || path.startsWith("//")) { fail(400, "invalid_request"); return; }
    if (path === metadataPath) {
      if (request.method !== "GET" && request.method !== "HEAD") { fail(405, "method_not_allowed", { allow: "GET, HEAD" }); return; }
      reply(response, 200, request.method === "HEAD" ? "" : metadata); return;
    }
    if (path !== resource.pathname) { fail(404, "not_found"); return; }
    if (!["POST", "GET", "DELETE"].includes(request.method ?? "")) { fail(405, "method_not_allowed", { allow: "POST, GET, DELETE" }); return; }
    if (headerCount(request, "authorization") !== 1 || !request.headers.authorization) {
      fail(401, "unauthenticated", { "www-authenticate": challenge }); return;
    }
    const workspace = request.headers["x-workspace-id"];
    if (headerCount(request, "x-workspace-id") !== 1 || typeof workspace !== "string" ||
        !workspace.trim() || workspace.length > 256) { fail(400, "invalid_request"); return; }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    const cleanup = () => {
      clearTimeout(timer);
      request.off("aborted", cancel);
      response.off("close", disconnected);
      response.off("finish", cleanup);
    };
    const disconnected = () => { cancel(); cleanup(); };
    request.once("aborted", cancel);
    response.once("close", disconnected);
    response.once("finish", cleanup);
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(() => { controller.abort(); fail(504, "deadline_exceeded"); }, timeoutMs);
    timer.unref();
    try {
      const context = await authorization.authenticate(request.headers.authorization, {
        workspaceId: workspace, requestId: randomUUID(), deadlineAt, signal: controller.signal,
      });
      assertRequestContext(context);
      if (!response.destroyed && !response.writableEnded) await onAuthorized(request, response, context);
    } catch (error) {
      const code = error instanceof InvocationError ? error.code : "internal_error";
      const status = code === "unauthenticated" ? 401 : code === "forbidden" ? 403 :
        code === "authorization_unavailable" ? 503 : code === "deadline_exceeded" ? 504 :
        code === "cancelled" ? 408 : code === "invalid_context" ? 400 : 500;
      fail(status, status === 500 ? "internal_error" : code, status === 401 ? { "www-authenticate": challenge } : {});
    } finally {
      // SDK streaming handlers can return while the response is still open.
      if (response.destroyed || response.writableEnded) cleanup();
    }
  };
}

function headerCount(request: IncomingMessage, name: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count;
}

function reply(response: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return;
  // A partially streamed response cannot be rewritten as an authentication error.
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }).end(body);
}

function isSecureOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; }
  catch { return false; }
}
