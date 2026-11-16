/**
 * Opt-in sliding-window throttle for the operator admin surface (ADR-0006).
 * Checked before token authentication so repeated guesses cannot hammer the
 * timing-safe compare. Keys are socket peer addresses; proxy headers are never
 * trusted. Process-local by design: the admin surface is a single-process
 * loopback-first operator tool, so a distributed limiter is out of scope.
 */
export type AdminRateLimit = Readonly<{ limit: number; windowMs: number }>;

export class AdminRateLimiter {
  private readonly history = new Map<string, number[]>();

  constructor(private readonly limit: AdminRateLimit) {
    if (
      !limit ||
      !Number.isSafeInteger(limit.limit) ||
      limit.limit <= 0 ||
      !Number.isSafeInteger(limit.windowMs) ||
      limit.windowMs <= 0
    ) {
      throw new Error("invalid_admin_rate_limit");
    }
  }

  /** True when this peer may proceed; every call counts toward the window, allowed or not. */
  check(key: string): boolean {
    const now = performance.now(); // Monotonic time avoids wall-clock adjustment resetting quotas.
    const cutoff = now - this.limit.windowMs;
    // Sweep every peer, including idle ones, so history is bounded by window traffic.
    for (const [peer, timestamps] of this.history) {
      const retained = timestamps.filter((timestamp) => timestamp > cutoff);
      if (retained.length === 0) this.history.delete(peer);
      else this.history.set(peer, retained);
    }
    const timestamps = this.history.get(key) ?? [];
    if (timestamps.length >= this.limit.limit) return false;
    timestamps.push(now);
    this.history.set(key, timestamps);
    return true;
  }
}
