import { strToU8, zipSync } from "fflate";

// Document fixtures built in code so no binary files are committed.

/** Smallest valid single-page PDF with one line of text, with a correct xref table. */
export function pdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Title (Sample PDF) >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(body);
}

export function docx(paragraphs: string[], title?: string): Uint8Array {
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r></w:p>`).join("");
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`),
    ...(title ? { "docProps/core.xml": strToU8(`<?xml version="1.0"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`) } : {}),
  });
}

export function epub(chapters: Array<{ id: string; html: string }>, title: string): Uint8Array {
  const manifest = chapters.map(({ id }) => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join("");
  // Spine order is reversed relative to the manifest to prove the spine decides reading order.
  const spine = [...chapters].reverse().map(({ id }) => `<itemref idref="${id}"/>`).join("");
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>${title}</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`),
  };
  for (const { id, html } of chapters) {
    files[`OEBPS/${id}.xhtml`] = strToU8(`<html><head><title>x</title><style>p{}</style></head><body>${html}</body></html>`);
  }
  return zipSync(files);
}
