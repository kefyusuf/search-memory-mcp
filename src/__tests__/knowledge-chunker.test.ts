import { describe, expect, it } from "vitest";
import { chunkText } from "../knowledge/chunker.js";

describe("chunkText", () => {
  it("returns empty for blank content", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("Short but meaningful paragraph about PostgreSQL pooling.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain("PostgreSQL");
  });

  it("splits on paragraph boundaries and preserves order", () => {
    const content = [
      "First paragraph explains connection pooling basics for PostgreSQL.",
      "Second paragraph discusses PgBouncer multiplexing strategies.",
      "Third paragraph covers pool sizing formulas and trade-offs.",
    ].join("\n\n");

    const chunks = chunkText(content, { minChars: 20, maxChars: 120 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].text).toContain("First paragraph");
    expect(chunks[0].index).toBe(0);
    expect(chunks[1].index).toBe(1);
  });

  it("splits oversized blocks near sentence boundaries", () => {
    const longSentence =
      "This is a very long sentence that keeps going and going with technical detail about database internals. ";
    const content = longSentence.repeat(20).trim();

    const chunks = chunkText(content, { minChars: 10, maxChars: 400, overlapChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // splitLongBlock windows at maxChars; allow small sentence-boundary overshoot.
      expect(chunk.text.length).toBeLessThanOrEqual(480);
    }
  });
});
