import { JSDOM } from "jsdom";
import type { SearchResultItem } from "./cache/types.js";

export type SearchLocale = {
  acceptLanguage: string;
  market: string;
};

function cleanText(value: string | null | undefined): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function stripHtml(html: string): string {
  return cleanText(new JSDOM(`<body>${html}</body>`).window.document.body.textContent);
}

function toAbsoluteUrl(rawUrl: string, baseUrl: string): string {
  if (!rawUrl) return "";
  if (rawUrl.startsWith("//")) return `https:${rawUrl}`;
  try {
    return new URL(rawUrl, baseUrl).toString();
  } catch {
    return rawUrl;
  }
}

function isLikelyUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function normalizeDomainFilter(domain: string | undefined): string | undefined {
  if (!domain) return undefined;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return undefined;

  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.replace(/^www\./, "");
  } catch {
    return trimmed.replace(/^www\./, "").replace(/\/.*$/, "");
  }
}

export function domainMatches(hostname: string, domain: string | undefined): boolean {
  if (!domain) return true;
  const normalizedHost = hostname.toLowerCase().replace(/^www\./, "");
  const normalizedDomain = normalizeDomainFilter(domain);
  if (!normalizedDomain) return true;

  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function filterSearchResultsByDomain(results: SearchResultItem[], domain: string | undefined): SearchResultItem[] {
  const normalizedDomain = normalizeDomainFilter(domain);
  if (!normalizedDomain) return results;

  return results.filter((result) => {
    try {
      return domainMatches(new URL(result.url).hostname, normalizedDomain);
    } catch {
      return false;
    }
  });
}

function localeFromLanguageLabel(language: string): SearchLocale | null {
  const primary = language.split("_")[0]?.toLowerCase();

  switch (primary) {
    case "tur":
      return { acceptLanguage: "tr-TR,tr;q=0.9,en;q=0.7", market: "tr-TR" };
    case "eng":
      return { acceptLanguage: "en-US,en;q=0.9", market: "en-US" };
    case "deu":
      return { acceptLanguage: "de-DE,de;q=0.9,en;q=0.7", market: "de-DE" };
    case "fra":
      return { acceptLanguage: "fr-FR,fr;q=0.9,en;q=0.7", market: "fr-FR" };
    case "spa":
      return { acceptLanguage: "es-ES,es;q=0.9,en;q=0.7", market: "es-ES" };
    case "ita":
      return { acceptLanguage: "it-IT,it;q=0.9,en;q=0.7", market: "it-IT" };
    case "por":
      return { acceptLanguage: "pt-PT,pt;q=0.9,en;q=0.7", market: "pt-PT" };
    case "nld":
      return { acceptLanguage: "nl-NL,nl;q=0.9,en;q=0.7", market: "nl-NL" };
    default:
      return null;
  }
}

export function inferSearchLocale(query: string): SearchLocale {
  const normalized = query.toLowerCase();
  const isTurkish =
    /[çğıöşü]/i.test(query) ||
    /\b(altın|fiyat|döviz|haber|bugün|gram|çeyrek|ons|kur)\b/i.test(normalized);

  if (isTurkish) {
    return {
      acceptLanguage: "tr-TR,tr;q=0.9,en;q=0.7",
      market: "tr-TR",
    };
  }

  return {
    acceptLanguage: "en-US,en;q=0.9",
    market: "en-US",
  };
}

export function resolveSearchLocale(query: string, detectedLanguage?: string | null): SearchLocale {
  const detected = detectedLanguage ? localeFromLanguageLabel(detectedLanguage) : null;
  if (detected) return detected;
  return inferSearchLocale(query);
}

export function decodeDuckDuckGoUrl(rawUrl: string): string {
  const absolute = toAbsoluteUrl(rawUrl, "https://duckduckgo.com");

  try {
    const parsed = new URL(absolute);
    const target = parsed.searchParams.get("uddg");
    if (target) {
      const decoded = decodeURIComponent(target);
      if (isLikelyUrl(decoded)) return decoded;
    }
  } catch {
    return absolute;
  }

  return absolute;
}

export function decodeBingUrl(rawUrl: string): string {
  if (!rawUrl) return "";

  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname !== "www.bing.com" || !parsed.pathname.startsWith("/ck/")) {
      return rawUrl;
    }

    const encodedTarget = parsed.searchParams.get("u");
    if (!encodedTarget) return rawUrl;

    const base64Payload = encodedTarget.startsWith("a1")
      ? encodedTarget.slice(2)
      : encodedTarget;

    const decoded = Buffer.from(base64Payload, "base64").toString("utf-8");
    if (isLikelyUrl(decoded)) return decoded;
  } catch {
    return rawUrl;
  }

  return rawUrl;
}

