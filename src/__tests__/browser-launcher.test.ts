import { describe, it, expect, vi } from "vitest";
import type { Browser } from "playwright";
import { isMissingBrowserError, launchWithAutoInstall } from "../browser-launcher.js";

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

describe("isMissingBrowserError", () => {
  it("detects the Playwright missing executable message", () => {
    expect(isMissingBrowserError(missingBrowser)).toBe(true);
    expect(isMissingBrowserError(new Error("timeout"))).toBe(false);
    expect(isMissingBrowserError("Executable doesn't exist")).toBe(false);
  });
});
