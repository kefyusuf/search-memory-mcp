export type ProviderHealthSnapshot = {
  available: boolean;
  recentAttempts: number;
  recentSuccesses: number;
  recentFailures: number;
  successRate: number | null;
  backoffRemainingMs: number;
};

export class ProviderHealthTracker {
  history = new Map<string, boolean[]>();
  backoffUntil = new Map<string, number>();

  private static readonly WINDOW = 5;
  private static readonly THRESHOLD = 0.4;
  private static readonly BACKOFF_MS = 2 * 60 * 1000;

  record(name: string, success: boolean): void {
    const attempts = this.history.get(name) ?? [];
    attempts.push(success);

    if (attempts.length > ProviderHealthTracker.WINDOW) {
      attempts.splice(0, attempts.length - ProviderHealthTracker.WINDOW);
    }

    this.history.set(name, attempts);

    if (attempts.length === ProviderHealthTracker.WINDOW) {
      const successCount = attempts.filter(Boolean).length;
      const successRate = successCount / ProviderHealthTracker.WINDOW;
      if (successRate <= ProviderHealthTracker.THRESHOLD) {
        this.backoffUntil.set(name, Date.now() + ProviderHealthTracker.BACKOFF_MS);
      }
    }
  }

  isAvailable(name: string): boolean {
    const until = this.backoffUntil.get(name);
    if (until === undefined) {
      return true;
    }

    if (until > Date.now()) {
      return false;
    }

    this.backoffUntil.delete(name);
    return true;
  }

  getSnapshot(name: string): ProviderHealthSnapshot {
    const attempts = this.history.get(name) ?? [];
    const recentSuccesses = attempts.filter(Boolean).length;
    const backoffUntil = this.backoffUntil.get(name);
    const backoffRemainingMs = backoffUntil === undefined ? 0 : Math.max(0, backoffUntil - Date.now());

    return {
      available: this.isAvailable(name),
      recentAttempts: attempts.length,
      recentSuccesses,
      recentFailures: attempts.length - recentSuccesses,
      successRate: attempts.length > 0 ? recentSuccesses / attempts.length : null,
      backoffRemainingMs,
    };
  }
}
