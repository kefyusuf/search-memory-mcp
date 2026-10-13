import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { interceptBoundedMainDocument } from "../security/bounded-chromium-document.js";

type ReadReply = { data: string; base64Encoded?: boolean; eof?: boolean };
type Paused = {
  requestId: string; frameId: string; resourceType: string;
  responseStatusCode: number; responseHeaders: { name: string; value: string }[];
};

const FRAME = "main-frame";
const headers = [
  { name: "content-type", value: "text/html; charset=utf-8" },
  { name: "content-encoding", value: "gzip" },
  { name: "transfer-encoding", value: "chunked" },
  { name: "etag", value: '"compressed"' },
  { name: "set-cookie", value: "a=b; HttpOnly" },
];
const mainResponse = (requestId = "main", overrides: Partial<Paused> = {}): Paused => ({
  requestId, frameId: FRAME, resourceType: "Document",
  responseStatusCode: 200, responseHeaders: headers, ...overrides,
});

function fixture(reads: Array<ReadReply | Error>, stalledMethod?: string) {
  const events = new EventEmitter();
  let readIndex = 0;
  const sent: Array<{ method: string; args: Record<string, unknown> }> = [];
  const send = vi.fn(async (method: string, args: Record<string, unknown> = {}): Promise<any> => {
    sent.push({ method, args });
    if (method === stalledMethod) return new Promise<never>(() => {});
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: FRAME } } };
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
    if (method === "IO.read") {
      const next = reads[readIndex++];
      if (!next) throw new Error("No more mocked chunks");
      if (next instanceof Error) throw next;
      return next;
    }
    return {};
  });
  const detach = vi.fn(async () => {});
  const session = Object.assign(events, { send, detach }) as unknown as CDPSession;
  const context = { newCDPSession: vi.fn(async () => session) } as unknown as BrowserContext;
  const page = {} as Page;
  return { context, page, events, sent, send, detach };
}

const base64 = (text: string): ReadReply => ({
  data: Buffer.from(text, "utf8").toString("base64"), base64Encoded: true, eof: true,
});

