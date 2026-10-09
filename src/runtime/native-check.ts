import Database from "better-sqlite3";

const MIN_MAJOR = 20;
const MAX_MAJOR = 25;
const DOCKER_IMAGE = "search-memory-mcp";

/** Node versions that have better-sqlite3 prebuilt binaries: 20.9 through 25. */
export function isSupportedNodeVersion(version: string): boolean {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major === MIN_MAJOR) return minor >= 9;
  return major > MIN_MAJOR && major <= MAX_MAJOR;
}

/**
 * Opens an in-memory SQLite database to prove the native binding loads.
 * Returns null when it works, otherwise a message with the fixes.
 */
export function checkSqliteBinding({
  open = () => new Database(":memory:").close(),
  nodeVersion = process.version,
}: { open?: () => void; nodeVersion?: string } = {}): string | null {
  try {
    open();
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    const lines = [
      "Search Memory MCP could not load its SQLite module (better-sqlite3).",
      `Reason: ${reason}`,
      "",
    ];
    if (!isSupportedNodeVersion(nodeVersion)) {
      lines.push(`Node ${nodeVersion} is not supported. Use Node 24 (supported: 20.9 to 25), then reinstall.`, "");
    }
    lines.push(
      "Fix it in the project folder:",
      "  1. Use Node 24 (for example: nvm install 24 && nvm use 24).",
      "  2. If npm skipped install scripts, allow them: npm install-scripts approve better-sqlite3",
      "  3. Rebuild the native module: npm rebuild better-sqlite3",
      "",
      "Or run it in Docker with nothing to install on the host:",
      `  docker build -t ${DOCKER_IMAGE} . && docker run -i --rm -v search-memory-data:/app/data ${DOCKER_IMAGE}`,
    );
    return lines.join("\n");
  }
}
