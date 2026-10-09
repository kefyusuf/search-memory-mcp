import { describe, expect, it } from "vitest";
import { checkSqliteBinding, isSupportedNodeVersion } from "../runtime/native-check.js";

describe("isSupportedNodeVersion", () => {
  it.each([
    ["v20.9.0", true], ["v22.11.0", true], ["v24.3.0", true], ["v25.1.0", true],
    ["v20.8.1", false], ["v18.20.0", false], ["v26.8.2", false],
  ])("%s -> %s", (version, supported) => {
    expect(isSupportedNodeVersion(version)).toBe(supported);
  });
});

describe("checkSqliteBinding", () => {
  it("returns null when the native SQLite module loads", () => {
    expect(checkSqliteBinding({ open: () => {}, nodeVersion: "v24.3.0" })).toBeNull();
  });

  it("explains a missing binding (install scripts not run) with fixes and the Docker option", () => {
    const help = checkSqliteBinding({
      open: () => { throw new Error("Could not locate the bindings file. Tried: ..."); },
      nodeVersion: "v24.3.0",
    });
    expect(help).toContain("better-sqlite3");
    expect(help).toContain("Could not locate the bindings file");
    expect(help).toContain("npm install-scripts approve better-sqlite3");
    expect(help).toContain("npm rebuild better-sqlite3");
    expect(help).toContain("docker run -i --rm");
    expect(help).not.toContain("not supported");
  });

  it("names an unsupported Node version and recommends Node 24", () => {
    const help = checkSqliteBinding({
      open: () => { throw new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 127"); },
      nodeVersion: "v26.8.2",
    });
    expect(help).toContain("Node v26.8.2 is not supported");
    expect(help).toContain("Node 24");
  });
});
