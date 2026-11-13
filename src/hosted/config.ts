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
