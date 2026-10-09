import { afterEach, describe, expect, it, vi } from "vitest";
import { searchGoogle } from "../providers/google.js";
import type { SearchLocale } from "../search-utils.js";

const locale: SearchLocale = { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };

// Trimmed from a real HTTP 200 response (2026-10): Google serves no results
// to clients without JavaScript and redirects them to an "enable JS" page.
const ENABLE_JS_PAGE = `<!DOCTYPE html><html lang="tr"><head><title>Google Search</title></head><body>
<noscript><meta content="0;url=/httpservice/retry/enablejs?sei=abc" http-equiv="refresh">
<div style="display:block">Birkaç saniye içinde yönlendirilmezseniz <a href="/httpservice/retry/enablejs?sei=abc">burayı</a> tıklayın.</div></noscript>
</body></html>`;

afterEach(() => vi.unstubAllGlobals());

describe("Google provider", () => {
  it("reports the JavaScript-required page as an error, not as no results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ENABLE_JS_PAGE, { status: 200 })));
    await expect(searchGoogle("node.js 22 release notes", locale))
      .rejects.toThrow("google returned a JavaScript-required page");
  });

  it("still parses a normal results page", async () => {
    const html = `<html><body><div><a href="https://nodejs.org/en/blog/release/v22.0.0"><h3>Node.js 22 release</h3></a></div></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));
    await expect(searchGoogle("node.js 22", locale)).resolves.toEqual([
      expect.objectContaining({ url: "https://nodejs.org/en/blog/release/v22.0.0", title: "Node.js 22 release" }),
    ]);
  });
});
