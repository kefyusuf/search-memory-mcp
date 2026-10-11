import { Agent } from "undici";
import { createGuardedLookup } from "./guarded-lookup.js";
import { validatePublicHttpUrl } from "../ssrf.js";

/**
 * Per-request dispatcher; never change the process-wide Node/Undici dispatcher.
 * At socket creation, the lookup callback returns only policy-allowed addresses,
 * preserving the origin hostname for HTTP Host, TLS SNI and certificate checks.
 *
 * IP-literal URLs skip DNS lookup in Node, so URL validation is mandatory.
 * Browser/Playwright traffic does not use this transport and remains in #54.
 */
const httpAgent = new Agent({
  connect: { lookup: createGuardedLookup() },
});

export class BlockedFetchUrlError extends Error {
  constructor() {
    super("HTTP fetch blocked by outbound URL policy");
    this.name = "BlockedFetchUrlError";
  }
}

/**
 * HTTP-only guarded fetch. It rejects unsafe URL literals before any socket is
 * acquired and never follows redirects without the caller revalidating each hop.
 *
 * The caller must either consume or cancel the response body before reusing the
 * connection. Undici checks destinations on each new connection, not on reuse.
 */
export async function guardedHttpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (!(await validatePublicHttpUrl(url)).ok) {
    throw new BlockedFetchUrlError();
  }

  // Node's built-in fetch supports a per-request dispatcher at runtime.
  // RequestInit omits the Undici-specific extension in its standard DOM type.
  const opts = {
    ...init,
    redirect: "manual" as const,
    dispatcher: httpAgent,
  };
  return fetch(url, opts);
}
