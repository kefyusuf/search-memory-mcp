export type UsageSnapshot = {
  /** ISO timestamp of when counting started (server start). */
  since: string;
  totals: { calls: number; errors: number };
  scopes: Array<{ tenantId: string; workspaceId: string; tool: string; calls: number; errors: number }>;
};

/**
 * In-memory hosted tool-call counters, scoped by tenant/workspace/tool.
 * Deliberately process-lifetime only: counters reset on restart, so the
 * snapshot is labeled with `since` — no persistence, no cross-process
 * aggregation (those are later decisions). Every completed dispatcher
 * attempt is recorded, including denied ones (errors subset). Distinct
 * scope keys are bounded so arbitrary tool names cannot grow memory
 * without limit.
 */
const DEFAULT_MAX_ENTRIES = 10_000;

export class UsageCounters {
  private readonly startedAt = new Date();
  private readonly maxEntries: number;
  private readonly entries = new Map<
    string,
    { tenantId: string; workspaceId: string; tool: string; calls: number; errors: number }
  >();
  private overflowCalls = 0;
  private overflowErrors = 0;

  constructor(options: { maxEntries?: number } = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  record(tenantId: string, workspaceId: string, tool: string, ok: boolean): void {
    const key = `${tenantId}|${workspaceId}|${tool}`;
    const entry = this.entries.get(key);
    if (!entry && this.entries.size >= this.maxEntries) {
      // Keep totals truthful without tracking an unbounded number of keys.
      this.overflowCalls += 1;
      if (!ok) this.overflowErrors += 1;
      return;
    }
    const target = entry ?? { tenantId, workspaceId, tool, calls: 0, errors: 0 };
    target.calls += 1;
    if (!ok) target.errors += 1;
    this.entries.set(key, target);
  }

  snapshot(): UsageSnapshot {
    const scopes = [...this.entries.values()].sort(
      (a, b) =>
        a.tenantId.localeCompare(b.tenantId) ||
        a.workspaceId.localeCompare(b.workspaceId) ||
        a.tool.localeCompare(b.tool),
    );
    return {
      since: this.startedAt.toISOString(),
      totals: {
        calls: scopes.reduce((sum, s) => sum + s.calls, 0) + this.overflowCalls,
        errors: scopes.reduce((sum, s) => sum + s.errors, 0) + this.overflowErrors,
      },
      scopes: scopes.map(({ tenantId, workspaceId, tool, calls, errors }) => ({
        tenantId,
        workspaceId,
        tool,
        calls,
        errors,
      })),
    };
  }
}
