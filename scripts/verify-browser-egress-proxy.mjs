// Separate browser acceptance gate, run in GitHub Actions with Chromium.
// This checks the actual browser + egress proxy, NOT mock route callbacks.
import assert from "node:assert/strict";
import { promises as dns, lookup as nodeLookup } from "node:dns";
import { createSocket as createDatagramSocket } from "node:dgram";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { openGuardedBrowserContext, startBrowserEgressProxy } from "../build/security/browser-egress-proxy.js";

const HOST = "browser-egress-probe.invalid";
const MIXED_HOST = "browser-egress-mixed.invalid";
const EMPTY_HOST = "browser-egress-empty.invalid";
const ERROR_HOST = "browser-egress-dns-error.invalid";
const PROBE_HOSTS = new Set([HOST, MIXED_HOST, EMPTY_HOST, ERROR_HOST]);
const original4 = dns.resolve4;
const original6 = dns.resolve6;
let browser;
let context;
let proxy;
let udpSocket;
let privateUdpPackets = 0;
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
  } else if (host === MIXED_HOST) {
    queueMicrotask(() => callback(null, [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]));
  } else if (host === EMPTY_HOST) {
    queueMicrotask(() => callback(null, []));
  } else if (host === ERROR_HOST) {
    queueMicrotask(() => callback(Object.assign(new Error("DNS unavailable"), { code: "ENOTFOUND" }), []));
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
    PROBE_HOSTS.has(hostname) ? ["8.8.8.8"] : original4(hostname, ...args);
  dns.resolve6 = async (hostname, ...args) =>
    PROBE_HOSTS.has(hostname) ? [] : original6(hostname, ...args);

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

  // The same real Chromium connection path must fail closed for mixed DNS,
  // empty DNS, and lookup errors. All hosts are inert reserved .invalid names.
  const mixedStatus = await navigation(page, `http://${MIXED_HOST}:${port}/mixed`);
  const emptyStatus = await navigation(page, `http://${EMPTY_HOST}:${port}/empty`);
  const failedDnsStatus = await navigation(page, `http://${ERROR_HOST}:${port}/dns-error`);
  assert.equal(mixedStatus, 403, "Mixed public/private DNS answer was not blocked");
  assert.equal(emptyStatus, 403, "Empty DNS answer was not blocked");
  assert.equal(failedDnsStatus, 502, "DNS failure was not rejected");
  assert.equal(destinationSockets, 0, "One of the DNS failure paths reached a private socket");

  // Route fulfilment simulates only the INITIAL public HTTP 302, so the
  // redirected request still travels through Chromium's actual proxy.
  await page.route("https://safe-redirect.invalid/start", async (route) =>
    route.fulfill({
      status: 302,
      headers: { location: `http://127.0.0.1:${port}/redirect-private` },
      body: "",
    }),
  );
  const redirectStatus = await navigation(page, "https://safe-redirect.invalid/start");
  assert.equal(redirectStatus, 403, "Chromium redirect bypassed the private-IP proxy guard");
  assert.equal(destinationSockets, 0, "Private redirect opened a real TCP socket");

  await page.goto("about:blank");
  // The page must actually attempt these requests. A zero-socket count alone
  // is not sufficient if Chromium never starts the network operation.
  const observedBrowserUrls = new Set();
  page.on("request", (request) => observedBrowserUrls.add(request.url()));
  const scriptUrl = `http://${HOST}:${port}/script-rebound-private`;
  const browserFetchUrl = `http://${HOST}:${port}/browser-fetch-rebound-private`;
  await page.setContent(
    `<img src="http://127.0.0.1:${port}/image-private" />` +
    `<script src="${scriptUrl}"></script>`,
  );
  await page.waitForTimeout(250);
  assert.ok(observedBrowserUrls.has(scriptUrl), "Chromium did not request the script subresource");
  assert.equal(destinationSockets, 0, "Private image/script subresource bypassed proxy");

  // Browser-side fetch() is separate from navigation and passive subresources.
  // The synthetic public-looking hostname resolves to loopback only at the
  // guarded connection boundary. No local TCP connection is permitted.
  const browserFetchResult = await page.evaluate(async (target) => {
    try {
      const response = await fetch(target);
      return `http_${response.status}`;
    } catch {
      return "rejected";
    }
  }, browserFetchUrl);
  assert.ok(observedBrowserUrls.has(browserFetchUrl), "Chromium did not attempt browser-side fetch()");
  assert.notEqual(browserFetchResult, "http_200", "Browser-side fetch unexpectedly returned success");
  assert.equal(destinationSockets, 0, "Browser-side fetch reached a private TCP socket");

  const wsResult = await page.evaluate(async (targetPort) =>
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${targetPort}/ws`);
      const timeout = setTimeout(() => { ws.close(); resolve("timeout"); }, 5000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve("opened"); };
      ws.onerror = () => { clearTimeout(timeout); resolve("rejected"); };
    }), port);
  assert.notEqual(wsResult, "opened", "WebSocket unexpectedly connected");
  assert.equal(destinationSockets, 0, "WebSocket reached private socket");

  // Browser-side WebRTC STUN UDP attempts must not bypass the proxy policy.
  // Chromium is launched with disable_non_proxied_udp; verify against a real
  // private datagram listener, not just navigator/network instrumentation.
  udpSocket = createDatagramSocket("udp4");
  udpSocket.on("message", () => { privateUdpPackets += 1; });
  await new Promise((resolve) => udpSocket.bind(0, "127.0.0.1", resolve));
  const udpPort = udpSocket.address().port;
  const rtcOutcome = await page.evaluate(async (stunPort) => {
    const rtc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${stunPort}` }] });
    try {
      rtc.createDataChannel("egress-probe");
      const offer = await rtc.createOffer();
      await rtc.setLocalDescription(offer);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return rtc.iceGatheringState;
    } finally { rtc.close(); }
  }, udpPort);
  assert.equal(privateUdpPackets, 0, "Browser WebRTC sent STUN datagram to private IP");

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
    mixed_dns_private: mixedStatus,
    empty_dns: emptyStatus,
    dns_failure: failedDnsStatus,
    redirect_to_private: redirectStatus,
    private_image_blocked: !destinationRequests.includes("/image-private"),
    private_script_blocked: !destinationRequests.includes("/script-rebound-private"),
    browser_fetch: browserFetchResult,
    browser_fetch_private_blocked: !destinationRequests.includes("/browser-fetch-rebound-private"),
    websocket: wsResult,
    webrtc_ice_state: rtcOutcome,
    private_udp_packets: privateUdpPackets,
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
  if (udpSocket) await new Promise((resolve) => udpSocket.close(resolve));
  destination.closeAllConnections?.();
  if (destination.listening) await new Promise((resolve) => destination.close(resolve));
}
