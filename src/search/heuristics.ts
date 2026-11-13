import type { SearchIntent } from "./intent.js";

type HeuristicRule = {
  intent: Exclude<SearchIntent, "general">;
  patterns: RegExp[];
};

const RULES: HeuristicRule[] = [
  {
    intent: "technical",
    patterns: [
      /\b(typeerror|referenceerror|sqlstate|stack trace|http 5\d\d|eresolve)\b/i,
      /\b(api|sdk|docs?|documentation|configuration|runtime|database|query|migration|queue|docker|kubernetes)\b.*\b(error|implement|configure|retry|debug|optimi[sz]e|best practices?)\b/i,
      /\b(npm|composer|laravel|symfony|react|vue|next\.?js|nestjs|postgres(?:ql)?|mysql|redis|kafka)\b.*\b(error|config|configuration|implementation|retry|migration|query|worker)\b/i,
    ],
  },
  {
    intent: "news",
    patterns: [
      /\b(latest|today|breaking|news|announcement|announced)\b/i,
      /\b(bugün|son dakika|haber(?:ler)?|duyuru)\b/i,
    ],
  },
  {
    intent: "shopping",
    patterns: [
      /\b(buy|price|deal|discount|purchase|cheapest|in stock)\b/i,
      /\b(satın al|fiyat|indirim|kampanya|stokta)\b/i,
    ],
  },
  {
    intent: "local",
    patterns: [/\b(near me|nearby|closest|in my area)\b/i, /\b(yakınımda|yakınımdaki|yakındaki|en yakın)\b/i],
  },
  {
    intent: "navigational",
    patterns: [
      /https?:\/\//i,
      /\b[a-z0-9-]+\.(?:com|org|net|dev|io|ai)(?:\/|\b)/i,
      /\b(official site|official website|official docs|documentation page)\b/i,
      /\b(resmi site|resmi web sitesi|dokümantasyon sayfası)\b/i,
    ],
  },
  {
    intent: "commercial",
    patterns: [
      /\b(vendor|vendors|competitor|competitors|enterprise product|company discovery|supplier)\b/i,
      /\b(tedarikçi|rakip(?:ler)?|kurumsal ürün|şirket araştırması)\b/i,
    ],
  },
  {
    intent: "research",
    patterns: [
      /\b(landscape|market share|adoption|survey|evidence|benchmark|industry analysis)\b/i,
      /(?:pazar payı|benimsenme|araştırma|anket|kanıt|sektör analizi)/i,
    ],
  },
];

export function detectHeuristicIntent(query: string): SearchIntent | null {
  const matches = RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(query))).map(
    (rule) => rule.intent,
  );
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : null;
}
