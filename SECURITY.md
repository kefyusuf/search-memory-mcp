# Security Policy

## Supported Versions

Security fixes are handled on the default branch until the project publishes versioned release branches.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub Issues if the report does not contain sensitive exploit details. If the report includes sensitive details, contact the maintainer privately before publishing a proof of concept.

Do not include secrets, private tokens, or credentials in reports.

## Current Security Notes

The server includes SSRF protection for `fetch_content`, rate limiting for public MCP tools, and no requirement for external API keys.

Dependency security is enforced in CI with `npm audit --audit-level=moderate`; moderate-or-higher findings fail the CI job.

The project uses the maintained `@huggingface/transformers` package for local model pipelines. Two npm overrides keep transitive native/archive dependencies on patched releases:

- `sharp` is pinned to `0.35.4` to address libheif advisories (GHSA-rgj7-g3m4-5g8c, GHSA-2jg2-4ch7-h545).
- `adm-zip` is pinned to `0.6.1` to address symlink-extraction and memory-allocation advisories.

Remove these overrides when the corresponding upstream dependency ranges include patched versions and the blocking audit remains clean without local intervention.

On 2026-10-02, the lockfile was updated to `fast-uri` 3.1.8 and `ip-address` 10.7.3 to remediate the URI authority parsing and IP classification advisories reported by npm audit. The audit reported zero vulnerabilities after these updates.
