import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCacheDbPath } from "../runtime/db-path.js";

const temp = () => mkdtempSync(join(tmpdir(), "db-path-"));

describe("resolveCacheDbPath", () => {
  it("uses CACHE_DB_PATH when it is set", () => {
    expect(resolveCacheDbPath({ envPath: "/data/x.db", cwd: temp(), home: temp() })).toBe("/data/x.db");
  });

  it("keeps an existing database in the working directory", () => {
    const cwd = temp();
    writeFileSync(join(cwd, "websearch_cache.db"), "");
    expect(resolveCacheDbPath({ cwd, home: temp() })).toBe(join(cwd, "websearch_cache.db"));
  });

  it("defaults to a per-user data directory, not the working directory", () => {
    const home = temp();
    const path = resolveCacheDbPath({ cwd: temp(), home });
    expect(path).toBe(join(home, ".search-memory-mcp", "websearch_cache.db"));
    expect(existsSync(join(home, ".search-memory-mcp"))).toBe(true);
  });
});
