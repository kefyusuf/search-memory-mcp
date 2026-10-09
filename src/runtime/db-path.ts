import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DB_FILE = "websearch_cache.db";

/**
 * Where the SQLite database lives. MCP clients often start the server in a directory
 * it cannot write to (Claude Desktop on Windows uses C:\Windows\System32), so the
 * default is a per-user directory. A database already in the working directory, where
 * earlier versions created it, keeps being used.
 */
export function resolveCacheDbPath(options: { envPath?: string; cwd?: string; home?: string } = {}): string {
  const envPath = options.envPath?.trim();
  if (envPath) return envPath;

  const legacy = join(options.cwd ?? process.cwd(), DB_FILE);
  if (existsSync(legacy)) return legacy;

  const dir = join(options.home ?? homedir(), ".search-memory-mcp");
  mkdirSync(dir, { recursive: true });
  return join(dir, DB_FILE);
}
