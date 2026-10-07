#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const smokeDir = mkdtempSync(join(tmpdir(), "local-websearch-mcp-smoke-"));
const cacheDbPath = join(smokeDir, "websearch_cache.db");
const child = spawn(process.execPath, ["build/index.js"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    CACHE_DB_PATH: process.env.CACHE_DB_PATH ?? cacheDbPath,
    SEARCH_PROVIDERS: process.env.SEARCH_PROVIDERS ?? "duckduckgo",
    ENABLE_CROSSLINGUAL: process.env.ENABLE_CROSSLINGUAL ?? "false",
  },
});

let nextId = 1;
let stdout = "";
let stderr = "";
const pending = new Map();

const timeout = setTimeout(() => {
  child.kill();
  fail(`MCP smoke timed out.\n${stderr}`);
}, 15_000);

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
  let newlineIndex = stdout.indexOf("\n");

  while (newlineIndex !== -1) {
    const line = stdout.slice(0, newlineIndex).trim();
    stdout = stdout.slice(newlineIndex + 1);
    newlineIndex = stdout.indexOf("\n");

    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(`Invalid JSON-RPC line: ${line}\n${error instanceof Error ? error.message : String(error)}`);
    }

    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("exit", (code) => {
  if (code !== null && code !== 0 && pending.size > 0) {
    fail(`MCP server exited with code ${code}.\n${stderr}`);
  }
});

try {
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: {
      name: "local-websearch-mcp-smoke",
      version: "1.0.0",
    },
  });
  assertNoError(init, "initialize");

  notify("notifications/initialized", {});

  const tools = await request("tools/list", {});
  assertNoError(tools, "tools/list");
  const toolNames = tools.result.tools.map((tool) => tool.name).sort();
  assertIncludes(toolNames, "web_search", "tools/list");
  assertIncludes(toolNames, "fetch_content", "tools/list");
  assertIncludes(toolNames, "server_status", "tools/list");

  const webSearchTool = tools.result.tools.find((tool) => tool.name === "web_search");
  if (webSearchTool?.inputSchema?.properties?.expand_query?.type !== "boolean") {
    fail("web_search did not expose the expand_query boolean option.");
  }
  const strategyEnum = webSearchTool?.inputSchema?.properties?.strategy?.enum ?? [];
  for (const strategy of ["fallback", "aggregate", "auto"]) {
    assertIncludes(strategyEnum, strategy, "web_search strategy enum");
  }

  const status = await request("tools/call", {
    name: "server_status",
    arguments: {},
  });
  assertNoError(status, "server_status");
  const statusText = status.result.content?.[0]?.text ?? "";
  const parsedStatus = JSON.parse(statusText);
  assertHasStatusShape(parsedStatus);

  const noteText = "Dispatcher smoke note";
  const noteSession = `smoke-${process.pid}`;
  const remembered = await request("tools/call", {
    name: "remember", arguments: { text: noteText, session: noteSession },
  });
  assertNoError(remembered, "remember");
  if (remembered.result?.isError) fail("remember failed through the stdio dispatcher.");
  const recalled = await request("tools/call", {
    name: "recall", arguments: { session: noteSession },
  });
  assertNoError(recalled, "recall");
  if (recalled.result?.isError || !recalled.result?.content?.[0]?.text?.includes(noteText)) {
    fail("recall did not return the note saved through the stdio dispatcher.");
  }

  const rememberedId = remembered.result.content?.[0]?.text?.match(/id=([^,]+)/)?.[1];
  if (!rememberedId) throw new Error("remember did not return a usable note id.");
  const forgotten = await request("tools/call", {
    name: "forget", arguments: { id: rememberedId },
  });
  assertNoError(forgotten, "forget remembered id");
  if (forgotten.result?.isError) throw new Error("forget could not delete the note using the id returned by remember.");
  const afterForget = await request("tools/call", {
    name: "recall", arguments: { session: noteSession },
  });
  assertNoError(afterForget, "recall after forget");
  if (afterForget.result?.isError || !afterForget.result?.content?.[0]?.text?.includes("No memory notes matched.")) {
    throw new Error("recall still returned the note deleted using the remember id.");
  }

  const recallNote = await request("tools/call", {
    name: "remember", arguments: { text: "Recall deletion smoke note", session: noteSession },
  });
  assertNoError(recallNote, "remember recall deletion note");
  if (recallNote.result?.isError) throw new Error("remember failed to create the recall deletion note.");
  const recallForDeletion = await request("tools/call", {
    name: "recall", arguments: { session: noteSession },
  });
  assertNoError(recallForDeletion, "recall deletion id");
  const recalledId = recallForDeletion.result?.content?.[0]?.text?.match(/1\. \[([^\]]+)\]/)?.[1];
  if (!recalledId) throw new Error("recall did not return a usable note id.");
  const forgottenRecall = await request("tools/call", {
    name: "forget", arguments: { id: recalledId },
  });
  assertNoError(forgottenRecall, "forget recalled id");
  if (forgottenRecall.result?.isError) throw new Error("forget could not delete the note using the id returned by recall.");
  const afterRecallForget = await request("tools/call", {
    name: "recall", arguments: { session: noteSession },
  });
  assertNoError(afterRecallForget, "recall after recalled id deletion");
  if (afterRecallForget.result?.isError || !afterRecallForget.result?.content?.[0]?.text?.includes("No memory notes matched.")) {
    throw new Error("recall still returned the note deleted using the recall id.");
  }

  const invalidSearch = await request("tools/call", {
    name: "web_search",
    arguments: {
      query: "",
    },
  });
  if (invalidSearch.result?.isError !== true) {
    fail("web_search did not reject an empty query during smoke test.");
  }
  const invalidSearchText = invalidSearch.result.content?.[0]?.text ?? "";
  if (!invalidSearchText.includes("Invalid arguments:")) {
    fail(`web_search returned an unexpected validation error: ${invalidSearchText}`);
  }

  const blockedFetch = await request("tools/call", {
    name: "fetch_content",
    arguments: {
      url: "http://127.0.0.1/",
    },
  });
  if (blockedFetch.result?.isError !== true) {
    fail("fetch_content did not block localhost during smoke test.");
  }
  const blockedFetchText = blockedFetch.result.content?.[0]?.text ?? "";
  if (!blockedFetchText.includes("blocked for security reasons")) {
    fail(`fetch_content returned an unexpected localhost block message: ${blockedFetchText}`);
  }

  clearTimeout(timeout);
  await stopServer();
  rmSync(smokeDir, { recursive: true, force: true });
  console.log(`MCP smoke passed: ${toolNames.join(", ")}`);
} catch (error) {
  await stopServer();
  fail(error instanceof Error ? error.message : String(error));
}

