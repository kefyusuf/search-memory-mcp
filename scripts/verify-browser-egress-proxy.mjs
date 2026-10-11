// Separate browser acceptance gate, run in GitHub Actions with Chromium.
// This checks the actual browser + egress proxy, NOT mock route callbacks.
import assert from "node:assert/strict";
import { promises as dns, lookup as nodeLookup } from "node:dns";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { openGuardedBrowserContext, startBrowserEgressProxy } from "../build/security/browser-egress-proxy.js";

const HOST = "browser-egress-probe.invalid";
const original4 = dns.resolve4;
const original6 = dns.resolve6;
let browser;
let context;
let proxy;
const destinationRequests = [];
let destinationSockets = 0;
const destination = createServer((request, response) => {
  destinationRequests.push(request.url);
  response.end("unsafe private fixture");
});
destination.on("connection", () => { destinationSockets += 1; });
destination.on("upgrade", (request, socket) => {
  destinationRequests.push("UPGRADE " + request.url);
  socket.destroy();
});

function mappedResolver(host, opts, callback) {
  if (host === HOST) {
    queueMicrotask(() => callback(null, [{ address: "127.0.0.1", family: 4 }]));
  } else nodeLookup(host, opts, callback);
}

function navigation(page, url) {
  return page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 })
    .then((response) => response ? response.status() : null)
    .catch((error) => "failed: " + String(error.message).slice(0, 100));
}

try {
  await new Promise((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const port = destination.address().port;
  dns.resolve4 = async (hostname, ...args) =>
    hostname === HOST ? ["8.8.8.8"] : original4(hostname, ...args);
  dns.resolve6 = async (hostname, ...args) =>
    hostname === HOST ? [] : original6(hostname, ...args);

  proxy = await startBrowserEgressProxy(mappedResolver);
  browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-background-networking",
    ],
  });
  context = await browser.newContext({
    proxy: { server: proxy.url, bypass: "<-loopback>" },
    serviceWorkers: "block",
  });
  const page = await context.newPage();

  const literalStatus = await navigation(page, `http://127.0.0.1:${port}/literal-private`);
  assert.equal(destinationSockets, 0, "Direct private navigation reached fixture");

  const reboundStatus = await navigation(page, `http://${HOST}:${port}/rebound`);
  assert.equal(destinationSockets, 0, "DNS-rebound navigation reached private socket");

  await page.goto("about:blank");
  await page.setContent(`<img src="http://127.0.0.1:${port}/image-private" />`);
  await page.waitForTimeout(250);
  assert.equal(destinationSockets, 0, "Private subresource bypassed proxy");

  const wsResult = await page.evaluate(async (targetPort) =>
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws`);
      const timeout = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve("opened"); };
      ws.onerror = () => { clearTimeout(timeout); resolve("rejected"); };
    }), port);
  assert.notEqual(wsResult, "opened", "WebSocket unexpectedly connected");
  assert.equal(destinationSockets, 0, "WebSocket reached private socket");

  // New independent context from the exact production startup helper,
  // with its default real resolver, must also preserve ordinary public HTTPS.
  await context.close();
  context = undefined;
  await proxy.close();
  proxy = undefined;
  const production = await openGuardedBrowserContext(browser);
  context = production.context;
  proxy = production.proxy;
  const realPage = await context.newPage();
  const secure = await realPage.goto("https://example.com/", {
    waitUntil: "domcontentloaded", timeout: 20000,
  });
  assert.ok(secure?.ok(), "Legitimate HTTPS navigation failed in the actual production guarded context");
  assert.equal(new URL(realPage.url()).hostname, "example.com");
  assert.equal(destinationSockets, 0);

  const preShutdownCount = destinationSockets;
  await proxy.close();
  proxy = undefined;
  const afterStop = await navigation(realPage, `http://127.0.0.1:${port}/after-shutdown`);
  assert.equal(destinationSockets, preShutdownCount, "Chromium used DIRECT after proxy shutdown");

  console.log("GUARDED_BROWSER_EGRESS", JSON.stringify({
    literal_private: literalStatus,
    rebound_private: reboundStatus,
    private_image_blocked: !destinationRequests.includes("/image-private"),
    websocket: wsResult,
    https_status: secure.status(),
    https_hostname: new URL(secure.url()).hostname,
    after_proxy_shutdown: afterStop,
    private_tcp_connections: destinationSockets,
    private_http_requests: destinationRequests,
  }));
  console.log("GUARDED_BROWSER_EGRESS_PASS");
} catch (error) {
  console.error("GUARDED_BROWSER_EGRESS_FAILURE", error);
  process.exitCode = 1;
} finally {
  dns.resolve4 = original4;
  dns.resolve6 = original6;
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (proxy) await proxy.close().catch(() => {});
  destination.closeAllConnections?.();
  if (destination.listening) await new Promise((resolve) => destination.close(resolve));
}
