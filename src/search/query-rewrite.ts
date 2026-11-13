export type QueryContext = {
  intent?: string;
  locale?: string;
};

export type ExpandOptions = {
  maxVariants?: number;
  context?: QueryContext;
};

const ABBREVIATIONS: Record<string, string> = {
  pg: "postgres",
  psql: "postgres",
  k8s: "kubernetes",
  k8: "kubernetes",
  js: "javascript",
  ts: "typescript",
  py: "python",
  db: "database",
  ml: "machine learning",
  llm: "large language model",
  ui: "user interface",
  ux: "user experience",
  api: "api",
  ci: "continuous integration",
  cd: "continuous deployment",
  oss: "open source",
};

const SYNONYMS: Record<string, string[]> = {
  db: ["database"],
  database: ["db"],
  js: ["javascript"],
  javascript: ["js"],
  optimize: ["performance", "tuning"],
  performance: ["optimization", "benchmark"],
  error: ["exception", "bug", "issue"],
  fix: ["solve", "resolve"],
  install: ["setup", "configure"],
  compare: ["vs", "versus", "alternative"],
  best: ["top", "recommended"],
  learn: ["tutorial", "guide", "docs"],
};

const QUESTION_PREFIX =
  /^(how to|how do i|how does|what is|what are|why is|why does|where is|where can|when should|when do|can i|can you|is it possible to|tell me about)\s+/i;

export function stripSiteOperator(query: string): string {
  return query
    .replace(/(?:^|\s)site:\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize a verbose question into a tighter keyword-ish query. */
export function rewriteQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  let rewritten = trimmed.replace(QUESTION_PREFIX, "").trim();

  // Expand known abbreviations as additional tokens (keep original too).
  const tokens = rewritten.split(/\s+/);
  const expandedTokens: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const expansion = ABBREVIATIONS[lower];
    expandedTokens.push(token);
    if (expansion && !rewritten.toLowerCase().includes(expansion)) {
      expandedTokens.push(expansion);
    }
  }

  rewritten = expandedTokens.join(" ").replace(/\s+/g, " ").trim();
  return rewritten;
}

/**
 * Produce query variants for multi-query retrieval.
 * The first element is always the original query.
 */
export function expandQuery(query: string, options?: ExpandOptions): string[] {
  const original = query.trim();
  if (!original) return [];

  const maxVariants = Math.max(options?.maxVariants ?? 2, 0);
  const variants = [original];
  const seen = new Set([original.toLowerCase()]);

  const rewritten = rewriteQuery(original);
  if (rewritten && rewritten.toLowerCase() !== original.toLowerCase() && variants.length - 1 < maxVariants) {
    seen.add(rewritten.toLowerCase());
    variants.push(rewritten);
  }

  const tokens = original.split(/\s+/);
  for (const token of tokens) {
    if (variants.length - 1 >= maxVariants) break;

    const lower = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const synonyms = SYNONYMS[lower] ?? [];
    for (const synonym of synonyms) {
      if (variants.length - 1 >= maxVariants) break;
      const variant = tokens
        .map((t) => (t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === lower ? synonym : t))
        .join(" ");
      const key = variant.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        variants.push(variant);
      }
    }
  }

  // Intent-biased extra variant: news queries benefit from a year hint.
  if (options?.context?.intent === "news" && variants.length - 1 < maxVariants && !/\b20\d{2}\b/.test(original)) {
    const year = new Date().getFullYear();
    const variant = `${original} ${year}`;
    const key = variant.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      variants.push(variant);
    }
  }

  return variants;
}
