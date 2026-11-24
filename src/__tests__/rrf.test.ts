import { describe, expect, it } from "vitest";
import { rrfRank } from "../search/rrf.js";

type Item = { id: string; label?: string };

const item = (id: string, label?: string): Item => ({ id, label });
const byId = (entry: { item: Item }) => entry.item.id;

describe("rrfRank", () => {
  it("accumulates reciprocal-rank contributions across lists and sorts by score", () => {
    const ranked = rrfRank([[item("a"), item("b")], [item("b")]], { key: (x) => x.id });

    expect(ranked.map(byId)).toEqual(["b", "a"]);
    expect(ranked[0].score).toBeCloseTo(1 / 62 + 1 / 61);
    expect(ranked[1].score).toBeCloseTo(1 / 61);
  });

  it("skips items whose key is null", () => {
    const ranked = rrfRank([[item("a"), item("skip")]], { key: (x) => (x.id === "skip" ? null : x.id) });

    expect(ranked.map(byId)).toEqual(["a"]);
  });

  it("treats an empty string as a valid key", () => {
    const ranked = rrfRank([[item("")]], { key: (x) => x.id });

    expect(ranked.map(byId)).toEqual([""]);
  });

  it("counts a key once per list when dedupeWithinList is set, keeping original ranks", () => {
    const ranked = rrfRank([[item("a"), item("a"), item("c")]], {
      key: (x) => x.id,
      dedupeWithinList: true,
    });

    expect(ranked.map(byId)).toEqual(["a", "c"]);
    expect(ranked[0].score).toBeCloseTo(1 / 61);
    expect(ranked[1].score).toBeCloseTo(1 / 63);
  });

  it("accumulates within-list repeats when dedupe is off", () => {
    const ranked = rrfRank([[item("a"), item("a")]], { key: (x) => x.id });

    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBeCloseTo(1 / 61 + 1 / 62);
  });

  it("calls merge with the accumulated clone, the incoming item, and its rank", () => {
    const calls: Array<{ existingLabel: string | undefined; incomingLabel: string | undefined; rank: number }> = [];
    const ranked = rrfRank([[item("a", "first")], [item("a", "second")]], {
      key: (x) => x.id,
      merge: (existing, incoming, rank) => {
        calls.push({ existingLabel: existing.label, incomingLabel: incoming.label, rank });
        existing.label = "merged";
      },
    });

    expect(calls).toEqual([{ existingLabel: "first", incomingLabel: "second", rank: 1 }]);
    expect(ranked[0].item.label).toBe("merged");
  });

  it("does not mutate input items through the accumulated clone", () => {
    const input = item("a", "original");
    const ranked = rrfRank([[input], [item("a")]], {
      key: (x) => x.id,
      merge: (existing) => {
        existing.label = "changed";
      },
    });

    expect(input.label).toBe("original");
    expect(ranked[0].item.label).toBe("changed");
  });

  it("applies limit after sorting", () => {
    const ranked = rrfRank([[item("a"), item("b")], [item("b")]], { key: (x) => x.id, limit: 1 });

    expect(ranked.map(byId)).toEqual(["b"]);
  });

  it("honors a custom k", () => {
    const ranked = rrfRank([[item("a")]], { key: (x) => x.id, k: 10 });

    expect(ranked[0].score).toBeCloseTo(1 / 11);
  });

  it("keeps first-seen order for equal scores", () => {
    const ranked = rrfRank([[item("a"), item("b"), item("c")]], { key: (x) => x.id });

    expect(ranked.map(byId)).toEqual(["a", "b", "c"]);
  });
});
