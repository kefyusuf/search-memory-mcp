#!/usr/bin/env node
/**
 * Downloads a document URL and runs the same extraction the server uses,
 * printing the HTTP details and the extraction result or error.
 *
 * Usage: npm run build && node scripts/diagnose-document.mjs <url>
 * The URL is fetched twice: with default headers, and with the headers the server sends.
 */
import { extractDocument } from "../build/documents/extract.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/diagnose-document.mjs <url>");
  process.exit(2);
}

// Same as BROWSER_HEADERS in src/fetch-module.ts (the server retries with plain headers on 403/503).
const SERVER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

for (const [label, headers] of [["default headers", {}], ["server headers", SERVER_HEADERS]]) {
  console.log(`--- ${label}`);
  await diagnose(headers);
}

async function diagnose(headers) {
  const started = Date.now();
  const response = await fetch(url, { redirect: "follow", headers });
  const data = new Uint8Array(await response.arrayBuffer());
  const head = new TextDecoder("latin1").decode(data.slice(0, 16)).replace(/[^\x20-\x7e]/g, ".");
  console.log(`HTTP ${response.status} in ${Date.now() - started} ms  final URL: ${response.url}`);
  console.log(`content-type: ${response.headers.get("content-type")}  bytes: ${data.byteLength}  starts with: ${JSON.stringify(head)}`);

  try {
    const filename = decodeURIComponent(new URL(response.url).pathname.split("/").pop() ?? "");
    const result = await extractDocument({ data, filename, contentType: response.headers.get("content-type") ?? "" });
    console.log(`format: ${result.format}  title: ${result.title ?? "-"}  chars: ${result.text.length}`);
    console.log(JSON.stringify(result.text.slice(0, 200)));
  } catch (error) {
    console.log(`extraction failed: ${error instanceof Error ? error.stack : String(error)}`);
  }
}
