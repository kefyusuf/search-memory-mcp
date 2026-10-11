import { promises as dns } from "dns";
import { isIP } from "net";

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid_url" | "unsupported_protocol" | "private_host"; hostname?: string };

export function isPrivateIP(ip: string): boolean {
  let addr = ip;
  if (addr.startsWith("::ffff:")) {
    addr = addr.substring(7);
  }

  if (isIP(addr) !== 4) {
    if (addr.startsWith("fc") || addr.startsWith("fd")) return true;
    if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
    if (addr.startsWith("fe80")) return true;
    return false;
  }

  const parts = addr.split(".").map(Number);
  if (parts[0] === 127) return true;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  if (parts[0] === 0) return true;

  return false;
}

export async function isPrivateHost(hostname: string): Promise<boolean> {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower === "localhost6" || lower === "0.0.0.0") {
    return true;
  }

  if (isIP(lower)) {
    return isPrivateIP(lower);
  }

  const addresses = await dns.resolve4(hostname).catch(() => []);
  const addresses6 = await dns.resolve6(hostname).catch(() => []);
  const allAddresses = [...addresses, ...addresses6];

  // Fail closed if DNS supplies no addresses. A failed lookup must not
  // authorize a later connection that can resolve to a private target.
  if (allAddresses.length === 0) return true;

  for (const ip of allAddresses) {
    if (isPrivateIP(ip)) return true;
  }

  return false;
}

export function isSupportedFetchProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

export async function validatePublicHttpUrl(rawUrl: string): Promise<UrlSafetyResult> {
  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (!isSupportedFetchProtocol(parsed.protocol)) {
    return { ok: false, reason: "unsupported_protocol", hostname: parsed.hostname };
  }

  if (await isPrivateHost(parsed.hostname)) {
    return { ok: false, reason: "private_host", hostname: parsed.hostname };
  }

  return { ok: true, url: parsed };
}
