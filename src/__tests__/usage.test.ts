import { describe, expect, it } from "vitest";
import { UsageCounters } from "../hosted/usage.js";

describe("UsageCounters", () => {
  it("aggregates calls and errors per tenant/workspace/tool", () => {
    const usage = new UsageCounters();
    usage.record("tenant-a", "workspace-a1", "web_search", true);
    usage.record("tenant-a", "workspace-a1", "web_search", true);
    usage.record("tenant-a", "workspace-a1", "remember", true);
    usage.record("tenant-b", "workspace-b1", "web_search", false);

    const snapshot = usage.snapshot();
    expect(snapshot.totals).toEqual({ calls: 4, errors: 1 });
    // Scopes are sorted by tenant | workspace | tool.
    expect(snapshot.scopes).toEqual([
      { tenantId: "tenant-a", workspaceId: "workspace-a1", tool: "remember", calls: 1, errors: 0 },
      { tenantId: "tenant-a", workspaceId: "workspace-a1", tool: "web_search", calls: 2, errors: 0 },
      { tenantId: "tenant-b", workspaceId: "workspace-b1", tool: "web_search", calls: 1, errors: 1 },
    ]);
  });

  it("labels the snapshot with the counting start and stays deterministic", () => {
    const usage = new UsageCounters();
    const first = usage.snapshot();
    usage.record("tenant-a", "ws", "web_search", true);
    const second = usage.snapshot();
    expect(second.since).toBe(first.since);
    expect(second.totals.calls).toBe(1);
    expect(new Date(second.since).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
