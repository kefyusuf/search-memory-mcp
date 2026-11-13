export type StageStatus = "ok" | "empty" | "error" | "skipped";

export type TraceStage = {
  name: string;
  status: StageStatus;
  durationMs: number;
  resultCount?: number;
  error?: string;
};

export type TraceMeta = {
  [key: string]: string | number | boolean | undefined;
};

export type TraceSnapshot = {
  query: string;
  totalMs: number;
  meta: TraceMeta;
  stages: TraceStage[];
};

type RunningStage = {
  name: string;
  startedAt: number;
};

export class SearchTrace {
  private readonly query: string;
  private readonly startedAt = Date.now();
  private readonly stages: TraceStage[] = [];
  private readonly running = new Map<string, RunningStage>();
  private meta: TraceMeta = {};

  constructor(query: string) {
    this.query = query;
  }

  setMeta(meta: TraceMeta): void {
    this.meta = { ...this.meta, ...meta };
  }

  startStage(name: string): void {
    this.running.set(name, { name, startedAt: Date.now() });
  }

  endStage(name: string, outcome?: { status?: StageStatus; resultCount?: number; error?: string }): void {
    const running = this.running.get(name);
    const durationMs = running ? Date.now() - running.startedAt : 0;
    this.running.delete(name);

    this.stages.push({
      name,
      status: outcome?.status ?? "ok",
      durationMs,
      resultCount: outcome?.resultCount,
      error: outcome?.error,
    });
  }

  failStage(name: string, error: string): void {
    this.endStage(name, { status: "error", error });
  }

  skipStage(name: string, reason?: string): void {
    this.endStage(name, { status: "skipped", error: reason });
  }

  toJSON(): TraceSnapshot {
    return {
      query: this.query,
      totalMs: Date.now() - this.startedAt,
      meta: { ...this.meta },
      stages: [...this.stages],
    };
  }
}

export function formatTraceSummary(trace: SearchTrace): string {
  const snapshot = trace.toJSON();
  const metaParts = Object.entries(snapshot.meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);

  const lines = snapshot.stages.map((stage) => {
    const extras = [
      stage.resultCount !== undefined ? `results=${stage.resultCount}` : null,
      stage.error ? `err=${stage.error}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return `  ${stage.name}: ${stage.status} ${stage.durationMs}ms${extras ? ` ${extras}` : ""}`;
  });

  return [
    `search trace: ${snapshot.query}`,
    `  total=${snapshot.totalMs}ms${metaParts.length ? ` ${metaParts.join(" ")}` : ""}`,
    ...lines,
  ].join("\n");
}
