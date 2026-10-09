import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { extractDocument, type ExtractedDocument } from "./extract.js";

export type LocalFileErrorCode = "disabled" | "outside" | "hidden" | "not_found" | "not_a_file" | "too_large";

export class LocalFileError extends Error {
  constructor(readonly code: LocalFileErrorCode, message: string) {
    super(message);
    this.name = "LocalFileError";
  }
}

export type LocalDocument = ExtractedDocument & { path: string };

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

/** Parses INGEST_ALLOWED_DIRS: comma-separated directories, `~` meaning the home directory. */
export function parseAllowedDirs(raw: string | undefined, home: string = homedir()): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry === "~" ? home : entry.startsWith("~/") ? join(home, entry.slice(2)) : entry))
    .map((entry) => resolve(entry));
}

function within(dir: string, target: string): string | null {
  const rel = relative(dir, target);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : null;
}

/**
 * Reads a local file only when its real path (after symlinks) is inside an
 * allowed directory and no path segment below that directory is hidden.
 * Reading is disabled when no directory is allowed.
 */
export async function readLocalDocument(
  path: string,
  { allowedDirs, maxBytes = DEFAULT_MAX_BYTES }: { allowedDirs: string[]; maxBytes?: number },
): Promise<LocalDocument> {
  if (allowedDirs.length === 0) {
    throw new LocalFileError("disabled", "Reading local files is disabled. Set INGEST_ALLOWED_DIRS to the directories that may be indexed.");
  }

  const realDirs = (await Promise.all(allowedDirs.map((dir) => realpath(dir).catch(() => null))))
    .filter((dir): dir is string => dir !== null);
  const requested = resolve(path);

  let real: string;
  try {
    real = await realpath(requested);
  } catch {
    const lexicallyInside = allowedDirs.some((dir) => within(resolve(dir), requested) !== null);
    throw lexicallyInside
      ? new LocalFileError("not_found", `File not found: ${path}`)
      : new LocalFileError("outside", `${path} is outside INGEST_ALLOWED_DIRS.`);
  }

  const rel = realDirs.map((dir) => within(dir, real)).find((value) => value !== null);
  if (!rel) {
    throw new LocalFileError("outside", `${path} is outside INGEST_ALLOWED_DIRS.`);
  }
  if (rel.split(sep).some((segment) => segment.startsWith("."))) {
    throw new LocalFileError("hidden", `${path} is a hidden file or inside a hidden folder; these are never read.`);
  }

  const info = await stat(real);
  if (!info.isFile()) {
    throw new LocalFileError("not_a_file", `${path} is not a regular file.`);
  }
  if (info.size > maxBytes) {
    throw new LocalFileError("too_large", `${path} is larger than ${maxBytes} bytes.`);
  }

  const data = new Uint8Array(await readFile(real));
  const document = await extractDocument({ data, filename: basename(real) }, { maxBytes });
  return { ...document, path: real };
}
