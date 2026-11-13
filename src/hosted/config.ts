import type { RateLimits } from "../runtime/invocation-admission.js";

/**
 * Hosted bootstrap config resolution (ADR-0002, ADR-0005). Pure helpers so the
 * security-relevant policy can be unit tested without spawning the server or a
 * membership database. The bootstrap script wires these into the live process.
 */

/**
 * Opt-in sliding-window rate policy. Omitting HOSTED_RATE_WINDOW_MS preserves
 * concurrency-only admission; setting it requires every dimension budget
 * explicitly (ADR-0002:73). Throws on an invalid configured value.
 */
export function resolveRateLimits(env: NodeJS.ProcessEnv): RateLimits | undefined {
  const windowMs = (env.HOSTED_RATE_WINDOW_MS ?? "").trim();
  if (!windowMs) return undefined;
  return {
    global: positiveInt(env, "HOSTED_RATE_GLOBAL"),
    tenant: positiveInt(env, "HOSTED_RATE_TENANT"),
    workspace: positiveInt(env, "HOSTED_RATE_WORKSPACE"),
    principal: positiveInt(env, "HOSTED_RATE_PRINCIPAL"),
    windowMs: positiveInt(env, "HOSTED_RATE_WINDOW_MS"),
  };
}

function positiveInt(env: NodeJS.ProcessEnv, name: string): number {
  const raw = (env[name] ?? "").trim();
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Hosted rate limit ${name} must be a positive integer.`);
  }
  return value;
}

/**
 * Admin/provisioning bind defaults to loopback, independent of the public MCP
 * HOSTED_BIND, so the operator-token surface is not exposed by default (ADR-0006).
 */
export function resolveAdminBind(env: NodeJS.ProcessEnv): string {
  return (env.HOSTED_ADMIN_BIND ?? "").trim() || "127.0.0.1";
}

/** Operator bearer token guards the provisioning surface; require a non-trivial secret. */
const ADMIN_TOKEN_MIN_LENGTH = 32;

export function isValidAdminToken(token: string): boolean {
  return token.length >= ADMIN_TOKEN_MIN_LENGTH;
}
