import type { SearchResultItem } from "./cache/types.js";

export type AnswerSource = {
  title: string;
  url: string;
  content: string;
};

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "when", "at", "by",
  "for", "with", "about", "against", "between", "into", "through", "during",
  "before", "after", "above", "below", "to", "from", "up", "down", "in", "out",
  "on", "off", "over", "under", "again", "further", "once", "here", "there",
  "all", "any", "both", "each", "few", "more", "most", "other", "some", "such",
  "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can",
  "will", "just", "do", "does", "did", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "having", "of", "as", "it", "its", "this",
  "that", "these", "those", "i", "me", "my", "we", "our", "you", "your", "he",
  "she", "they", "them", "his", "her", "their", "what", "which", "who", "whom",
  "how", "why", "where", "please", "tell", "give", "show", "find",
]);

function meaningfulTerms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\n{2,}|\n---\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 40);
}

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
}

function scoreText(text: string, questionTerms: Set<string>): number {
  if (questionTerms.size === 0) return 0;
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  let hits = 0;
  for (const word of words) {
    if (questionTerms.has(word)) hits += 1;
  }
  // Normalize by length so short paragraphs with dense term hits win.
  return hits / Math.sqrt(Math.max(words.length, 1));
}

type ScoredPassage = {
  text: string;
  score: number;
  sourceIndex: number;
};

function collectPassages(sources: AnswerSource[], questionTerms: Set<string>): ScoredPassage[] {
  const passages: ScoredPassage[] = [];

  sources.forEach((source, sourceIndex) => {
    for (const paragraph of splitParagraphs(source.content)) {
      const paragraphScore = scoreText(paragraph, questionTerms);
      const sentences = splitSentences(paragraph);

      if (sentences.length === 0) {
        passages.push({ text: paragraph, score: paragraphScore, sourceIndex });
        continue;
      }

      for (const sentence of sentences) {
        const sentenceScore = scoreText(sentence, questionTerms) * 1.2 + paragraphScore * 0.3;
        passages.push({ text: sentence, score: sentenceScore, sourceIndex });
      }
    }
  });

  return passages.sort((a, b) => b.score - a.score);
}

function extractVersionAnswer(question: string, sources: AnswerSource[]): string | null {
  const questionTerms = meaningfulTerms(question);
  const versionRegex = /(\w+)\s+(\d+)\.(\d+)(?:\.(\d+))?/g;

  type VersionHit = { name: string; major: number; minor: number; patch: number; context: string; sourceIndex: number };
  const versions: VersionHit[] = [];

  sources.forEach((source, sourceIndex) => {
    let match: RegExpExecArray | null;
    versionRegex.lastIndex = 0;
    while ((match = versionRegex.exec(source.content)) !== null) {
      const name = match[1];
      const major = parseInt(match[2], 10);
      const minor = parseInt(match[3], 10);
      const patch = match[4] ? parseInt(match[4], 10) : 0;
      const start = Math.max(0, match.index - 60);
      const end = Math.min(source.content.length, match.index + match[0].length + 100);
      const context = source.content.slice(start, end).replace(/\s+/g, " ").trim();
      versions.push({ name, major, minor, patch, context, sourceIndex });
    }
  });

  if (versions.length === 0) return null;

  const relevant = versions.filter((version) => {
    const nameLower = version.name.toLowerCase();
    if (questionTerms.has(nameLower)) return true;
    for (const term of questionTerms) {
      if (nameLower.includes(term) || term.includes(nameLower)) return true;
    }
    return false;
  });

  const candidates = relevant.length > 0 ? relevant : versions;
  const best = candidates.reduce((a, b) =>
    a.major !== b.major ? (a.major > b.major ? a : b) :
    a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
    a.patch > b.patch ? a : b
  );

  const versionLabel = `${best.name} ${best.major}.${best.minor}${best.patch > 0 ? `.${best.patch}` : ""}`;
  const citation = `[Source ${best.sourceIndex + 1}]`;
  return `The latest ${best.name} version found in the fetched pages is **${versionLabel}**.\n\nContext: ${best.context} ${citation}`;
}

