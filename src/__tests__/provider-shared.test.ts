import { describe, it, expect } from "vitest";
import { stripTags } from "../providers/shared.js";

describe("stripTags", () => {
  it("removes HTML tags and trims the ends", () => {
    expect(stripTags("  <b>Hello</b> world  ")).toBe("Hello world");
  });

  it("returns plain text unchanged", () => {
    expect(stripTags("plain text")).toBe("plain text");
  });

  it("returns an empty string for empty input", () => {
    expect(stripTags("")).toBe("");
  });

  it("strips tags that carry attributes", () => {
    expect(stripTags('<a href="https://x.example">link</a>')).toBe("link");
  });

  it("preserves internal whitespace left between stripped tags", () => {
    expect(stripTags("<p>a</p>  <p>b</p>")).toBe("a  b");
  });
});
