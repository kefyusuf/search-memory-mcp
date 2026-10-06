import { InvocationError } from "./request-context.js";

export type JwtSignatureAlgorithm = "RS256" | "ES256" | "EdDSA";
export type JwtVerificationKey = { kid: string; key: CryptoKey };
export type JwtKeyLease = Readonly<{ key: CryptoKey; isCurrent: () => boolean }>;

export class JwtVerificationKeyRing {
  #keys = new Map<string, Readonly<JwtVerificationKey>>();
  constructor(readonly algorithm: JwtSignatureAlgorithm, keys: readonly JwtVerificationKey[]) {
    if (!["RS256", "ES256", "EdDSA"].includes(algorithm)) throw new InvocationError("invalid_key_ring");
    this.replace(keys);
    Object.freeze(this);
  }

  /** Deployment-owned updates only: token headers never fetch or publish keys. */
  replace(keys: readonly JwtVerificationKey[]): void {
    if (!Array.isArray(keys) || keys.length > 32) throw new InvocationError("invalid_key_ring");
    const next = new Map<string, Readonly<JwtVerificationKey>>();
    for (const entry of keys) {
      if (!entry || !validKid(entry.kid) || next.has(entry.kid) || !validKey(entry.key, this.algorithm)) {
        throw new InvocationError("invalid_key_ring");
      }
      const previous = this.#keys.get(entry.kid);
      next.set(entry.kid, previous && previous.key === entry.key ? previous : Object.freeze({ kid: entry.kid, key: entry.key }));
    }
    // Preserve retained lease identities; publish only after the entire replacement validates.
    this.#keys = next;
  }

  select(kid: unknown): JwtKeyLease {
    if (!validKid(kid)) throw new InvocationError("unauthenticated");
    const entry = this.#keys.get(kid);
    if (!entry) throw new InvocationError("unauthenticated");
    return Object.freeze({ key: entry.key, isCurrent: () => this.#keys.get(kid) === entry });
  }
}

function validKid(kid: unknown): kid is string {
  return typeof kid === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(kid);
}

function validKey(key: unknown, algorithm: JwtSignatureAlgorithm): key is CryptoKey {
  if (!(key instanceof CryptoKey) || key.type !== "public" || !key.usages.includes("verify")) return false;
  if (algorithm === "ES256") {
    const details = key.algorithm as EcKeyAlgorithm;
    return details.name === "ECDSA" && details.namedCurve === "P-256";
  }
  if (algorithm === "RS256") {
    const details = key.algorithm as RsaHashedKeyAlgorithm;
    return details.name === "RSASSA-PKCS1-v1_5" && details.hash?.name === "SHA-256" && details.modulusLength >= 2048;
  }
  return key.algorithm.name === "Ed25519";
}