export function extractAnswerFromDocuments(question: string, sources: AnswerSource[]): string {
  if (sources.length === 0) {
    return "Answer: Could not extract a specific answer from the content.\n\nSources: (none)";
  }

  const questionTerms = meaningfulTerms(question);
  const versionAnswer = extractVersionAnswer(question, sources);
  if (versionAnswer) {
    return formatAnswerBlock(versionAnswer, sources);
  }

  const passages = collectPassages(sources, questionTerms);
  const top = passages.filter((passage) => passage.score > 0).slice(0, 3);

  if (top.length === 0) {
    const first = splitParagraphs(sources[0].content)[0] ?? sources[0].content.slice(0, 300);
    return formatAnswerBlock(first.trim(), sources);
  }

  // Keep at most one sentence per source unless a second sentence is much stronger.
  const selected: ScoredPassage[] = [];
  const usedSources = new Set<number>();
  for (const passage of top) {
    if (usedSources.has(passage.sourceIndex) && selected.length >= 2) continue;
    selected.push(passage);
    usedSources.add(passage.sourceIndex);
    if (selected.length >= 3) break;
  }

  const answerBody = selected
    .map((passage) => `${passage.text.replace(/\s+$/, "")} [Source ${passage.sourceIndex + 1}]`)
    .join(" ");

  return formatAnswerBlock(answerBody, sources);
}

function formatAnswerBlock(answerBody: string, sources: AnswerSource[]): string {
  const sourceLines = sources
    .map((source, index) => `Source ${index + 1}: ${source.url}${source.title ? ` (${source.title})` : ""}`)
    .join("\n");

  return `Answer: ${answerBody}\n\nSources:\n${sourceLines}`;
}

/**
 * Back-compat wrapper: concatenates content but keeps per-source boundaries
 * so citations stay aligned with sourceUrls.
 */
export function extractAnswerFromContent(question: string, combinedContent: string, sourceUrls: string[]): string {
  const chunks = combinedContent.split(/\n\n---\n\n/);
  const sources: AnswerSource[] = sourceUrls.map((url, index) => ({
    title: "",
    url,
    content: chunks[index] ?? combinedContent,
  }));

  if (sources.length === 0 && combinedContent.trim()) {
    sources.push({ title: "", url: "(unknown)", content: combinedContent });
  }

  return extractAnswerFromDocuments(question, sources);
}

export function formatSearchResults(query: string, results: SearchResultItem[]): string {
  void query;

  const foundVersions: { label: string; major: number; minor: number; patch: number }[] = [];

  for (const result of results) {
    const text = `${result.title} ${result.snippet}`;
    let match: RegExpExecArray | null;
    const versionPattern = /(?:^|\s)(\d+)\.(\d+)(?:\.(\d+))?/g;
    while ((match = versionPattern.exec(text)) !== null) {
      const before = text.slice(Math.max(0, match.index - 20), match.index);
      const labelMatch = before.match(/(\w+)\s*$/);
      const label = labelMatch ? labelMatch[1] : "";
      foundVersions.push({
        label,
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: match[3] ? parseInt(match[3], 10) : 0,
      });
    }
  }

  let summary = "";
  if (foundVersions.length > 0) {
    const best = foundVersions.reduce((a, b) =>
      a.major !== b.major ? (a.major > b.major ? a : b) :
      a.minor !== b.minor ? (a.minor > b.minor ? a : b) :
      a.patch > b.patch ? a : b
    );
    const labelText = best.label ? `${best.label} ${best.major}.${best.minor}` : `v${best.major}.${best.minor}`;
    summary = `Version hint from search snippets: ${labelText}.\n\n`;
  }

  const formatted = results.map((result, i) => {
    const freshnessHint = formatFreshnessHint(`${result.title} ${result.snippet}`, result.publishedAt);
    return `${i + 1}. "${result.title}" - ${result.url}\n   ${result.snippet || "(no description)"}${freshnessHint ? `\n   ${freshnessHint}` : ""}`;
  }).join("\n\n");

  return summary + formatted;
}

function formatFreshnessHint(text: string, publishedAt?: string): string {
  // A provider-reported date is authoritative over dates found in snippet text.
  const dateHint = publishedAt ?? extractDateHint(text);
  if (!dateHint) return "";

  const parsedDate = new Date(dateHint);
  if (Number.isNaN(parsedDate.getTime())) return "";

  const ageMonths = monthDelta(parsedDate, new Date());
  if (ageMonths <= 24) return "";

  return `Freshness: possibly stale (${dateHint}).`;
}

function extractDateHint(text: string): string | null {
  const absolutePatterns = [
    /\b(\d{4}-\d{2}-\d{2})\b/,
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/i,
  ];

  for (const pattern of absolutePatterns) {
    const match = text.match(pattern);
    if (match) return normalizeDateHint(match[1]);
  }

  const relativeMatch = text.match(/\b(\d+)\s+(month|year)s?\s+ago\b/i);
  if (!relativeMatch) return null;

  const amount = Number(relativeMatch[1]);
  const unit = relativeMatch[2].toLowerCase();
  const date = new Date();
  if (unit.startsWith("month")) {
    date.setMonth(date.getMonth() - amount);
  } else {
    date.setFullYear(date.getFullYear() - amount);
  }

  return date.toISOString().slice(0, 10);
}

function normalizeDateHint(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}

function monthDelta(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
}
