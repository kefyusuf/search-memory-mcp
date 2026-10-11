import { Agent } from "undici";
import { lookup as systemLookup } from "node:dns";
import { isIP } from "node:net";
import { createGuardedLookup, isPublicConnectionAddress } from "./guarded-lookup.js";
import { validatePublicHttpUrl } from "../ssrf.js";

/**
 * Per-request dispatcher; never change the process-wide Node/Undici dispatcher.
 * At socket creation, the lookup callback returns only policy-allowed addresses,
 * preserving the origin hostname for HTTP Host, TLS SNI and certificate checks.
 *
 * IP-literal URLs skip DNS lookup in Node, so URL validation is mandatory.
 * Browser/Playwright traffic does not use this transport and remains in #54.
 */
export class BlockedFetchUrlError extends Error {
  constructor() {
    super("HTTP fetch blocked by outbound URL policy");
    this.name = "BlockedFetchUrlError";
  }
}

/** Distinguish socket-policy denial from an ordinary network error: never
 * retry a denied address in the unguarded browser fallback. */
export function isGuardedFetchRejection(error: unknown): boolean {
  let cause = error;
  for (let i = 0; i < 4 && cause && typeof cause === "object"; i += 1) {
    if (cause instanceof BlockedFetchUrlError ||
        ("code" in cause && cause.code === "EACCES")) return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

/**
 * HTTP-only guarded fetch. It rejects unsafe URL literals before any socket is
 * acquired and never follows redirects without the caller revalidating each hop.
 *
 * The caller must either consume or cancel the response body before reusing the
 * connection. Undici checks destinations on each new connection, not on reuse.
 */
export function createGuardedHttpFetcher(
  resolver: typeof systemLookup = systemLookup,
): (url: string, init?: RequestInit) => Promise<Response> {
  const httpAgent = new Agent({ connect: { lookup: createGuardedLookup(resolver) } });

  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const validation = await validatePublicHttpUrl(url);
    if (!validation.ok) throw new BlockedFetchUrlError();

    // DNS lookup is bypassed for IP literals. Apply the same peer-address
    // policy BEFORE opening a socket, including IPv4-mapped/unspecified IPv6.
    const bracketed = validation.url.hostname;
    const literal = bracketed.startsWith("[") && bracketed.endsWith("]")
      ? bracketed.slice(1, -1)
      : bracketed;
    if (isIP(literal) && !isPublicConnectionAddress(literal)) {
      throw new BlockedFetchUrlError();
    }

    // Node's built-in fetch supports a request-specific Undici dispatcher.
    // RequestInit omits this documented Node-specific extension in its DOM type.
    const options = { ...init, redirect: "manual" as const, dispatcher: httpAgent };
    return fetch(url, options);
  };
}

export const guardedHttpFetch = createGuardedHttpFetcher();
