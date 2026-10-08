import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";

const MISSING_BROWSER_PATTERN = /Executable doesn't exist|playwright install/i;

export function isMissingBrowserError(error: unknown): boolean {
  return error instanceof Error && MISSING_BROWSER_PATTERN.test(error.message);
}

/**
 * Installs Playwright Chromium with the CLI of the installed playwright package.
 * Output goes to stderr only, because stdout carries the MCP stdio protocol.
 */
export function installChromium(): Promise<void> {
  // "playwright/cli" is not in the package exports; resolve cli.js next to package.json.
  const packageJsonPath = createRequire(import.meta.url).resolve("playwright/package.json");
  const cliPath = join(dirname(packageJsonPath), "cli.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", process.stderr, process.stderr],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`playwright install chromium exited with code ${code}`));
    });
  });
}

/**
 * Launches Chromium. When the browser binary is missing (for example because the
 * package manager skipped the postinstall script), installs it once and retries.
 */
export async function launchWithAutoInstall(
  launch: () => Promise<Browser>,
  install: () => Promise<void> = installChromium,
): Promise<Browser> {
  try {
    return await launch();
  } catch (error) {
    if (!isMissingBrowserError(error)) throw error;
    console.error("Chromium is not installed. Downloading it now (one time only)...");
    await install();
    return launch();
  }
}
