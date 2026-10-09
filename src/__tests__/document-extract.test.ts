import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { DocumentExtractionError, extractDocument } from "../documents/extract.js";
import { docx, epub, pdf } from "./document-fixtures.js";

describe("extractDocument", () => {
  it("extracts PDF text and title", async () => {
    const result = await extractDocument({ data: pdf("Kubernetes uses PgBouncer"), filename: "pool.pdf" });
    expect(result).toMatchObject({ format: "pdf", title: "Sample PDF" });
    expect(result.text).toContain("Kubernetes uses PgBouncer");
  });

  it("extracts DOCX paragraphs in order with the core title", async () => {
    const result = await extractDocument({ data: docx(["First paragraph.", "Second & last."], "Pooling notes") });
    expect(result).toEqual({ format: "docx", title: "Pooling notes", text: "First paragraph.\n\nSecond & last." });
  });

  it("extracts EPUB chapters in spine order without markup", async () => {
    const result = await extractDocument({
      data: epub([
        { id: "ch1", html: "<h1>One</h1><p>Chapter one text.</p>" },
        { id: "ch2", html: "<h1>Two</h1><p>Chapter two text.</p>" },
      ], "Sample Book"),
      filename: "book.epub",
    });
    expect(result.format).toBe("epub");
    expect(result.title).toBe("Sample Book");
    expect(result.text.indexOf("Chapter two text.")).toBeLessThan(result.text.indexOf("Chapter one text."));
    expect(result.text).not.toMatch(/<|p\{\}/);
  });

  it("converts HTML to Markdown and passes plain text through", async () => {
    const html = await extractDocument({ data: strToU8("<html><head><title>Doc</title></head><body><h1>Hello</h1><p>World</p></body></html>"), contentType: "text/html; charset=utf-8" });
    expect(html).toMatchObject({ format: "html", title: "Doc" });
    expect(html.text).toContain("# Hello");
    expect(html.text).toContain("World");

    const text = await extractDocument({ data: strToU8("# Notes\n\nPlain markdown."), filename: "notes.md" });
    expect(text).toEqual({ format: "text", text: "# Notes\n\nPlain markdown." });
  });

  it("rejects unsupported and oversized input", async () => {
    await expect(extractDocument({ data: new Uint8Array([0, 1, 2, 3]), filename: "image.png" }))
      .rejects.toMatchObject({ code: "unsupported_format" });
    await expect(extractDocument({ data: zipSync({ "random.txt": strToU8("x") }) }))
      .rejects.toMatchObject({ code: "unsupported_format" });
    await expect(extractDocument({ data: strToU8("x".repeat(101)), filename: "a.txt" }, { maxBytes: 100 }))
      .rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses archives that expand beyond the limit", async () => {
    const bomb = docx(["a".repeat(200_000)]);
    await expect(extractDocument({ data: bomb }, { maxExpandedBytes: 100_000 }))
      .rejects.toBeInstanceOf(DocumentExtractionError);
  });

  it("caps extracted text length", async () => {
    const result = await extractDocument({ data: strToU8("y".repeat(500)), filename: "a.txt" }, { maxChars: 100 });
    expect(result.text).toHaveLength(100);
  });
});
