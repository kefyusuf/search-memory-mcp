import { normalizePublishedDate } from "./documents/dates.js";
import { extractDocument } from "./documents/extract.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { LRUCache } from "lru-cache";
import type { BrowserContext } from "playwright";
import TurndownService from "turndown";
import iconv from "iconv-lite";
import type { SearchIntent } from "./search/intent.js";
import type { SemanticCache } from "./cache/semantic-cache.js";
import { validatePublicHttpUrl } from "./ssrf.js";

type WaitUntilMode = "domcontentloaded" | "networkidle";

export type FetchArticle = {
  url: string;
  title: string;
  content: string;
  fullText: string;
  /** Publication date (YYYY-MM-DD) found in the page or document metadata. */
  publishedAt?: string;
};

type FetchFailure = {
  kind: "error";
  reason: "fetch_failed" | "parse_failed" | "blocked_url";
};

type FetchArticleResult = {
  kind: "article";
  article: FetchArticle;
  source: "http" | "playwright" | "page-cache" | "github-raw" | "rss";
};

type HttpFetchResult =
  | { kind: "html"; html: string; buffer: Buffer }
  | { kind: "document"; data: Uint8Array; contentType: string; url: string }
  | { kind: "document_too_large" }
  | { kind: "blocked" }
  | null;

type TextFetchResult =
  | { kind: "text"; url: string; text: string; contentType: string }
  | { kind: "blocked" }
  | null;

export type FetchContentResult =
  | {
      kind: "content";
      text: string;
      source: "content-cache" | "http" | "playwright" | "github-raw" | "rss";
      /** When the text was fetched from the web (ISO 8601); for cache hits, the original fetch. */
      fetchedAt: string;
      /** Publication date (YYYY-MM-DD) found in the page or document, when present. */
      publishedAt?: string;
    }
  | FetchFailure;

type ContentFetcherOptions = {
  cache: SemanticCache;
  getBrowserContext: () => Promise<BrowserContext>;
  fetchWaitUntil: WaitUntilMode;
  detectIntent?: ((text: string) => Promise<SearchIntent>) | null;
  maxContentChars?: number;
  /** Largest PDF/DOCX/EPUB response downloaded for extraction (default 25 MB). */
  maxDocumentBytes?: number;
  forcePlaywright?: () => boolean;
};

const DOCUMENT_CONTENT_TYPES = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/epub\+zip)\b/i;
const DOCUMENT_EXTENSIONS = /\.(pdf|docx|epub)$/i;

/** Document responses are recognized by content type, or by extension when served as a generic binary. */
function isDocumentResponse(contentType: string, url: string): boolean {
  if (DOCUMENT_CONTENT_TYPES.test(contentType)) return true;
  const generic = contentType === "" || /^(application\/octet-stream|binary\/octet-stream)\b/i.test(contentType);
  return generic && DOCUMENT_EXTENSIONS.test(new URL(url).pathname);
}