describe("bounded Chromium main-document interceptor (offline/CDP-fake)", () => {
  it("accepts exact-limit bytes and replays only after EOF, without old framing", async () => {
    const html = "<html>SAFE</html>";
    const f = fixture([base64(html)]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, Buffer.byteLength(html));
    f.events.emit("Fetch.requestPaused", mainResponse());
    await gate.settle();
    expect(gate.terminal()).toBeNull();
    expect(gate.captured()?.body.toString("utf8")).toBe(html);
    expect(f.sent.filter(x => x.method === "IO.read")).toHaveLength(1);
    const fulfill = f.sent.find(x => x.method === "Fetch.fulfillRequest")?.args;
    expect(fulfill?.body).toBe(Buffer.from(html).toString("base64"));
    const replay = fulfill?.responseHeaders as typeof headers;
    expect(replay).toContainEqual({ name: "content-length", value: String(Buffer.byteLength(html)) });
    expect(replay).toContainEqual({ name: "set-cookie", value: "a=b; HttpOnly" });
    expect(replay.some(x => ["content-encoding", "transfer-encoding", "etag"].includes(x.name))).toBe(false);
    await gate.close();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it("rejects limit+1 bytes before fulfill and retains a terminal oversize marker", async () => {
    const f = fixture([
      { data: "12345", eof: false },
      { data: "6", eof: true },
    ]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 5);
    f.events.emit("Fetch.requestPaused", mainResponse());
    await gate.settle();
    expect(gate.terminal()).toBe("oversize");
    expect(gate.captured()).toBeNull();
    expect(f.sent.filter(x => x.method === "Fetch.fulfillRequest")).toHaveLength(0);
    expect(f.sent.filter(x => x.method === "Fetch.failRequest")).toHaveLength(1);
    expect(f.sent.filter(x => x.method === "IO.close")).toHaveLength(1);
    await gate.close();
  });

  it("counts decoded base64 octets for multi-byte UTF-8 without lossy transcoding", async () => {
    const html = "<html>Zażółć — 日本語</html>";
    const f = fixture([base64(html)]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, Buffer.byteLength(html));
    f.events.emit("Fetch.requestPaused", mainResponse());
    await gate.settle();
    expect(gate.terminal()).toBeNull();
    expect(gate.captured()?.body.equals(Buffer.from(html))).toBe(true);
    await gate.close();
  });

  it("fails closed when a non-ASCII plain CDP string cannot prove original byte length", async () => {
    const f = fixture([{ data: "café", eof: true, base64Encoded: false }]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 10);
    f.events.emit("Fetch.requestPaused", mainResponse());
    await gate.settle();
    expect(gate.terminal()).toBe("interception_failed");
    expect(gate.captured()).toBeNull();
    expect(f.sent.some(x => x.method === "Fetch.fulfillRequest")).toBe(false);
    expect(f.sent.some(x => x.method === "Fetch.failRequest")).toBe(true);
    await gate.close();
  });

  it("continues redirects, iframe documents and script responses without streaming their bodies", async () => {
    const f = fixture([base64("OK")]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 2);
    f.events.emit("Fetch.requestPaused", mainResponse("redirect", { responseStatusCode: 302 }));
    f.events.emit("Fetch.requestPaused", mainResponse("iframe", { frameId: "subframe" }));
    f.events.emit("Fetch.requestPaused", mainResponse("script", { resourceType: "Script" }));
    f.events.emit("Fetch.requestPaused", mainResponse("final"));
    await gate.settle();
    expect(f.sent.filter(x => x.method === "Fetch.continueResponse")).toHaveLength(3);
    expect(f.sent.filter(x => x.method === "Fetch.takeResponseBodyAsStream")).toHaveLength(1);
    expect(gate.captured()?.body.toString()).toBe("OK");
    await gate.close();
  });

  it("fails closed on read errors and never replays incomplete bytes", async () => {
    const f = fixture([{ data: "partial", eof: false }, new Error("CDP IO.read failed")]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 100);
    f.events.emit("Fetch.requestPaused", mainResponse());
    await gate.settle();
    expect(gate.terminal()).toBe("interception_failed");
    expect(gate.captured()).toBeNull();
    expect(f.sent.some(x => x.method === "Fetch.fulfillRequest")).toBe(false);
    expect(f.sent.some(x => x.method === "Fetch.failRequest")).toBe(true);
    await gate.close();
  });

  it("fails closed on invalid response headers without fulfilling a partial response", async () => {
    const f = fixture([base64("<html/>")]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 100);
    f.events.emit("Fetch.requestPaused", mainResponse("bad", {
      responseHeaders: [{ name: "Content-Type", value: "text/html\r\nX-Injected: yes" }],
    }));
    await gate.settle();
    expect(gate.terminal()).toBe("interception_failed");
    expect(f.sent.some(x => x.method === "Fetch.fulfillRequest")).toBe(false);
    await gate.close();
  });

  it("fails closed if a non-document paused request never finishes continuing", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([], "Fetch.continueResponse");
      const gate = await interceptBoundedMainDocument(f.context, f.page, 10);
      f.events.emit("Fetch.requestPaused", mainResponse("script", { resourceType: "Script" }));
      const settlement = gate.settle();
      await vi.advanceTimersByTimeAsync(15_001);
      await settlement;
      expect(gate.terminal()).toBe("interception_failed");
      expect(gate.captured()).toBeNull();
      await gate.close();
      expect(f.detach).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("fails closed if Fetch.disable hangs, and still detaches the page-scoped session", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([base64("OK")], "Fetch.disable");
      const gate = await interceptBoundedMainDocument(f.context, f.page, 2);
      f.events.emit("Fetch.requestPaused", mainResponse());
      await gate.settle();
      expect(gate.captured()?.body.toString()).toBe("OK");
      const closing = gate.close();
      await vi.advanceTimersByTimeAsync(15_001);
      await closing;
      expect(gate.terminal()).toBe("interception_failed");
      expect(gate.captured()).toBeNull();
      expect(f.detach).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("isolates captured bytes and oversize failures across concurrent page sessions", async () => {
    const ok = fixture([base64("OK")]);
    const big = fixture([{ data: "OVER", eof: true }]);
    const [okGate, bigGate] = await Promise.all([
      interceptBoundedMainDocument(ok.context, ok.page, 2),
      interceptBoundedMainDocument(big.context, big.page, 2),
    ]);
    ok.events.emit("Fetch.requestPaused", mainResponse("ok"));
    big.events.emit("Fetch.requestPaused", mainResponse("big"));
    await Promise.all([okGate.settle(), bigGate.settle()]);
    expect(okGate.captured()?.body.toString()).toBe("OK");
    expect(okGate.terminal()).toBeNull();
    expect(bigGate.captured()).toBeNull();
    expect(bigGate.terminal()).toBe("oversize");
    await Promise.all([okGate.close(), bigGate.close()]);
    expect(ok.detach).toHaveBeenCalledOnce();
    expect(big.detach).toHaveBeenCalledOnce();
  });

  for (const method of ["Page.getFrameTree", "Fetch.enable"] as const) {
    it(`bounds stalled CDP initialization at ${method} and detaches the page session`, async () => {
      vi.useFakeTimers();
      try {
        const f = fixture([], method);
        const initialize = interceptBoundedMainDocument(f.context, f.page, 100);
        // Allow async newCDPSession before advancing the protocol timeout.
        await vi.advanceTimersByTimeAsync(15_001);
        await expect(initialize).rejects.toThrow(`CDP ${method} stalled`);
        expect(f.detach).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });
  }

  for (const method of ["Fetch.fulfillRequest", "IO.close"] as const) {
    it(`fails closed if ${method} remains stalled on an otherwise valid document`, async () => {
      vi.useFakeTimers();
      try {
        const f = fixture([base64("OK")], method);
        const gate = await interceptBoundedMainDocument(f.context, f.page, 2);
        f.events.emit("Fetch.requestPaused", mainResponse());
        const settlement = gate.settle();
        await vi.advanceTimersByTimeAsync(15_001);
        await settlement;
        expect(gate.terminal()).toBe("interception_failed");
        expect(gate.captured()).toBeNull();
        await gate.close();
        expect(f.detach).toHaveBeenCalledOnce();
      } finally { vi.useRealTimers(); }
    });
  }

  it("does not claim a successful body when CDP never observes main-frame Document", async () => {
    const f = fixture([]);
    const gate = await interceptBoundedMainDocument(f.context, f.page, 10);
    f.events.emit("Fetch.requestPaused", mainResponse("iframe", { frameId: "subframe" }));
    await gate.settle();
    expect(gate.captured()).toBeNull();
    await gate.close();
  });
});
