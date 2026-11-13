import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSearchServer } from "../index.js";

describe("WebSearchServer shutdown", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // Prototype-only fixture avoids constructing persistence/embedding systems;
  // this directly exercises the same lifecycle method the signal handlers use.
  function fixture() {
    const order: string[] = [];
    const subject = Object.create(WebSearchServer.prototype) as WebSearchServer & {
      shutdown(): Promise<void>;
      browserShuttingDown: boolean;
      closeBrowserResources(): Promise<void>;
      contentFetcher: { close(): void };
      cache: { close(): void };
      knowledgeIndex: { close(): void };
      sessionMemory: { close(): void };
      entityGraph: { close(): void };
      server: { close(): Promise<void> };
    };
    subject.browserShuttingDown = false;
    subject.closeBrowserResources = vi.fn(async () => { order.push("browser"); });
    subject.contentFetcher = { close: vi.fn(() => { order.push("fetcher"); }) };
    subject.cache = { close: vi.fn(() => { order.push("cache"); }) };
    subject.knowledgeIndex = { close: vi.fn(() => { order.push("knowledge"); }) };
    subject.sessionMemory = { close: vi.fn(() => { order.push("memory"); }) };
    subject.entityGraph = { close: vi.fn(() => { order.push("graph"); }) };
    subject.server = { close: vi.fn(async () => { order.push("server"); }) };
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    return { subject, order, exit };
  }

  it("closes every resource, then exits so stdio cannot keep the process alive", async () => {
    const { subject, order, exit } = fixture();
    await subject.shutdown();
    expect(order).toEqual(["browser", "fetcher", "cache", "knowledge", "memory", "graph", "server"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("ignores concurrent shutdown signals", async () => {
    const { subject, exit } = fixture();
    subject.browserShuttingDown = true;
    await subject.shutdown();
    expect(subject.closeBrowserResources).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});