/** Reads at most maxBytes of a body; null when the declared or actual size is larger. */
async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export class ContentFetcher {
  private static readonly MAX_HTTP_REDIRECTS = 5;

  private readonly cache: SemanticCache;
  private readonly getBrowserContext: () => Promise<BrowserContext>;
  private readonly fetchWaitUntil: WaitUntilMode;
  private readonly detectIntent: ((text: string) => Promise<SearchIntent>) | null;
  private readonly maxContentChars: number;
  private readonly maxDocumentBytes: number;
  private readonly forcePlaywright: () => boolean;
  private readonly turndown: TurndownService;
  private readonly pageCache: LRUCache<string, FetchArticle>;

  constructor(options: ContentFetcherOptions) {
    this.cache = options.cache;
    this.getBrowserContext = options.getBrowserContext;
    this.fetchWaitUntil = options.fetchWaitUntil;
    this.detectIntent = options.detectIntent ?? null;
    this.maxContentChars = options.maxContentChars ?? 50_000;
    this.maxDocumentBytes = options.maxDocumentBytes ?? 25 * 1024 * 1024;
    this.forcePlaywright = options.forcePlaywright ?? (() => isEnabledEnvFlag(process.env.FORCE_PLAYWRIGHT));
    this.turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
    });
    this.pageCache = new LRUCache({
      max: 100,
      ttl: 10 * 60 * 1000,
    });
  }

  close(): void {
    this.pageCache.clear();
  }

  async fetchContent(url: string, forceRefresh: boolean = false): Promise<FetchContentResult> {
    if (!forceRefresh) {
      const cached = await this.cache.getCachedContentEntry(url);
      if (cached) {
        return {
          kind: "content",
          text: cached.content,
          source: "content-cache",
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          ...(cached.publishedAt ? { publishedAt: cached.publishedAt } : {}),
        };
      }
    }

    const result = await this.acquireArticle(url, {
      allowPageCache: false,
      persistContentCache: true,
      useConfiguredWaitUntil: true,
    });

    if (result.kind === "error") {
      return result;
    }

    return {
      kind: "content",
      text: result.article.fullText,
      source: result.source === "page-cache" ? "http" : result.source,
      fetchedAt: new Date().toISOString(),
      ...(result.article.publishedAt ? { publishedAt: result.article.publishedAt } : {}),
    };
  }

  async fetchPage(url: string): Promise<FetchArticle | null> {
    const result = await this.acquireArticle(url, {
      allowPageCache: true,
      persistContentCache: false,
      useConfiguredWaitUntil: false,
    });
    return result.kind === "article" ? result.article : null;
  }

  private async acquireArticle(
    url: string,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
      useConfiguredWaitUntil: boolean;
    }
  ): Promise<FetchArticleResult | FetchFailure> {
    if (!(await this.isFetchUrlAllowed(url))) {
      return { kind: "error", reason: "blocked_url" };
    }

    if (options.allowPageCache) {
      const cachedPage = this.pageCache.get(url);
      if (cachedPage) {
        console.error(`Page cache hit: ${url}`);
        return {
          kind: "article",
          article: cachedPage,
          source: "page-cache",
        };
      }
    }

    if (!this.forcePlaywright()) {
      const fastPathResult = await this.fetchViaFastPath(url);
      if (fastPathResult?.kind === "blocked") {
        return { kind: "error", reason: "blocked_url" };
      }

      if (fastPathResult) {
        await this.persistArticle(fastPathResult.article, options);
        return fastPathResult;
      }

      const httpResult = await this.fetchViaHttp(url);
      if (httpResult?.kind === "blocked") {
        return { kind: "error", reason: "blocked_url" };
      }

      if (httpResult?.kind === "document_too_large") {
        return { kind: "error", reason: "fetch_failed" };
      }

      if (httpResult?.kind === "document") {
        // A browser cannot render document text better than the extractor, so no Playwright fallback.
        const documentArticle = await this.parseDocumentToArticle(httpResult);
        if (!documentArticle) return { kind: "error", reason: "parse_failed" };
        await this.persistArticle(documentArticle, options);
        return { kind: "article", article: documentArticle, source: "http" };
      }

      if (httpResult) {
        const parsedArticle = this.parseHtmlToArticle(httpResult.html, url);
        if (parsedArticle) {
          await this.persistArticle(parsedArticle, options);
          return {
            kind: "article",
            article: parsedArticle,
            source: "http",
          };
        }
      }
    }

    return this.fetchViaPlaywright(url, options);
  }

  private async fetchViaPlaywright(
    url: string,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
      useConfiguredWaitUntil: boolean;
    }
  ): Promise<FetchArticleResult | FetchFailure> {
    const context = await this.getBrowserContext();
    const page = await context.newPage();

    try {
      let response;
      const waitUntil = options.useConfiguredWaitUntil ? this.fetchWaitUntil : "domcontentloaded";

      await page.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        if (await this.isFetchUrlAllowed(requestUrl)) {
          await route.continue();
          return;
        }

        console.error(`Blocked private or unsupported Playwright request: ${requestUrl}`);
        await route.abort("blockedbyclient");
      });

      try {
        response = await page.goto(url, { waitUntil, timeout: 30000 });
      } catch (error) {
        const shouldRetry =
          options.useConfiguredWaitUntil &&
          this.fetchWaitUntil === "networkidle" &&
          error instanceof Error &&
          error.name === "TimeoutError";

        if (!shouldRetry) throw error;

        console.error(`Fetch navigation timed out with networkidle for ${url}, retrying with domcontentloaded`);
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      }

      const buffer = await response?.body();
      if (!buffer) {
        return { kind: "error", reason: "fetch_failed" };
      }

      const article = this.parseHtmlToArticle(this.decodeHtmlBuffer(buffer), url);
      if (!article) {
        return { kind: "error", reason: "parse_failed" };
      }

      await this.persistArticle(article, options);
      return {
        kind: "article",
        article,
        source: "playwright",
      };
    } catch {
      return { kind: "error", reason: "fetch_failed" };
    } finally {
      try {
        await page.close();
      } catch (error) {
        console.error("Error closing page:", error);
      }
    }
  }

  private async persistArticle(
    article: FetchArticle,
    options: {
      allowPageCache: boolean;
      persistContentCache: boolean;
    }
  ): Promise<void> {
    if (options.allowPageCache) {
      this.pageCache.set(article.url, article);
    }

    if (!options.persistContentCache) {
      return;
    }

    const intent = await this.detectArticleIntent(article);
      await this.cache.setCachedContent(article.url, article.fullText, article.title, intent, article.publishedAt);
  }

  private async fetchViaFastPath(url: string): Promise<FetchArticleResult | { kind: "blocked" } | null> {
    const githubArticle = await this.fetchGitHubRawArticle(url);
    if (githubArticle === "blocked") return { kind: "blocked" };
    if (githubArticle) {
      return {
        kind: "article",
        article: githubArticle,
        source: "github-raw",
      };
    }

    const rssArticle = await this.fetchRssArticle(url);
    if (rssArticle === "blocked") return { kind: "blocked" };
    if (rssArticle) {
      return {
        kind: "article",
        article: rssArticle,
        source: "rss",
      };
    }

    return null;
  }

  private async fetchGitHubRawArticle(url: string): Promise<FetchArticle | "blocked" | null> {
    const candidates = toGitHubRawCandidates(url);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const result = await this.fetchText(candidate, "text/markdown,text/plain,*/*");
      if (result?.kind === "blocked") return "blocked";
      if (!result || result.text.trim().length < 20) continue;

      return this.parseMarkdownToArticle(result.text, url, result.url);
    }

    return null;
  }

  private async fetchRssArticle(url: string): Promise<FetchArticle | "blocked" | null> {
    const candidates = toRssCandidates(url);
    if (candidates.length === 0) return null;

    for (const candidate of candidates) {
      const result = await this.fetchText(candidate, "application/rss+xml,application/atom+xml,text/xml,application/xml,*/*");
      if (result?.kind === "blocked") return "blocked";
      if (!result || !looksLikeFeed(result.text)) continue;

      const article = this.parseRssToArticle(result.text, url, result.url);
      if (article) return article;
    }

    return null;
  }

  private async detectArticleIntent(article: FetchArticle): Promise<SearchIntent | undefined> {
    if (!this.detectIntent) {
      return undefined;
    }

    return this.detectIntent(`${article.title} ${article.content.slice(0, 200)}`);
  }

  private truncateContent(markdown: string): string {
    return markdown.length > this.maxContentChars
      ? `${markdown.slice(0, this.maxContentChars)}\n\n_[Content truncated at 50,000 characters]_`
      : markdown;
  }

  private async parseDocumentToArticle(document: { data: Uint8Array; contentType: string; url: string }): Promise<FetchArticle | null> {
    const filename = decodeURIComponent(new URL(document.url).pathname.split("/").pop() ?? "");
    try {
      const extracted = await extractDocument(
        { data: document.data, contentType: document.contentType, filename },
        { maxBytes: this.maxDocumentBytes },
      );
      if (!extracted.text) return null;
      const title = extracted.title || filename || document.url;
      const content = this.truncateContent(extracted.text);
      return {
        url: document.url, title, content, fullText: `# ${title}\n\n${content}`,
        ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
      };
    } catch (error) {
      console.error(`Document extraction failed for ${document.url}:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private parseHtmlToArticle(html: string, url: string): FetchArticle | null {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article?.content || article.content.length <= 200) {
      return null;
    }

    const content = this.truncateContent(this.turndown.turndown(article.content));
    const title = article.title || "Untitled Page";
    const publishedAt = normalizePublishedDate(article.publishedTime);

    return {
      url,
      title,
      content,
      fullText: `# ${title}\n\n${content}`,
      ...(publishedAt ? { publishedAt } : {}),
    };
  }

  private async fetchViaHttp(url: string): Promise<HttpFetchResult> {
    let currentUrl = url;

    try {
      for (let redirectCount = 0; redirectCount <= ContentFetcher.MAX_HTTP_REDIRECTS; redirectCount += 1) {
        if (!(await this.isFetchUrlAllowed(currentUrl))) {
          return { kind: "blocked" };
        }

        const response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });

        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) return null;

          const nextUrl = new URL(location, currentUrl).toString();
          if (!(await this.isFetchUrlAllowed(nextUrl))) {
            console.error(`Blocked private or unsupported HTTP redirect: ${nextUrl}`);
            return { kind: "blocked" };
          }

          currentUrl = nextUrl;
          continue;
        }

        const contentType = response.headers.get("content-type") ?? "";
        if (response.ok && isDocumentResponse(contentType, currentUrl)) {
          const data = await readLimitedBody(response, this.maxDocumentBytes);
          return data ? { kind: "document", data, contentType, url: currentUrl } : { kind: "document_too_large" };
        }

        if (!response.ok || !contentType.includes("text/html")) {
          return null;
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length < 500) {
          return null;
        }

        return {
          kind: "html",
          html: this.decodeHtmlBuffer(buffer),
          buffer,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private async fetchText(url: string, accept: string): Promise<TextFetchResult> {
    let currentUrl = url;

    try {
      for (let redirectCount = 0; redirectCount <= ContentFetcher.MAX_HTTP_REDIRECTS; redirectCount += 1) {
        if (!(await this.isFetchUrlAllowed(currentUrl))) {
          return { kind: "blocked" };
        }

        const response = await fetch(currentUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": accept,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });

        if (isRedirectStatus(response.status)) {
          const location = response.headers.get("location");
          if (!location) return null;

          currentUrl = new URL(location, currentUrl).toString();
          continue;
        }

        if (!response.ok) return null;

        return {
          kind: "text",
          url: currentUrl,
          text: await response.text(),
          contentType: response.headers.get("content-type") ?? "",
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  private async isFetchUrlAllowed(url: string): Promise<boolean> {
    return (await validatePublicHttpUrl(url)).ok;
  }

  private decodeHtmlBuffer(buffer: Buffer): string {
    let html = buffer.toString("utf-8");
    const head = buffer.subarray(0, 2048).toString("ascii");
    const charsetMatch = head.match(/<meta[^>]+charset=["']?\s*([a-zA-Z0-9-]+)/i);
    if (charsetMatch) {
      const detectedCharset = charsetMatch[1].toLowerCase();
      if (detectedCharset !== "utf-8" && !detectedCharset.includes("utf")) {
        html = iconv.decode(buffer, detectedCharset);
      }
    }
    return html;
  }

  private parseMarkdownToArticle(markdown: string, originalUrl: string, finalUrl: string): FetchArticle {
    const stripped = stripMarkdown(markdown);
    const title = extractMarkdownTitle(markdown) || extractTitleFromUrl(originalUrl);
    const content = this.truncateContent(stripped);

    return {
      url: finalUrl,
      title,
      content,
      fullText: `# ${title}\n\n${content}`,
    };
  }

  private parseRssToArticle(xml: string, originalUrl: string, finalUrl: string): FetchArticle | null {
    const items = extractFeedItems(xml);
    if (items.length === 0) return null;

    const title = extractFeedTitle(xml) || extractTitleFromUrl(originalUrl);
    const content = this.truncateContent(items.map((item, index) => {
      const parts = [`${index + 1}. ${item.title || item.url}`];
      if (item.url) parts.push(`   ${item.url}`);
      if (item.snippet) parts.push(`   ${item.snippet}`);
      return parts.join("\n");
    }).join("\n\n"));

    return {
      url: finalUrl,
      title,
      content,
      fullText: `# ${title}\n\n${content}`,
    };
  }
}

function isEnabledEnvFlag(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";
const README_NAMES = ["README.md", "readme.md", "Readme.md"];

function toGitHubRawCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "raw.githubusercontent.com") {
    return [parsed.toString()];
  }

  if (hostname !== "github.com" && hostname !== "www.github.com") {
    return [];
  }

  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return [];

  const owner = parts[0];
  const repo = parts[1];

  if (parts.length === 2) {
    return ["main", "master"].flatMap((branch) =>
      README_NAMES.map((name) => `${GITHUB_RAW_BASE}/${owner}/${repo}/${branch}/${name}`)
    );
  }

  if (parts[2] === "blob" && parts.length >= 5) {
    return [`${GITHUB_RAW_BASE}/${owner}/${repo}/${parts[3]}/${parts.slice(4).join("/")}`];
  }

  if (parts[2] === "tree" && parts.length >= 4) {
    const branch = parts[3];
    const path = parts.slice(4).join("/");
    const prefix = path ? `${path}/` : "";
    return README_NAMES.map((name) => `${GITHUB_RAW_BASE}/${owner}/${repo}/${branch}/${prefix}${name}`);
  }

  return [];
}

function toRssCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }

  const pathname = parsed.pathname.toLowerCase();
  const shouldProbe = pathname.endsWith(".xml") ||
    pathname.includes("/feed") ||
    pathname.includes("/rss") ||
    /\/(blog|news|articles|posts?)\/?$/.test(pathname);

  if (!shouldProbe) return [];

  const rootCandidates = ["/feed.xml", "/rss.xml", "/atom.xml", "/feed/", "/rss/", "/index.xml"].map((path) => {
    const candidate = new URL(parsed.toString());
    candidate.pathname = path;
    candidate.search = "";
    candidate.hash = "";
    return candidate.toString();
  });

  return [parsed.toString(), ...rootCandidates].filter((candidate, index, values) => values.indexOf(candidate) === index);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/<img\s+[^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, "$1")
    .replace(/<img\s+[^>]*\/?>/gi, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractMarkdownTitle(text: string): string {
  const heading = text.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();

  const titleLine = text.match(/^title:\s*(.+)$/im);
  return titleLine ? titleLine[1].trim() : "";
}

function extractTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1].replace(/[-_]/g, " ") : parsed.hostname;
  } catch {
    return "Untitled Page";
  }
}

function looksLikeFeed(text: string): boolean {
  return text.includes("<rss") || text.includes("<feed") || text.includes("<channel");
}

function stripXmlTags(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFeedTitle(xml: string): string {
  const match = xml.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
    xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripXmlTags(match[1]).slice(0, 120) : "";
}

function extractFeedItems(xml: string): Array<{ title: string; url: string; snippet: string }> {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];

  return blocks.slice(0, 25).map((block) => {
    const titleMatch = block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) ||
      block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i) ||
      block.match(/<link>([^<]+)<\/link>/i);
    const descriptionMatch = block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) ||
      block.match(/<description[^>]*>([\s\S]*?)<\/description>/i) ||
      block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);

    return {
      title: titleMatch ? stripXmlTags(titleMatch[1]).slice(0, 140) : "",
      url: linkMatch ? stripXmlTags(linkMatch[1]) : "",
      snippet: descriptionMatch ? stripXmlTags(descriptionMatch[1]).slice(0, 240) : "",
    };
  }).filter((item) => item.title || item.url);
}
