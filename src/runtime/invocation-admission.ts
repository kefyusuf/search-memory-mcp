import { assertRequestContext, InvocationError, type RequestContext } from "./request-context.js";

export interface InvocationAdmission {
  acquire(context: RequestContext): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
}

export type ConcurrencyLimits = Readonly<{ global: number; tenant: number; workspace: number; principal: number }>;
export type RateLimits = ConcurrencyLimits & Readonly<{ windowMs: number }>;

/** Process-local reference policy; replicas require a shared atomic implementation. */
export class InMemoryInvocationAdmission implements InvocationAdmission {
  private readonly limits: ConcurrencyLimits;
  private readonly counts = new Map<string, number>();
  private readonly rateLimits?: RateLimits;
  private readonly rateHistory = new Map<string, number[]>();

  constructor(limits: ConcurrencyLimits, options: { rateLimits?: RateLimits } = {}) {
    const dimensions = ["global", "tenant", "workspace", "principal"] as const;
    if (!limits || dimensions.some(dimension => !Number.isSafeInteger(limits[dimension]) || limits[dimension] <= 0)) {
      throw new InvocationError("invalid_concurrency_limits");
    }
    this.limits = Object.freeze({ global: limits.global, tenant: limits.tenant, workspace: limits.workspace, principal: limits.principal });
    if ("rateLimits" in options) {
      const rate = options.rateLimits;
      if (!rate || [...dimensions, "windowMs" as const].some(dimension => !Number.isSafeInteger(rate[dimension]) || rate[dimension] <= 0)) {
        throw new InvocationError("invalid_rate_limits");
      }
      this.rateLimits = Object.freeze({ global: rate.global, tenant: rate.tenant, workspace: rate.workspace, principal: rate.principal, windowMs: rate.windowMs });
    }
  }

  acquire(context: RequestContext): () => void {
    assertRequestContext(context);
    const buckets: Array<[string, number]> = [
      [JSON.stringify(["global"]), this.limits.global],
      [JSON.stringify(["tenant", context.tenantId]), this.limits.tenant],
      [JSON.stringify(["workspace", context.tenantId, context.workspaceId]), this.limits.workspace],
      [JSON.stringify(["principal", context.principalId]), this.limits.principal],
    ];
    // Check every dimension before mutation; no awaits split admission in this process.
    if (buckets.some(([key, limit]) => (this.counts.get(key) ?? 0) >= limit)) throw new InvocationError("concurrency_exceeded");
    if (this.rateLimits) {
      const now = performance.now(); // Monotonic time avoids wall-clock adjustment resetting quotas.
      const cutoff = now - this.rateLimits.windowMs;
      // Sweep all identities, including inactive ones, so history is bounded by global accepted usage.
      for (const [key, timestamps] of this.rateHistory) {
        const retained = timestamps.filter(timestamp => timestamp > cutoff);
        if (retained.length === 0) this.rateHistory.delete(key); else this.rateHistory.set(key, retained);
      }
      const dimensions = ["global", "tenant", "workspace", "principal"] as const;
      if (buckets.some(([key], index) => (this.rateHistory.get(key)?.length ?? 0) >= this.rateLimits![dimensions[index]])) {
        throw new InvocationError("rate_exceeded");
      }
      for (const [key] of buckets) {
        const timestamps = this.rateHistory.get(key) ?? [];
        timestamps.push(now); this.rateHistory.set(key, timestamps);
      }
    }
    for (const [key] of buckets) this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const [key] of buckets) {
        const remaining = this.counts.get(key)! - 1;
        if (remaining === 0) this.counts.delete(key); else this.counts.set(key, remaining);
      }
    };
  }
}