export function parseDuckDuckGoResults(html: string): SearchResultItem[] {
  const doc = new JSDOM(html, { url: "https://lite.duckduckgo.com" }).window.document;
  const anchors = Array.from(doc.querySelectorAll("a.result-link"));

  return anchors
    .map((anchor) => {
      const url = decodeDuckDuckGoUrl(anchor.getAttribute("href") || "");
      const title = cleanText(anchor.textContent);
      const row = anchor.closest("tr");
      const snippet = cleanText(
        row?.nextElementSibling?.querySelector("td.result-snippet")?.textContent ||
        row?.querySelector("td.result-snippet")?.textContent
      );

      return {
        title,
        url,
        snippet,
        source: "duckduckgo",
      };
    })
    .filter((result) => result.title && isLikelyUrl(result.url))
    .slice(0, 10);
}

export function parseBingResults(html: string): SearchResultItem[] {
  const doc = new JSDOM(html, { url: "https://www.bing.com" }).window.document;

  return Array.from(doc.querySelectorAll(".b_algo"))
    .slice(0, 10)
    .map((element) => {
      const link = element.querySelector("h2 a");
      const rawUrl = link?.getAttribute("href") || "";

      return {
        title: cleanText(link?.textContent),
        url: decodeBingUrl(rawUrl),
        snippet: cleanText(element.querySelector(".b_caption p")?.textContent),
        source: "bing",
      };
    })
    .filter((result) => result.title && isLikelyUrl(result.url));
}

export function parseBraveResults(html: string): SearchResultItem[] {
  const linkPattern = /<a[^>]*class="[^"]*\bl1\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<div[^>]*class="[^"]*(?:content|inline-qa-answer)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;

  const links = Array.from(html.matchAll(linkPattern));
  const snippets = Array.from(html.matchAll(snippetPattern)).map((match) => stripHtml(match[1]));

  return links
    .slice(0, 10)
    .map((match, index) => ({
      title: stripHtml(match[2]),
      url: toAbsoluteUrl(match[1], "https://search.brave.com"),
      snippet: snippets[index] || "",
      source: "brave",
    }))
    .filter((result) => result.title && isLikelyUrl(result.url));
}

export function parseGoogleResults(html: string): SearchResultItem[] {
  const doc = new JSDOM(html, { url: "https://www.google.com" }).window.document;
  const anchors = Array.from(doc.querySelectorAll("a"))
    .filter((anchor) => Boolean(anchor.querySelector("h3")));

  return anchors
    .slice(0, 10)
    .map((anchor) => ({
      title: cleanText(anchor.textContent),
      url: anchor.href,
      snippet: cleanText(
        anchor.parentElement?.parentElement?.querySelector("div[style*='-webkit-line-clamp'], span.aCOpRe")?.textContent
      ),
      source: "google",
    }))
    .filter((result) => result.title && isLikelyUrl(result.url));
}

function decodeYahooUrl(href: string): string {
  // Yahoo wraps result links as https://r.search.yahoo.com/.../RU=<encoded url>/RK=...
  const match = /\/RU=([^/]+)\//.exec(href);
  if (!match) return href;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return href;
  }
}

export function parseYahooResults(html: string): SearchResultItem[] {
  const doc = new JSDOM(html, { url: "https://search.yahoo.com" }).window.document;

  return Array.from(doc.querySelectorAll(".algo"))
    .map((element) => {
      const anchor = element.querySelector(".compTitle a[href]");
      const url = decodeYahooUrl(anchor?.getAttribute("href") || "");
      const title = cleanText(element.querySelector(".compTitle h3")?.textContent);
      const snippet = cleanText(element.querySelector(".compText")?.textContent);
      return { title, url, snippet, source: "yahoo" };
    })
    .filter((result) => result.title && isLikelyUrl(result.url) && !new URL(result.url).hostname.endsWith("yahoo.com"))
    .slice(0, 10);
}

export function parseMarginaliaResults(html: string): SearchResultItem[] {
  const doc = new JSDOM(html, { url: "https://marginalia-search.com" }).window.document;

  return Array.from(doc.querySelectorAll("main h2 a[href]"))
    .map((anchor) => {
      const url = anchor.getAttribute("href") || "";
      const title = cleanText(anchor.textContent);
      const card = anchor.closest("div.border");
      const snippet = cleanText(card?.querySelector("p.mt-2")?.textContent);
      return { title, url, snippet, source: "marginalia" };
    })
    .filter((result) => result.title && isLikelyUrl(result.url) && !new URL(result.url).hostname.endsWith("marginalia-search.com"))
    .slice(0, 10);
}
