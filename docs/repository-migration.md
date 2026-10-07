# Repository migration

The development repository is now https://github.com/kefyusuf/search-memory-mcp.
The npm package, CLI command, MCP server identity and Docker service/image are now `search-memory-mcp`. Clients that launch the package by name must use the new command after installation. Clients that launch `node` with an existing absolute `build/index.js` path continue to work from that path; the repository directory does not need to be renamed. Persistent database paths and Docker volume keys remain unchanged to retain existing data.

On 2026-10-07, the complete 119-commit main history was copied from the predecessor repository, https://github.com/kefyusuf/local-websearch-mcp. Nineteen merge messages had their old tooling branch prefix removed. Every historical commit's tree, parent order, author and committer metadata was verified against the source. Changed commits have new hashes; nineteen signatures on rewritten commits were removed because they cannot authenticate the new objects. A complete Git bundle and an old-to-new commit mapping were retained locally for recovery.

Historical PR numbers, commit hashes and CI evidence in earlier status checkpoints refer to the predecessor repository. Those PRs and their reviews were not recreated in this repository. Use the current main head and CI for present-state verification.

The original migration commit updates repository links, historical branch references in the status document, and the CI target branches. The subsequent name-alignment change updates the package, command, server identity, logs and Docker branding. The predecessor repository remains unchanged until its separate retirement is authorized.

When moving an existing Docker checkout to a differently named directory, keep its existing Compose project name with `docker compose -p <existing-compose-project> up` so its persistent volumes are reused. Renaming the service or image does not migrate volumes between Compose projects. Existing running containers are not changed automatically.
