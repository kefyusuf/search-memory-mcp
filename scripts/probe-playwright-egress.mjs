// Security characterization only. DO NOT merge as a claim of browser SSRF mitigation.
// This probe deliberately demonstrates whether URL-only route checks can be bypassed
// when Chromium selects a different actual network peer. All traffic stays on loopback.
import assert from "node:assert/strict";
import { promises as dns } from "node:dns";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { ContentFetcher } from "../build/fetch-module.js";

const host = "browser-egress-probe.invalid";
const mockPublicIPv4 = "8.8.8.8"; // Only Node's URL precheck sees this synthetic answer.
const original4 = dns.resolve4;
const original6 = dns.resolve6;
const requests = [];
let socketCount = 0;
let browser;
let context;

const article = "This local fixture deliberately exercises browser navigation without touching any external network. ".repeat(12);
const server = createServer((request, response) => {
  requests.push(request.url);
  if (request.url === "/page") {
    const port = server.address().port;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!DOCTYPE html><html><head><title>Browser egress fixture</title></head><body>
      <article><h1>Local browser egress probe</h1><p>${article}</p></article>
      <img src="http://127.0.0.1:${port}/private-image" alt="blocked private image">
    </body></html>`);
  } else {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("fixture private endpoint");
  }
});
server.on("connection", () => { socketCount += 1; });

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  // Node's preflight sees an allowed public IPv4 answer for only our reserved,
  // non-existent test hostname. Chromium's socket connects to local fixture.
  dns.resolve4 = async (hostname, ...args) =>
    hostname === host ? [mockPublicIPv4] : original4(hostname, ...args);
  dns.resolve6 = async (hostname, ...args) =>
    hostname === host ? [] : original6(hostname, ...args);

  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-proxy-server",
      `--host-resolver-rules=MAP ${host} 127.0.0.1`,
    ],
  });
  context = await browser.newContext();

  const cache = { async setCachedContent() {} };
  const fetcher = new ContentFetcher({
    cache,
    getBrowserContext: async () => context,
    fetchWaitUntil: "networkidle",
    forcePlaywright: () => true,
  });

  // Control: a literal private URL is rejected before Chromium connects.
  const direct = await fetcher.fetchContent(`http://127.0.0.1:${port}/direct-private`, true);
  assert.deepEqual(direct, { kind: "error", reason: "blocked_url" });
  assert.equal(socketCount, 0, "Blocked literal unexpectedly opened TCP connection");

  // Observation: the hostname looks publicly resolved during preflight, but
  // Chromium's actual socket is mapped to the local listener.
  const mapped = await fetcher.fetchContent(`http://${host}:${port}/page`, true);
  const report = {
    probe: "playwright-real-socket-boundary",
    current_behavior_only_not_a_fix: true,
    direct_private_url_blocked: direct.reason === "blocked_url",
    mapped_navigation_reached_private_fixture: requests.includes("/page"),
    mapped_navigation_result: mapped.kind === "content" ? mapped.source : mapped.reason,
    literal_private_subresource_blocked: !requests.includes("/private-image"),
    observed_connection_count: socketCount,
    fixture_paths: requests,
  };
  console.log("BROWSER_EGRESS_PROBE", JSON.stringify(report));

  assert.equal(report.mapped_navigation_reached_private_fixture, true,
    "INCONCLUSIVE: Chromium host resolver mapping did not reach local fixture");
  assert.equal(report.literal_private_subresource_blocked, true,
    "Control failure: direct private image subresource reached local fixture");
  assert.equal(mapped.kind, "content", "Expected a valid Playwright page for the controlled fixture");
  console.log("PROBE_COMPLETE: URL precheck vs Chromium socket gap demonstrated; remediation NOT implemented.");
} catch (error) {
  console.error("BROWSER_EGRESS_PROBE_FAILED_OR_INCONCLUSIVE", error);
  process.exitCode = 1;
} finally {
  dns.resolve4 = original4;
  dns.resolve6 = original6;
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  server.closeAllConnections?.();
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
}
