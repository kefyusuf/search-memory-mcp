import type { SearchResultItem } from "../cache/types.js";

export type DateRange = {
  /** Inclusive lower bound, YYYY-MM-DD */
  from?: string;
  /** Inclusive upper bound, YYYY-MM-DD */
  to?: string;
};

export type DateFilterOptions = {
  /** Keep results with no detected date (default true). */
  keepUndated?: boolean;
};

const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/;

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseMonthNameDate(text: string): string | null {
  // "Mar 15, 2024" | "March 15 2024"
  const monthFirst = text.match(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/
  );
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1].toLowerCase()];
    if (month) return formatDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  // "15 March 2024" | "15 Mar 2024"
  const dayFirst = text.match(
    /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/
  );
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2].toLowerCase()];
    if (month) return formatDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  return null;
}

function parseRelativeDate(text: string): string | null {
  const match = text.match(/\b(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago\b/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const date = new Date();

  if (unit.startsWith("day")) date.setDate(date.getDate() - amount);
  else if (unit.startsWith("week")) date.setDate(date.getDate() - amount * 7);
  else if (unit.startsWith("month")) date.setMonth(date.getMonth() - amount);
  else date.setFullYear(date.getFullYear() - amount);

  return date.toISOString().slice(0, 10);
}

/** Best-effort publish-date extraction from free text (snippet + title). */
export function extractPublishDate(text: string): string | null {
  if (!text) return null;

  const iso = text.match(ISO_DATE);
  if (iso) return iso[1];

  const monthName = parseMonthNameDate(text);
  if (monthName) return monthName;

  return parseRelativeDate(text);
}

export function isWithinDateRange(
  date: string | null,
  range: DateRange | undefined,
  options?: DateFilterOptions,
): boolean {
  if (!range || (!range.from && !range.to)) return true;

  const keepUndated = options?.keepUndated ?? true;
  if (!date) return keepUndated;

  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

export function filterResultsByDate(
  results: SearchResultItem[],
  range: DateRange | undefined,
  options?: DateFilterOptions,
): SearchResultItem[] {
  if (!range || (!range.from && !range.to)) return results;

  return results.filter((item) => {
    // A provider-reported date is authoritative; snippet extraction is only a fallback.
    const date = item.publishedAt && ISO_DATE.test(item.publishedAt)
      ? item.publishedAt
      : extractPublishDate(`${item.title} ${item.snippet}`);
    return isWithinDateRange(date, range, options);
  });
}
