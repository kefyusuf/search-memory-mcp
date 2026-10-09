import type { TokenBucket } from "../rate-limiter.js";

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Success result; tools with an outputSchema must pass their structured payload. */
export function textResult(text: string, structuredContent?: object): ToolResult {
  return structuredContent
    ? { content: [{ type: "text", text }], structuredContent: structuredContent as Record<string, unknown> }
    : { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Returns an error result when the bucket is empty, otherwise null. */
export function rateLimitError(limiter: TokenBucket, toolName: string, envKey: string, defaultLimit: string): ToolResult | null {
  const { allowed, retryAfterMs } = limiter.tryConsume();
  if (allowed) return null;
  const seconds = Math.ceil(retryAfterMs / 1000);
  return errorResult(`Rate limit exceeded: ${toolName} allows ${process.env[envKey] || defaultLimit} requests per minute. Retry in ${seconds} seconds.`);
}

export function blockedUrlError(hostname: string): ToolResult {
  return errorResult(`Access to unsupported or local/private resource is blocked for security reasons: ${hostname}`);
}
