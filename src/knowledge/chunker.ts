export type Chunk = {
  index: number;
  text: string;
};

const MIN_CHUNK_CHARS = 80;
const MAX_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 120;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function splitLongBlock(block: string, maxChars: number, overlapChars: number): string[] {
  if (block.length <= maxChars) return [block];

  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < block.length) {
    let end = Math.min(cursor + maxChars, block.length);
    if (end < block.length) {
      // Prefer a sentence boundary near the window end.
      const window = block.slice(cursor, end);
      const sentenceBreak = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
        window.lastIndexOf("\n"),
      );
      if (sentenceBreak > maxChars * 0.5) {
        end = cursor + sentenceBreak + 1;
      }
    }
    const piece = block.slice(cursor, end).trim();
    if (piece) pieces.push(piece);
    // Advance past the piece; apply overlap only when we actually cut early.
    const advance = Math.max(end - cursor, 1);
    cursor = end < block.length ? Math.max(end - overlapChars, cursor + Math.floor(advance / 2)) : end;
  }
  return pieces;
}

/**
 * Paragraph-first chunking with overlap for long blocks.
 * Keeps parent page context available by preserving chunk order.
 */
export function chunkText(
  content: string,
  options?: { maxChars?: number; minChars?: number; overlapChars?: number },
): Chunk[] {
  const maxChars = options?.maxChars ?? MAX_CHUNK_CHARS;
  const minChars = options?.minChars ?? MIN_CHUNK_CHARS;
  const overlapChars = options?.overlapChars ?? OVERLAP_CHARS;
  const normalized = normalizeWhitespace(content);
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const chunks: Chunk[] = [];
  let buffer = "";

  const flushBuffer = () => {
    const text = buffer.trim();
    if (text.length >= minChars) {
      chunks.push({ index: chunks.length, text });
    }
    buffer = "";
  };

  for (const block of blocks) {
    const pieces = block.length > maxChars ? splitLongBlock(block, maxChars, overlapChars) : [block];

    for (const piece of pieces) {
      if (buffer.length === 0) {
        buffer = piece;
      } else if (buffer.length + piece.length + 2 <= maxChars) {
        buffer = `${buffer}\n\n${piece}`;
      } else {
        flushBuffer();
        buffer = piece;
      }

      if (buffer.length >= maxChars) {
        flushBuffer();
      }
    }
  }

  flushBuffer();

  // Very short documents: keep a single chunk even if under minChars.
  if (chunks.length === 0 && normalized.length > 0) {
    chunks.push({ index: 0, text: normalized.slice(0, maxChars) });
  }

  return chunks;
}
