import type { BrowserContext, CDPSession, Page } from "playwright";

/**
 * A byte budget for the final main-frame Chromium Document response only.
 * It does NOT cap Chromium's renderer memory or subresource downloads.
 * Keep this interception page-scoped and use only with a guarded context.
 */
export type DocumentBudgetFailure = "oversize" | "interception_failed";

type Header = { name: string; value: string };
type PausedResponse = {
  requestId: string;
  frameId?: string;
  resourceType: string;
  responseStatusCode?: number;
  responseHeaders?: Header[];
};
type DocumentData = { body: Buffer; url?: string };

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READS = 8192;
const IO_READ_TIMEOUT_MS = 15_000;
// Bounded cleanup: protocol sends other than IO.read can also stall.
const CDP_SETTLE_TIMEOUT_MS = 15_000;
const OMIT_REPLAY_HEADERS = new Set([
  "content-length", "transfer-encoding", "content-encoding",
  "content-md5", "digest", "etag", "content-range", "accept-ranges",
]);

function isRedirect(code: number): boolean {
  return code >= 300 && code < 400;
}

/**
 * CDP IO.read may yield a plain UTF-8 string instead of original octets.
 * We can safely reconstruct ASCII; for non-ASCII plain strings fail closed
 * rather than miscounting an unknown original charset. Base64 preserves bytes.
 */
function decodeChunk(result: { data: string; base64Encoded?: boolean }): Buffer {
  if (result.base64Encoded) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data)) {
      throw new Error("Invalid CDP base64 response chunk");
    }
    return Buffer.from(result.data, "base64");
  }
  if (/[^\x00-\x7f]/.test(result.data)) {
    throw new Error("Non-ASCII CDP text cannot be reconstructed losslessly");
  }
  return Buffer.from(result.data, "ascii");
}

function safeReplayHeaders(original: Header[] | undefined, length: number): Header[] {
  if (!original) throw new Error("CDP omitted response headers");
  const headers: Header[] = [];
  for (const { name, value } of original) {
    if (!name || /[^!#$%&'*+.^_`|~0-9a-zA-Z-]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error("Invalid CDP response header");
    }
    if (!OMIT_REPLAY_HEADERS.has(name.toLowerCase())) headers.push({ name, value });
  }
  headers.push({ name: "content-length", value: String(length) });
  return headers;
}

async function withDeadline<T>(operation: Promise<T>, label: string, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`CDP ${label} stalled`)), ms);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readWithDeadline(session: CDPSession, handle: string): Promise<{
  data: string; base64Encoded?: boolean; eof?: boolean;
}> {
  return withDeadline(session.send("IO.read", { handle, size: READ_CHUNK_BYTES }),
    "IO.read", IO_READ_TIMEOUT_MS);
}

export type BoundedDocumentInterceptor = {
  /** Defined only after a complete, in-budget body was re-fulfilled. */
  captured(): DocumentData | null;
  terminal(): DocumentBudgetFailure | null;
  /** Discard an earlier successful document before a second navigation attempt. */
  resetForNavigation(): void;
  /** Called after navigation settles; drains current asynchronous CDP handlers. */
  settle(): Promise<void>;
  /** Disables only this page's CDP interception and detaches its session. */
  close(): Promise<void>;
};

/** Installs response-stage interception before page.goto(). */
export async function interceptBoundedMainDocument(
  context: BrowserContext, page: Page, maxBytes: number,
): Promise<BoundedDocumentInterceptor> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid document byte budget");
  const session = await context.newCDPSession(page);
  let enabled = false;
  let disposed = false;
  let failure: DocumentBudgetFailure | null = null;
  let document: DocumentData | null = null;
  const pending = new Set<Promise<void>>();
  try {
    const frames = await session.send("Page.getFrameTree");
    const mainFrameId = frames?.frameTree?.frame?.id as string | undefined;
    if (!mainFrameId) throw new Error("Cannot identify CDP main frame");

    async function handlePaused(event: PausedResponse): Promise<void> {
      let handle: string | undefined;
      try {
        if (disposed) return;
        const status = event.responseStatusCode;
        if (event.resourceType !== "Document" || event.frameId !== mainFrameId ||
            (status !== undefined && isRedirect(status))) {
          await session.send("Fetch.continueResponse", { requestId: event.requestId });
          return;
        }
        // This is the main-frame final document. A malformed response cannot
        // bypass the cap via a follow-up reader/transport.
        document = null;
        if (!status || status < 100 || status > 599 || !event.responseHeaders) {
          throw new Error("Missing main-document response metadata");
        }
        handle = (await session.send("Fetch.takeResponseBodyAsStream", { requestId: event.requestId })).stream;
        if (!handle) throw new Error("No CDP response stream");
        let total = 0;
        const chunks: Buffer[] = [];
        let eof = false;
        for (let reads = 0; reads < MAX_READS; reads++) {
          const result = await readWithDeadline(session, handle);
          if (typeof result?.data !== "string") throw new Error("Invalid CDP IO.read result");
          const chunk = decodeChunk(result);
          total += chunk.byteLength;
          if (total > maxBytes) {
            failure ??= "oversize";
            await session.send("Fetch.failRequest", {
              requestId: event.requestId, errorReason: "BlockedByClient",
            }).catch(() => {});
            return;
          }
          chunks.push(chunk);
          if (result.eof) { eof = true; break; }
        }
        if (!eof) throw new Error("CDP stream did not reach EOF");
        const body = Buffer.concat(chunks, total);
        const responseHeaders = safeReplayHeaders(event.responseHeaders, body.byteLength);
        await session.send("Fetch.fulfillRequest", {
          requestId: event.requestId,
          responseCode: status,
          responseHeaders,
          body: body.toString("base64"),
        });
        if (!failure) document = { body };
      } catch {
        failure ??= "interception_failed";
        document = null;
        await session.send("Fetch.failRequest", {
          requestId: event.requestId, errorReason: "Failed",
        }).catch(() => {});
      } finally {
        if (handle) {
          await session.send("IO.close", { handle }).catch(() => {});
        }
      }
    }

    session.on("Fetch.requestPaused", (event: unknown) => {
      const task = handlePaused(event as PausedResponse);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    });
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Response" }],
    });
    enabled = true;
    return {
      captured: () => document,
      terminal: () => failure,
      resetForNavigation: () => { document = null; },
      settle: async () => {
        try {
          await withDeadline(Promise.allSettled([...pending]), "response settlement", CDP_SETTLE_TIMEOUT_MS);
        } catch {
          // Includes paused non-document requests or Fetch.failRequest/IO.close
          // that never settle; never convert this to a reader-eligible failure.
          failure ??= "interception_failed";
          document = null;
        }
      },
      close: async () => {
        if (disposed) return;
        disposed = true;
        let teardownFailed = false;
        if (enabled) {
          try {
            await withDeadline(session.send("Fetch.disable"), "Fetch.disable", CDP_SETTLE_TIMEOUT_MS);
          } catch { teardownFailed = true; }
        }
        try {
          await withDeadline(session.detach(), "session detach", CDP_SETTLE_TIMEOUT_MS);
        } catch { teardownFailed = true; }
        if (teardownFailed) {
          failure ??= "interception_failed";
          document = null;
        }
      },
    };
  } catch (error) {
    if (enabled) await session.send("Fetch.disable").catch(() => {});
    await session.detach().catch(() => {});
    throw error;
  }
}
