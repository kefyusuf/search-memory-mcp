# Contributing to Search Memory MCP

Thank you for considering a contribution. This document covers local setup, the checks every change must pass, and what reviewers look for in pull requests.

## Reporting security issues

Please do not open public issues for vulnerabilities. See [SECURITY.md](SECURITY.md) for the reporting policy and for what the server already protects against (SSRF boundaries, untrusted-content handling, dependency overrides).

## Dev setup

Requirements:

- Node.js 20.9–25 (`.nvmrc` pins 24; Node 26 is excluded on purpose — see `engines` in `package.json`)
- Docker is only needed for the optional SearXNG provider and the published image

```bash
npm ci          # installs Playwright Chromium via postinstall
npm run build   # clean + tsc -> build/
```

If your package manager skipped install scripts, run `npx playwright install chromium`.

## Checks

CI runs the same pipeline locally, and every pull request must keep it green:

| Command                                 | What it does                                              |
| --------------------------------------- | --------------------------------------------------------- |
| `npm test`                              | Unit/integration suite (vitest, `*.test.ts` under `src/`) |
| `npm run typecheck`                     | `tsc --noEmit` over `src/`                                |
| `npm run typecheck:tests`               | Typecheck over the tests as well                          |
| `npm run lint` / `npm run format:check` | Biome lint and formatting                                 |
| `npm run smoke:mcp`                     | Spawns the server over stdio and exercises the protocol   |
| `npm run eval:quality`                  | Offline retrieval-quality set (deterministic)             |
| `npm run test:coverage`                 | The suite with a v8 coverage report                       |
| `npm audit --audit-level=moderate`      | Dependency gate; moderate-or-worse fails CI               |

Some verifications need services. The Postgres-backed scripts (`npm run test:postgres`, `test:restore-authorization`, …) expect `MEMBERSHIP_TEST_DATABASE_URL`, and the browser-egress drill (`scripts/verify-browser-egress-proxy.mjs`) drives a real Chromium. CI runs them on Linux; locally, a local Postgres or Docker works.

## Pull requests

- One focused change per PR. If a change fixes two unrelated things, split it into two.
- Follow Conventional Commits: `feat:`, `fix:`, `perf:`, `docs:`, `ci:`, `chore:`, … optionally scoped, e.g. `fix(hosted): ...`.
- If an advisory blocks the audit gate, pin the transitive dependency with a short rationale and a removal note — the `sharp`/`adm-zip` overrides documented in SECURITY.md are the pattern to follow.
- Documentation goes with the change: user-visible behavior → README; security boundaries → SECURITY.md; architectural decisions → an ADR in `docs/adr/`.

## Style

- TypeScript strict mode with ES modules (`module: nodenext`).
- Biome is the single lint and formatting tool; `npm run format` fixes formatting.
- Tests are vitest files named `*.test.ts` somewhere under `src/`; the annotation hints on each MCP tool (`readOnlyHint`, `openWorldHint`, …) are covered by their own test — keep them accurate when adding or changing tools.
