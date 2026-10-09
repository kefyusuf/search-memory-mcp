import { JSDOM } from "jsdom";
import { parseMarginaliaResults, type SearchLocale } from "../search-utils.js";
import type { SearchResultItem } from "../cache/types.js";

const MAX_WAIT_MS = 5_000;

type WaitPage = { continueUrl: string; waitMs: number };

/**
 * Under load Marginalia answers with a "Wait A Moment" page that asks the client to
 * wait a second and then follow a one-time link (offered in <noscript> for clients
 * without JavaScript). Returns that link and the requested wait, or null.
 */
function readWaitPage(html: string): WaitPage | null {
  if (!html.includes("Wait A Moment")) return null;
  const doc = new JSDOM(html, { url: "https://marginalia-search.com" }).window.document;
  // jsdom parses <noscript> as markup because it runs without scripting.
  const href = doc.querySelector("main noscript a[href]")?.getAttribute("href");
  if (!href) return null;
  const seconds = Number(doc.querySelector("#countdown")?.getAttribute("data-tr") ?? "1");
  const waitMs = Math.min(MAX_WAIT_MS, (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
  return { continueUrl: new URL(href, "https://marginalia-search.com").toString(), waitMs };
}

async function fetchPage(url: string, locale: SearchLocale): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": locale.acceptLanguage,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`marginalia returned HTTP ${response.status}`);
  }
  return response.text();
}

/** Marginalia: an independent index that favours non-commercial, text-heavy sites. */
export async function searchMarginalia(
  query: string,
  locale: SearchLocale,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<SearchResultItem[]> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let html = await fetchPage(`https://marginalia-search.com/search?query=${encodeURIComponent(query)}`, locale);

  const wait = readWaitPage(html);
  if (wait) {
    await sleep(wait.waitMs);
    html = await fetchPage(wait.continueUrl, locale);
    if (readWaitPage(html)) throw new Error("marginalia served a bot-check page");
  }

  return parseMarginaliaResults(html);
}
