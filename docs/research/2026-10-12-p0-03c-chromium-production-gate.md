# P0-03C: Chromium document-body budget — production integration gate

**Status:** DESIGN FOR INDEPENDENT REVIEW / NOT APPROVED FOR PRODUCTION  
**Parent:** [P0-03 umbrella #61](https://github.com/kefyusuf/search-memory-mcp/issues/61)  
**Evidence:** [experimental Draft PR #65](https://github.com/kefyusuf/search-memory-mcp/pull/65)  
**Base:** `main` at `9e9bf0d69ee8d10b0da5a00d1ba7fde702aeb152` (2026-10-12)

This is a narrow decision record, **not** a feature specification, implementation, or proof that
Chromium memory is globally bounded. Do not merge a production change until the gates below
are independently reviewed and demonstrated on its exact head.

## Problem, evidence and limit of the evidence

`ContentFetcher.fetchViaPlaywright()` (`src/fetch-module.ts`) currently calls
`response?.body()` and only then decodes/parses its complete `Buffer`. Output truncation
after extraction is not an inbound resource limit. HTTP-first HTML, GitHub Raw/RSS and the
opt-in reader have been bounded in earlier P0-03 units; the Chromium path is the remaining gap.

The test-only Draft #65 demonstrates response-stage CDP interception, sequential bounded
`IO.read`, fail-on-oversize, and re-fulfillment of accepted HTML. Controlled tests include
exact-limit and +1, unknown/chunked, gzip/Brotli decoded bodies, redirects, a separate script,
guarded HTTPS and proxy-denied private redirects. The experimental suite is opt-in
(`P0_03C_SPIKE=1`) because some fixtures launch Chromium and use external HTTPS.

**What is not proved:** `ContentFetcher` behavior, safe cleanup under failures and concurrency,
all main-frame/iframe cases, generic CDN headers, or total Chromium-process memory isolation.
The loopback fixture is intentionally unguarded **only in isolated tests**. The production
`openGuardedBrowserContext()`/egress proxy must not be bypassed or reconfigured.

Protocol notes: CDP `Fetch.takeResponseBodyAsStream` can be used only for a response
paused at headers; after taking its stream, that request **cannot be continued as-is**.
It must be aborted or supplied with a replacement body. `IO.read` is sequential.
Playwright `Response.body()` explicitly returns a complete `Buffer`.

References:
- https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#method-takeResponseBodyAsStream
- https://chromedevtools.github.io/devtools-protocol/tot/IO/#method-read
- https://playwright.dev/docs/api/class-response#response-body

## Proposed smallest production boundary (requires review)

Only two possible production touch points: a small **Chromium-document-only** interception
helper near `src/fetch-module.ts` (an adjacent focused module only if clearer), and
`ContentFetcher.fetchViaPlaywright()`/its internal call-site decision. No generic stream
framework, new package, MCP setting, provider, proxy, or public result type.

1. Acquire the existing **shared, guarded** `BrowserContext` through
   `getBrowserContext()`, create one `Page` for the fetch, then one page-scoped CDP
   session. Never install CDP Fetch interception on the shared context or all pages.
2. Register the CDP response listener and enable interception **before** `page.goto()`.
   Preserve the existing `page.route("**/*")` URL guard, connected-IP proxy/TLS,
   service-worker blocking and normal navigation behavior.
3. Identify the **main-frame final Document** by frame identity (e.g., obtain and
   check the CDP main frame id), not `resourceType === "Document"` alone:
   subframe Document traffic is not the main article. Continue subresources,
   iframe responses and redirect status responses without calling a full-body API.
   The underlying egress proxy remains authoritative for connected-IP blocking,
   because generic Playwright route callbacks may not fire for every redirect.
4. For a supported final main-frame HTML response, call
   `Fetch.takeResponseBodyAsStream` exactly once. Read sequentially in finite
   chunks with a checked decoded-byte counter. Use the existing internal
   `maxHtmlBytes` default (**8 MiB**), including success at exactly the limit
   and rejection at limit + 1. Never use `Response.body()`, `Fetch.getResponseBody`
   or a post-allocation length check on this path.
5. On over-budget or CDP read/stream/protocol failure, mark an **internal terminal
   browser result** before cancelling/aborting the paused response. The public
   `FetchContentResult` remains `{ kind: "error", reason: "fetch_failed" }`.
   These failures must not cause another `page.goto()` retry, HTTP transport
   re-download, opt-in reader call, parse attempt, page/content cache write,
   or persistence. Ordinary pre-existing non-budget navigation failures may
   retain existing reader fallback if they remain distinguishable.
6. Accept a stream **only after explicit EOF**. Re-fulfill the intercepted response
   using the fully collected in-limit bytes, preserving meaningful response
   status/content-type/charset/security/cookie headers while removing obsolete
   framing and compression headers (`content-length`, `transfer-encoding`,
   `content-encoding`) and setting a correct new length. Invalid/missing
   response metadata or conflicting headers must not create a successful
   partial response. Do not treat the spike's experimental header handling as
   universally production-safe.
7. Parse the **captured, bounded bytes**, not Playwright `response.body()`,
   through the existing HTML decode/Readability/Turndown pipeline. Preserve
   article/public result shape, content sanitization and cache semantics for
   success. Preserve the current `networkidle` then `domcontentloaded`
   timeout retry only where doing so cannot bypass a terminal size/error state.
8. In a `finally` boundary, retire pending interception work, fail any unresolved
   paused requests, close each `IO` handle, disable/detach this page's CDP
   session and close the page. Never close another fetch's page, the shared
   context or shared guarded proxy. Account for teardown racing with navigation,
   cancellation and server shutdown. No swallowed error may become a success.

**Failure taxonomy (internal only):** `ok` with final bounded bytes; `terminal_oversize`;
`terminal_interception_failure` (missing main response, incomplete stream,
CDP detach/read failure, inability to enforce); `ordinary_navigation_failure`.
The first two terminal categories map to existing `fetch_failed` **without fallback**.
No new public error code is needed. If this cannot be expressed cleanly with
one small seam, **STOP**, do not weaken the cap.

## Reviewable acceptance matrix

| Case | Must prove before any production merge |
|---|---|
| Small/exact limit/limit+1 | HTML success and article parsing at limit; limit+1 returns terminal `fetch_failed`; no unbounded body call |
| Unknown length / misleading `Content-Length` | Enforce actual decoded stream bytes irrespective of header |
| gzip / Brotli | Both short and decompressed-oversize responses; correct replay headers |
| Normal redirects / private redirect | Preserved public redirect; private destination denied at connected-IP boundary; zero private fixture traffic |
| Mixed resources and iframe | Capture only main-frame document; subresource/iframe may continue under existing browser policy; no total-browser-memory claim |
| Fallbacks and storage | Terminal oversize/CDP error causes zero reader calls, no second transport download, zero article cache writes; ordinary recoverable failure unaffected |
| Response metadata | HTML content-type/charset, status and relevant headers preserved on accepted response; malformed/unsupported state fails closed |
| Navigation and teardown | `domcontentloaded`, `networkidle` timeout retry, navigation abort, concurrent fetches, CDP close/errors, shutdown races |
| Security | Existing `verify-browser-egress-proxy.mjs` passes; no direct connection fallback, no proxy/TLS/SSRF regression |

### Verification method

- Start with **deterministic fake CDP/session + mock fetch/cache** tests for terminal
  state propagation, page-scoped ownership, no-fallback and no-write assertions,
  together with small/exact/+1 streaming behavior. These tests must work
  offline in default Vitest, including independent error injection.
- Add a **real Chromium**, guarded-context integration test for the new
  `ContentFetcher` code path, not only the standalone spike. Gate any test
  that depends on live external HTTPS separately; keep default CI deterministic.
- Before merge: exact-head `npm ci`, build, typecheck, Vitest, real-browser
  egress security verification, MCP smoke, PostgreSQL checks, `npm audit`,
  `npm pack --dry-run`, appropriate Docker CI, and an **independent review
  of the production diff**. Report each observed result and never infer
  browser process-memory bounds from Node streaming tests.
- Retain Draft #65 as experimental evidence; **do not merge it as the fix**.
  A production proposal is a **different small Draft PR** only after this
  boundary is reviewed. Keep umbrella #61 open until all in-scope paths
  are accepted. No package version or release in the design/implementation PR.

## Stop / rollback decision

If CDP cannot distinguish the main document safely, preserve response metadata
without unsafe rewriting, or ensure fail-closed teardown alongside the existing
guarded context, classify P0-03C **NO-GO** and record the limitation. Do **not**
ship a check after `Response.body()`, a TLS-intercepting proxy, public
configuration or a broad network abstraction to make the tests green.
