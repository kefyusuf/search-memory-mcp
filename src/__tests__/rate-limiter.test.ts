import { describe, it, expect } from "vitest";
import { TokenBucket } from "../rate-limiter.js";

describe("TokenBucket", () => {
  it("should allow consumption up to maxTokens", () => {
    const bucket = new TokenBucket({ maxTokens: 5, refillRatePerSecond: 10 / 60 });
    let count = 0;
    for (let i = 0; i < 10; i++) {
      if (bucket.tryConsume().allowed) count++;
    }
    expect(count).toBe(5);
  });

  it("should block when bucket is empty", () => {
    const bucket = new TokenBucket({ maxTokens: 3, refillRatePerSecond: 1 });
    for (let i = 0; i < 3; i++) bucket.tryConsume();
    const result = bucket.tryConsume();
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("should report correct stats", () => {
    const bucket = new TokenBucket({ maxTokens: 10, refillRatePerSecond: 1 });
    const stats = bucket.getStats();
    expect(stats.available).toBe(10);
    expect(stats.max).toBe(10);
  });

  it("should refill tokens over time", async () => {
    const bucket = new TokenBucket({ maxTokens: 2, refillRatePerSecond: 100 });
    for (let i = 0; i < 2; i++) bucket.tryConsume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const result = bucket.tryConsume();
    expect(result.allowed).toBe(true);
  });
});
