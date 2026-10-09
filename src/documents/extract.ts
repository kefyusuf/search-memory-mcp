import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { extractText, getDocumentProxy, getMeta } from "unpdf";
import { normalizePublishedDate } from "./dates.js";

export type DocumentFormat = "pdf" | "docx" | "epub" | "html" | "text";

export type ExtractedDocument = {
  format: DocumentFormat;
  title?: string;
  /** Publication date (YYYY-MM-DD) from the document metadata, when present. */
  publishedAt?: string;
  text: string;
};

export type DocumentInput = {
  data: Uint8Array;
  filename?: string;
  contentType?: string;
};

export type ExtractionLimits = {
  /** Largest input accepted, in bytes. */
  maxBytes?: number;
  /** Largest total uncompressed size read from a DOCX/EPUB archive. */
  maxExpandedBytes?: number;
  /** Extracted text is cut to this many characters. */
  maxChars?: number;
};

export class DocumentExtractionError extends Error {
  constructor(readonly code: "unsupported_format" | "too_large" | "invalid_document", message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

const DEFAULT_LIMITS: Required<ExtractionLimits> = {
  maxBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxChars: 2_000_000,
};

const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|json|log|rst)$/i;
const HTML_EXTENSIONS = /\.(html?|xhtml)$/i;

/** Extracts readable text from PDF, DOCX, EPUB, HTML or plain-text bytes. */
export async function extractDocument(input: DocumentInput, limits: ExtractionLimits = {}): Promise<ExtractedDocument> {
  const { maxBytes, maxExpandedBytes, maxChars } = { ...DEFAULT_LIMITS, ...limits };
  if (input.data.byteLength > maxBytes) {
    throw new DocumentExtractionError("too_large", `Document is larger than ${maxBytes} bytes.`);
  }

  const result = await extractByFormat(input, maxExpandedBytes);
  const text = normalizeText(result.text).slice(0, maxChars);
  return {
    format: result.format,
    ...(result.title ? { title: result.title } : {}),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    text,
  };
}

async function extractByFormat(input: DocumentInput, maxExpandedBytes: number): Promise<ExtractedDocument> {
  const { data, filename = "", contentType = "" } = input;
  if (startsWith(data, "%PDF-")) return extractPdf(data);
  if (startsWith(data, "PK\u0003\u0004")) return extractArchive(data, maxExpandedBytes);
  if (/html/i.test(contentType) || HTML_EXTENSIONS.test(filename)) return extractHtml(strFromU8(data));
  if (/^text\//i.test(contentType) || /json/i.test(contentType) || TEXT_EXTENSIONS.test(filename)) {
    return { format: "text", text: strFromU8(data) };
  }
  throw new DocumentExtractionError("unsupported_format", "Supported formats: PDF, DOCX, EPUB, HTML and plain text.");
}

function startsWith(data: Uint8Array, signature: string): boolean {
  if (data.byteLength < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (data[i] !== signature.charCodeAt(i)) return false;
  }
  return true;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function extractPdf(data: Uint8Array): Promise<ExtractedDocument> {
  try {
    // pdf.js may detach the buffer it is given; keep the caller's bytes intact.
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const [{ text }, meta] = await Promise.all([
      extractText(pdf, { mergePages: false }),
      getMeta(pdf).catch(() => ({ info: {} as Record<string, unknown> })),
    ]);
    const title = typeof meta.info?.Title === "string" && meta.info.Title.trim() ? meta.info.Title.trim() : undefined;
    const publishedAt = typeof meta.info?.CreationDate === "string" ? normalizePublishedDate(meta.info.CreationDate) : undefined;
    return { format: "pdf", title, publishedAt, text: (text as string[]).join("\n\n") };
  } catch (error) {
    throw new DocumentExtractionError("invalid_document", `Could not read PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Unzips only the entries `wanted` accepts, refusing archives that expand past the limit. */
function unzipEntries(data: Uint8Array, wanted: (name: string) => boolean, maxExpandedBytes: number): Record<string, Uint8Array> {
  let expanded = 0;
  try {
    return unzipSync(data, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        expanded += file.originalSize;
        if (expanded > maxExpandedBytes) {
          throw new DocumentExtractionError("too_large", `Archive expands beyond ${maxExpandedBytes} bytes.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DocumentExtractionError) throw error;
    throw new DocumentExtractionError("invalid_document", `Could not read archive: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractArchive(data: Uint8Array, maxExpandedBytes: number): ExtractedDocument {
  const index = unzipEntries(data, (name) => name === "mimetype" || name === "word/document.xml", maxExpandedBytes);
  if (index["word/document.xml"]) return extractDocx(data, maxExpandedBytes);
  if (index.mimetype && strFromU8(index.mimetype).trim() === "application/epub+zip") return extractEpub(data, maxExpandedBytes);
  throw new DocumentExtractionError("unsupported_format", "ZIP archive is not a DOCX or EPUB document.");
}

function parseXml(xml: string): Document {
  return new JSDOM(xml, { contentType: "text/xml" }).window.document;
}

function extractDocx(data: Uint8Array, maxExpandedBytes: number): ExtractedDocument {
  const files = unzipEntries(data, (name) => name === "word/document.xml" || name === "docProps/core.xml", maxExpandedBytes);
  const document = parseXml(strFromU8(files["word/document.xml"]));
  const paragraphs = [...document.getElementsByTagNameNS(WORD_NS, "p")]
    .map((paragraph) => [...paragraph.getElementsByTagNameNS(WORD_NS, "t")].map((node) => node.textContent ?? "").join(""))
    .filter((text) => text.trim().length > 0);
  const core = files["docProps/core.xml"] ? parseXml(strFromU8(files["docProps/core.xml"])) : null;
  const title = core?.getElementsByTagNameNS(DC_NS, "title")[0]?.textContent?.trim() || undefined;
  return { format: "docx", title, text: paragraphs.join("\n\n") };
}

function resolvePath(base: string, href: string): string {
  const parts = [...base.split("/").slice(0, -1), ...decodeURIComponent(href.split("#")[0]).split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part && part !== ".") resolved.push(part);
  }
  return resolved.join("/");
}

function extractEpub(data: Uint8Array, maxExpandedBytes: number): ExtractedDocument {
  const container = unzipEntries(data, (name) => name === "META-INF/container.xml", maxExpandedBytes)["META-INF/container.xml"];
  const opfPath = container && parseXml(strFromU8(container)).getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new DocumentExtractionError("invalid_document", "EPUB has no package document.");

  const opfData = unzipEntries(data, (name) => name === opfPath, maxExpandedBytes)[opfPath];
  if (!opfData) throw new DocumentExtractionError("invalid_document", "EPUB package document is missing.");
  const opf = parseXml(strFromU8(opfData));
  const title = opf.getElementsByTagNameNS(DC_NS, "title")[0]?.textContent?.trim() || undefined;
  const manifest = new Map([...opf.getElementsByTagName("item")].map((item) => [item.getAttribute("id"), item.getAttribute("href")]));
  const chapterPaths = [...opf.getElementsByTagName("itemref")]
    .map((ref) => manifest.get(ref.getAttribute("idref")))
    .filter((href): href is string => Boolean(href))
    .map((href) => resolvePath(opfPath, href));

  const wanted = new Set(chapterPaths);
  const chapters = unzipEntries(data, (name) => wanted.has(name), maxExpandedBytes);
  const text = chapterPaths
    .map((path) => chapters[path] ? htmlToMarkdown(strFromU8(chapters[path])).text : "")
    .filter(Boolean)
    .join("\n\n");
  return { format: "epub", title, text };
}

function htmlToMarkdown(html: string): { title?: string; text: string } {
  const document = new JSDOM(html).window.document;
  document.querySelectorAll("script, style, noscript").forEach((node) => node.remove());
  const title = document.title.trim() || undefined;
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  return { title, text: turndown.turndown(document.body?.innerHTML ?? "") };
}

function extractHtml(html: string): ExtractedDocument {
  const { title, text } = htmlToMarkdown(html);
  return title ? { format: "html", title, text } : { format: "html", text };
}
