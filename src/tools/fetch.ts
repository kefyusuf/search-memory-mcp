import { z } from "zod";
import type { FetchContentResult } from "../fetch-module.js";
import type { TokenBucket } from "../rate-limiter.js";
import { validatePublicHttpUrl } from "../ssrf.js";
import { wrapUntrusted } from "../security/untrusted.js";
import { blockedUrlError, errorResult, rateLimitError, textResult, type ToolResult } from "./types.js";

const FetchSchema = z.object({
  url: z.string().url().describe("The URL of the webpage to fetch and convert to markdown"),
  force_refresh: z.boolean().optional().describe("If true, bypass cache and fetch fresh content from the web"),
});

export type UrlValidator = (url: string) => Promise<{ ok: boolean; hostname?: string }>;
export type ContentLoader = (url: string, forceRefresh: boolean) => Promise<FetchContentResult>;

export function createFetchHandler({
  fetchLimiter,
  fetchContent,
  validateUrl = validatePublicHttpUrl,
}: {
  fetchLimiter: TokenBucket;
  fetchContent: ContentLoader;
  validateUrl?: UrlValidator;
}) {
  return async (args: unknown): Promise<ToolResult> => {
    const limited = rateLimitError(fetchLimiter, "fetch_content", "RATE_LIMIT_FETCH_PER_MIN", "20");
    if (limited) return limited;

    const { url, force_refresh } = FetchSchema.parse(args);

    // SSRF Protection: Block local/private resources via DNS resolution
    const validation = await validateUrl(url);
    if (!validation.ok) return blockedUrlError(validation.hostname ?? url);

    const result = await fetchContent(url, force_refresh ?? false);
    if (result.kind === "error") {
      return errorResult(
        result.reason === "parse_failed"
          ? "Could not parse article content from the page."
          : result.reason === "blocked_url"
            ? "Access to unsupported or local/private resource is blocked for security reasons."
            : "Could not fetch page content.",
      );
    }
    return textResult(wrapUntrusted(result.text, url));
  };
}
