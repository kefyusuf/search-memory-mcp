# Security Policy

## Supported Versions

Security fixes are handled on the default branch until the project publishes versioned release branches.

## Reporting a Vulnerability

Please report vulnerabilities through GitHub Issues if the report does not contain sensitive exploit details. If the report includes sensitive details, contact the maintainer privately before publishing a proof of concept.

Do not include secrets, private tokens, or credentials in reports.

## Current Security Notes

The server includes SSRF protection for `fetch_content`, rate limiting for public MCP tools, and no requirement for external API keys.

Fetched web content is treated as untrusted. Before a page is cached or returned, the server removes text a reader cannot see (the `hidden` attribute, `aria-hidden="true"`, `<template>`, and inline `display:none`, `visibility:hidden`, `opacity:0` or `font-size:0`; styles from stylesheets are not evaluated) and strips zero-width, bidi-control and Unicode tag characters, which are common carriers for hidden instructions. Text output from `web_search`, `fetch_content`, `research` and `search_index` is wrapped in an `<untrusted_web_content>` marker with a note that it is data, not instructions, and the content cannot close that marker. Tool descriptions repeat the warning. These measures reduce indirect prompt injection; they do not prevent it, so clients should still confirm sensitive actions.

Local file reading in `ingest_document` is disabled by default. It reads only files whose real path (after resolving symlinks) is inside a directory listed in `INGEST_ALLOWED_DIRS`, never hidden files or files inside hidden folders, and nothing above 25 MB. Only list directories whose contents you are willing to put into the knowledge base, because an agent can be instructed by untrusted web content to call this tool.

Dependency security is enforced in CI with `npm audit --audit-level=moderate`; moderate-or-higher findings fail the CI job.

The project uses the maintained `@huggingface/transformers` package for local model pipelines. Two npm overrides keep transitive native/archive dependencies on patched releases:

- `sharp` is pinned to `0.35.4` to address libheif advisories (GHSA-rgj7-g3m4-5g8c, GHSA-2jg2-4ch7-h545).
- `adm-zip` is pinned to `0.6.1` to address symlink-extraction and memory-allocation advisories.

Remove these overrides when the corresponding upstream dependency ranges include patched versions and the blocking audit remains clean without local intervention.

On 2026-10-02, the lockfile was updated to `fast-uri` 3.1.8 and `ip-address` 10.7.3 to remediate the URI authority parsing and IP classification advisories reported by npm audit. The audit reported zero vulnerabilities after these updates.
