/**
 * Normalizes a publication date from HTML metadata, JSON-LD or a PDF info
 * dictionary (D:YYYYMMDDHHmmSS...) to YYYY-MM-DD. Unparseable input gives undefined.
 */
export function normalizePublishedDate(raw: string | null | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  const pdfDate = /^D:(\d{4})(\d{2})?(\d{2})?/.exec(value);
  if (pdfDate) {
    const [, year, month = "01", day = "01"] = pdfDate;
    return valid(`${year}-${month}-${day}`);
  }
  if (!/\d{4}/.test(value)) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function valid(date: string): string | undefined {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? undefined : date;
}
