import { assertRequestContext, InvocationError, type RequestContext } from "./request-context.js";

export interface InvocationAdmission {
  acquire(context: RequestContext): (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
}

export type ConcurrencyLimits = Readonly<{ global: number; tenant: number; workspace: number; principal: number }>;

/** Process-local reference policy; replicas require a shared atomic implementation. */
export class InMemoryInvocationAdmission implements InvocationAdmission {
  private readonly limits: ConcurrencyLimits;
  private readonly counts = new Map<string, number>();

  constructor(limits: ConcurrencyLimits) {
    const dimensions = ["global", "tenant", "workspace", "principal"] as const;
    if (!limits || dimensions.some(dimension => !Number.isSafeInteger(limits[dimension]) || limits[dimension] <= 0)) {
      throw new InvocationError("invalid_concurrency_limits");
    }
    this.limits = Object.freeze({ global: limits.global, tenant: limits.tenant, workspace: limits.workspace, principal: limits.principal });
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
