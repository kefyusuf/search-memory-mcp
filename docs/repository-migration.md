# Repository migration

The development repository is now https://github.com/kefyusuf/search-memory-mcp.
The npm package and command remain `local-websearch-mcp`; existing local MCP configurations do not require a rename.

On 2026-10-07, the complete 119-commit main history was copied from the predecessor repository, https://github.com/kefyusuf/local-websearch-mcp. Nineteen merge messages had their old tooling branch prefix removed. Every historical commit's tree, parent order, author and committer metadata was verified against the source. Changed commits have new hashes; nineteen signatures on rewritten commits were removed because they cannot authenticate the new objects. A complete Git bundle and an old-to-new commit mapping were retained locally for recovery.

Historical PR numbers, commit hashes and CI evidence in earlier status checkpoints refer to the predecessor repository. Those PRs and their reviews were not recreated in this repository. Use the current main head and CI for present-state verification.

The migration commit updates repository links, historical branch references in the status document, and the CI target branches. It does not change application behavior. The predecessor repository remains unchanged until its separate retirement is authorized.
