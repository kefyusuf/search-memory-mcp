import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";

const MISSING_BROWSER_PATTERN = /Executable doesn't exist|playwright install/i;

export function isMissingBrowserError(error: unknown): boolean {
  return error instanceof Error && MISSING_BROWSER_PATTERN.test(error.message);
}

const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export const MANUAL_INSTALL_HINT = "Run `npx playwright install chromium` manually, then retry.";

export interface InstallOptions {
  /** Stops the installer after this time. Defaults to CHROMIUM_INSTALL_TIMEOUT_MS or 10 minutes. */
  timeoutMs?: number;
  /** Command and arguments to run. Defaults to the bundled Playwright CLI. Override in tests. */
  command?: { file: string; args: string[] };
}

function playwrightInstallCommand(): { file: string; args: string[] } {
  // "playwright/cli" is not in the package exports; resolve cli.js next to package.json.
  const packageJsonPath = createRequire(import.meta.url).resolve("playwright/package.json");
  return { file: process.execPath, args: [join(dirname(packageJsonPath), "cli.js"), "install", "chromium"] };
}

function resolveTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs !== undefined) return timeoutMs;
  const fromEnv = Number(process.env.CHROMIUM_INSTALL_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_INSTALL_TIMEOUT_MS;
}

/** Stops the installer and the download worker it starts. */
function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/**
 * Installs Playwright Chromium with the CLI of the installed playwright package.
 * Output goes to stderr only, because stdout carries the MCP stdio protocol.
 * A stalled download is stopped after the timeout, so callers never wait forever.
 */
export function installChromium(options: InstallOptions = {}): Promise<void> {
  const { file, args } = options.command ?? playwrightInstallCommand();
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["ignore", process.stderr, process.stderr],
      // A process group lets the timeout stop the download worker too (POSIX).
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error(`Chromium download did not finish within ${Math.round(timeoutMs / 1000)} seconds. ${MANUAL_INSTALL_HINT}`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start the Chromium installer: ${error.message}. ${MANUAL_INSTALL_HINT}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Chromium installer exited with code ${code}. ${MANUAL_INSTALL_HINT}`));
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
