// Experimental proxy feasibility probe only — not a browser egress implementation.
// Completely local: destination and denying proxy both bind 127.0.0.1.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright";

const virtualHost = "browser-egress-probe.invalid";
const proxyEvents = [];
const destinationEvents = [];
let targetSockets = 0;
let browser;

const target = createServer((request, response) => {
  destinationEvents.push(request.url);
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html><body>UNSAFE direct destination connection</body></html>");
});
target.on("connection", () => { targetSockets += 1; });
target.on("upgrade", (request, socket) => {
  destinationEvents.push("UPGRADE " + request.url);
  socket.destroy();
});

// Deliberately deny every request. This is not yet a public-IP validation
// proxy and must not be used in production.
const proxy = createServer((request, response) => {
  proxyEvents.push(request.method + " " + request.url);
  response.writeHead(403, { "content-type": "text/plain", "connection": "close" });
  response.end("test proxy denies all traffic");
});
proxy.on("connect", (request, socket) => {
  proxyEvents.push("CONNECT " + request.url);
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
});
proxy.on("upgrade", (request, socket) => {
  proxyEvents.push("UPGRADE " + request.url);
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function navigate(page, url) {
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    return response ? "HTTP " + response.status() : "no-response";
  } catch (error) {
    return "error: " + String(error.message).slice(0, 130);
  }
}

try {
  const targetPort = await listen(target);
  const proxyPort = await listen(proxy);
  browser = await chromium.launch({
    headless: true,
    args: [
      `--host-resolver-rules=MAP ${virtualHost} 127.0.0.1`,
      "--proxy-bypass-list=<-loopback>",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: "<-loopback>" },
  });
  const page = await context.newPage();

  const mappedNavigation = await navigate(page, `http://${virtualHost}:${targetPort}/mapped`);
  const firstEvents = proxyEvents.length;
  const privateNavigation = await navigate(page, `http://127.0.0.1:${targetPort}/private`);
  const secondEvents = proxyEvents.length;

  await page.goto("about:blank");
  const wsOutcome = await page.evaluate(async (port) =>
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timeout = setTimeout(() => { ws.close(); resolve("timeout"); }, 6000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve("opened"); };
      ws.onerror = () => { clearTimeout(timeout); resolve("blocked-or-failed"); };
    }), targetPort);
  const thirdEvents = proxyEvents.length;

  const report = {
    probe: "playwright-proxy-deny-all-feasibility",
    experimental_only: true,
    mapped_navigation: mappedNavigation,
    loopback_navigation: privateNavigation,
    websocket: wsOutcome,
    proxy_received_mapped: firstEvents > 0,
    proxy_received_literal_loopback: secondEvents > firstEvents,
    proxy_received_websocket: thirdEvents > secondEvents,
    target_socket_count: targetSockets,
    destination_paths: destinationEvents,
    proxy_events: proxyEvents,
  };
  console.log("BROWSER_PROXY_PROBE", JSON.stringify(report));

  assert.equal(report.proxy_received_mapped, true,
    "Proxy did not observe the mapped hostname navigation");
  assert.equal(report.proxy_received_literal_loopback, true,
    "Chromium bypassed deny-all proxy for a literal loopback navigation");
  assert.equal(report.target_socket_count, 0,
    "A direct socket reached the private destination despite a denying proxy");
  // WebSocket observation is reported but not promoted to an acceptance claim.
  // Additional CDP/WebRTC/service worker coverage is required for a real fix.
  console.log("PROXY_FEASIBILITY_COMPLETE: navigation paths checked; no security fix implemented.");
} catch (error) {
  console.error("BROWSER_PROXY_PROBE_FAILED_OR_INCONCLUSIVE", error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const server of [proxy, target]) {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
