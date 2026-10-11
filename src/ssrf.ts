import { promises as dns } from "dns";
import { isIP } from "net";

export type UrlSafetyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid_url" | "unsupported_protocol" | "private_host"; hostname?: string };

export function isPrivateIP(ip: string): boolean {
  let addr = ip.toLowerCase();

  if (isIP(addr) === 6) {
    // Normalize expanded IPv6 and IPv4-embedded spellings before checking
    // mapped IPv4 addresses (e.g. ::ffff:7f00:1 -> 127.0.0.1).
    addr = new URL(`http://[${addr}]/`).hostname.slice(1, -1);
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isPrivateIP(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
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
  // URL.hostname includes brackets around IPv6 literals; net.isIP does not
  // accept those brackets, and DNS must never be queried for an IP literal.
  const lower = hostname.toLowerCase();
  const host = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;

  if (lower === "localhost" || lower === "localhost6" || lower === "0.0.0.0") {
    return true;
  }

  if (isIP(host)) {
    return isPrivateIP(host);
  }

  const addresses = await dns.resolve4(host).catch(() => []);
  const addresses6 = await dns.resolve6(host).catch(() => []);
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