function request(method, params) {
  const id = nextId++;
  const message = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  child.stdin.write(`${JSON.stringify(message)}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function assertNoError(response, label) {
  if (response.error) {
    fail(`${label} failed: ${JSON.stringify(response.error)}`);
  }
}

function assertIncludes(values, expected, label) {
  if (!values.includes(expected)) {
    fail(`${label} missing ${expected}; got ${values.join(", ")}`);
  }
}

function assertHasStatusShape(status) {
  if (!Array.isArray(status.providers) || status.providers.length === 0) {
    fail("server_status did not include providers.");
  }

  const provider = status.providers[0];
  for (const field of ["name", "available", "recentAttempts", "recentSuccesses", "recentFailures", "backoffRemainingMs"]) {
    if (!(field in provider)) {
      fail(`server_status provider missing ${field}.`);
    }
  }

  if (!status.cache || typeof status.cache.contentCount !== "number" || typeof status.cache.vectorCount !== "number") {
    fail("server_status did not include cache counts.");
  }

  if (!status.config || !Array.isArray(status.config.searchProviders) || typeof status.config.fetchWaitUntil !== "string") {
    fail("server_status did not include runtime config.");
  }

  if (status.config.searchStrategyDefault !== "fallback") {
    fail(`server_status default search strategy changed: ${status.config.searchStrategyDefault}`);
  }
  if (status.config.autoRouting !== "available") {
    fail("server_status did not report auto routing availability.");
  }
  if (status.config.routingProfileVersion !== "v1") {
    fail(`server_status routing profile mismatch: ${status.config.routingProfileVersion}`);
  }
}

async function stopServer() {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);

  if (!exited) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => undefined);
  }
}

function fail(message) {
  clearTimeout(timeout);
  rmSync(smokeDir, { recursive: true, force: true });
  console.error(message);
  process.exit(1);
}
