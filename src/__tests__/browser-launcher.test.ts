import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Browser } from "playwright";
import { installChromium, isMissingBrowserError, launchWithAutoInstall } from "../browser-launcher.js";

const fakeBrowser = {} as Browser;
const missingBrowser = new Error(
  "browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium-1248\\chrome.exe",
);

describe("launchWithAutoInstall", () => {
  it("returns the browser without installing when launch succeeds", async () => {
    const install = vi.fn(async () => {});
    const browser = await launchWithAutoInstall(async () => fakeBrowser, install);
    expect(browser).toBe(fakeBrowser);
    expect(install).not.toHaveBeenCalled();
  });

  it("installs Chromium once and retries when the executable is missing", async () => {
    const launch = vi.fn<() => Promise<Browser>>()
      .mockRejectedValueOnce(missingBrowser)
      .mockResolvedValueOnce(fakeBrowser);
    const install = vi.fn(async () => {});
    const browser = await launchWithAutoInstall(launch, install);
    expect(browser).toBe(fakeBrowser);
    expect(install).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("rethrows unrelated launch errors without installing", async () => {
    const install = vi.fn(async () => {});
    await expect(
      launchWithAutoInstall(async () => { throw new Error("spawn EACCES"); }, install),
    ).rejects.toThrow("spawn EACCES");
    expect(install).not.toHaveBeenCalled();
  });

  it("propagates install failures", async () => {
    await expect(
      launchWithAutoInstall(async () => { throw missingBrowser; }, async () => { throw new Error("offline"); }),
    ).rejects.toThrow("offline");
  });
});

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("installChromium", () => {
  const node = process.execPath;

  it("resolves when the installer exits with code 0", async () => {
    await expect(installChromium({ command: { file: node, args: ["-e", "process.exit(0)"] } })).resolves.toBeUndefined();
  });

  it("rejects with a manual-install hint when the installer fails", async () => {
    await expect(installChromium({ command: { file: node, args: ["-e", "process.exit(3)"] } }))
      .rejects.toThrow(/exited with code 3.*npx playwright install chromium/);
  });

  it("stops a stalled installer and its child process after the timeout", async () => {
    // The fake installer starts a long-lived worker (like Playwright's download worker),
    // writes the worker pid to a file, and then hangs.
    const pidFile = join(mkdtempSync(join(tmpdir(), "smm-install-")), "worker.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const started = Date.now();
    await expect(installChromium({ timeoutMs: 1500, command: { file: node, args: ["-e", script] } }))
      .rejects.toThrow(/did not finish within 2 seconds.*npx playwright install chromium/);
    expect(Date.now() - started).toBeLessThan(5000);

    const workerPid = Number(readFileSync(pidFile, "utf8"));
    expect(workerPid).toBeGreaterThan(0);
    // taskkill / SIGKILL are asynchronous; give the OS a moment.
    for (let i = 0; i < 30 && isAlive(workerPid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(workerPid)).toBe(false);
    rmSync(dirname(pidFile), { recursive: true, force: true });
  }, 15000);
});

describe("isMissingBrowserError", () => {
  it("detects the Playwright missing executable message", () => {
    expect(isMissingBrowserError(missingBrowser)).toBe(true);
    expect(isMissingBrowserError(new Error("timeout"))).toBe(false);
    expect(isMissingBrowserError("Executable doesn't exist")).toBe(false);
  });
});
