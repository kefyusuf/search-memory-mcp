import { lookup as systemLookup } from "node:dns";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectSocket, isIP, type Socket } from "node:net";
import { createGuardedLookup, isPublicConnectionAddress } from "./guarded-lookup.js";
import { validatePublicHttpUrl } from "../ssrf.js";

const TIMEOUT_MS = 15_000;
const MAX_PROXY_CONNECTIONS = 64;

/**
 * Local-only Chromium egress gate. This is NOT a general-purpose HTTP proxy.
 * Every outbound TCP connection, including HTTPS CONNECT, receives the guarded
 * Node lookup. Direct IP literals are checked separately (lookup is skipped).
 *
 * No production browser integration until the real Chromium acceptance suite
 * proves all required traffic uses this proxy, including localhost.
 */
export interface BrowserEgressProxy {
  url: string;
  close(): Promise<void>;
}

function unwrapHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

async function allowedTarget(raw: string): Promise<URL | null> {
  const checked = await validatePublicHttpUrl(raw);
  if (!checked.ok) return null;
  const url = checked.url;
  if (url.username || url.password) return null;
  const literal = unwrapHostname(url.hostname);
  if (isIP(literal) && !isPublicConnectionAddress(literal)) return null;
  return url;
}

function respondError(response: ServerResponse, code: 403 | 502 | 503): void {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) response.writeHead(code, { "content-type": "text/plain", "connection": "close" });
  response.end("Outbound connection denied");
}

function sanitizedHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const clean: IncomingHttpHeaders = { ...headers, host };
  delete clean["proxy-authorization"];
  delete clean["proxy-connection"];
  delete clean["connection"];
  delete clean["keep-alive"];
  return clean;
}

function closeSocket(socket: Socket, code: 403 | 502 | 503): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${code} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startBrowserEgressProxy(
  resolver: typeof systemLookup = systemLookup,
): Promise<BrowserEgressProxy> {
  const lookup = createGuardedLookup(resolver);
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    // Chromium sends absolute-form HTTP URLs to a forward proxy. Reject
    // origin-form requests, other schemes and credential-bearing URLs.
    let target: URL | null = null;
    try {
      target = request.url ? await allowedTarget(request.url) : null;
    } catch { /* fail closed */ }
    if (!target || target.protocol !== "http:") {
      respondError(response, 403);
      return;
    }

    const headers = sanitizedHeaders(request.headers, target.host);
    const outbound = httpRequest(target, {
      method: request.method,
      headers,
      lookup,
      agent: false,
      timeout: TIMEOUT_MS,
    }, (upstream) => {
      // Preserve HTTP status/headers and stream the response; don't parse page
      // data in the proxy. Chromium owns cookies, TLS and response decoding.
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
    outbound.on("timeout", () => outbound.destroy(new Error("Outbound connection timeout")));
    outbound.on("error", (error: NodeJS.ErrnoException) => {
      respondError(response, error.code === "EACCES" ? 403 : 502);
    });
    request.on("aborted", () => outbound.destroy());
    request.pipe(outbound);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    if (sockets.size > MAX_PROXY_CONNECTIONS) socket.destroy();
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });

  server.on("connect", async (request: IncomingMessage, client: Socket, head: Buffer) => {
    // Only authority-form host:port is accepted. CONNECT is a raw TCP tunnel;
    // the browser still performs TLS/SNI verification end-to-end.
    const authority = request.url ?? "";
    if (!authority || /[\\/@?#]/.test(authority)) {
      closeSocket(client, 403);
      return;
    }
    let target: URL | null = null;
    try {
      const parsed = new URL(`https://${authority}`);
      if (!parsed.port || parsed.username || parsed.password) throw new Error("Invalid CONNECT authority");
      target = await allowedTarget(parsed.href);
    } catch { /* fail closed */ }
    if (!target) {
      closeSocket(client, 403);
      return;
    }

    const port = Number(target.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      closeSocket(client, 403);
      return;
    }

    const upstream = connectSocket({
      host: unwrapHostname(target.hostname),
      port,
      lookup,
    });
    let connected = false;
    upstream.setTimeout(TIMEOUT_MS, () => upstream.destroy(new Error("Outbound connection timeout")));
    upstream.once("connect", () => {
      connected = true;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected) closeSocket(client, error.code === "EACCES" ? 403 : 502);
      else client.destroy();
      upstream.destroy();
    });
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  });
  server.on("upgrade", (_request, socket) => closeSocket(socket, 403));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser egress proxy did not bind TCP");

  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      // CONNECT sockets are not closed by closeAllConnections: destroy all.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
