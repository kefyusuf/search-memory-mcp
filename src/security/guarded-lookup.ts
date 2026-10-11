import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Deliberately conservative: these addresses are not normal public egress targets.
// The allow/deny policy must be independently reviewed before wiring this into fetch.
const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedIpv4.addSubnet(address, prefix, "ipv4");
}

const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
const blockedIpv6 = new BlockList();
blockedIpv6.addSubnet("2001:db8::", 32, "ipv6"); // documentation
blockedIpv6.addSubnet("2001::", 32, "ipv6"); // Teredo tunneling
blockedIpv6.addSubnet("2002::", 16, "ipv6"); // 6to4 tunneling

/** Conservative public-address test for an outbound socket, not a generic IP classifier. */
export function isPublicConnectionAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, "ipv4");
  if (family !== 6) return false;

  // Node may return IPv4-mapped IPv6 using dotted or hexadecimal notation.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const upper = Number.parseInt(mapped[1], 16);
    const lower = Number.parseInt(mapped[2], 16);
    return isPublicConnectionAddress(`${upper >> 8}.${upper & 255}.${lower >> 8}.${lower & 255}`);
  }
  return publicIpv6.check(address, "ipv6") && !blockedIpv6.check(address, "ipv6");
}

function blockedLookupError(): NodeJS.ErrnoException {
  return Object.assign(new Error("Blocked non-public outbound address"), { code: "EACCES" });
}

/**
 * Connection-time DNS gate for Node's http/https socket lookup option.
 *
 * The actual socket receives only the approved address(es); no later lookup
 * is performed by the socket. Check EVERY returned candidate: mixed answers
 * must fail rather than silently selecting a public-looking address.
 *
 * Important: Node bypasses lookup() for IP-literal URLs. Callers MUST reject
 * unsafe literals (and unsupported protocols) before using this hook.
 * This primitive is not yet wired into ContentFetcher.
 */
export function createGuardedLookup(
  resolver: typeof systemLookup = systemLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, { all: true, family: options.family, hints: options.hints }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, "", 0);
        return;
      }
      if (!Array.isArray(addresses) || addresses.length === 0 ||
          addresses.some(({ address, family }) => isIP(address) !== family || !isPublicConnectionAddress(address))) {
        callback(blockedLookupError(), "", 0);
        return;
      }

      // Honor the form the socket requested: auto-family selection needs
      // an array; single-address selection needs an address and family.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
