# Local SQLite process-crash recovery

Date: 2026-10-08. Parent implementation: `ad2f594`; this checkpoint records local pre-PR verification of the durability correction.

## Policy and scope

The cache, knowledge index, session memory and entity graph share a SQLite file. All four connections now request `journal_mode=WAL` and `synchronous=FULL`. SQLite retains `MEMORY` journal mode for `:memory:` databases; the existing in-memory test suites continue to work.

WAL supports the current same-host connection topology. Store the database in a writable local directory, not on a network filesystem. WAL and FULL are documented SQLite mechanisms, not independent proof of the machine's filesystem or power-loss behavior. See [WAL](https://www.sqlite.org/wal.html) and [synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous).

This change does not add a backup command or change application records. WAL sidecars belong to an open database: copying only the database file during writes is not a qualified backup. Consistent backup creation and successful restore remain a separate task.

## Regression experiment

`src/__tests__/sqlite-durability.test.ts` creates an owned temporary database and stores a committed note, cached content, a native-vector cache entry, an indexed document and graph links through their public interfaces.

The child fixture calls the real `SessionMemory.remember` operation with a one-note retention limit. It injects a pause after the transaction callback has inserted a replacement note and removed the previous note, but before commit. An eight-megabyte note and a small SQLite page cache force uncommitted pages to spill. The parent kills only this owned child process at its IPC checkpoint.

After reopening, the test requires the committed note to survive, the interrupted replacement to be absent, the content/vector/document/graph references to remain available and `integrity_check` to return `ok`. A second test checks the file's WAL mode after each of the four stores opens, with simultaneous connections, and again after closing and reopening. Both tests close their connections and remove their owned temporary directories.

- RED: original MEMORY policy produced `database disk image is malformed` when retrieving the committed note after interruption.
- GREEN: the same fixture passed with WAL/FULL.
- Local checks: typecheck and TypeScript compilation passed; 53 test files / 565 tests passed; compiled eleven-tool stdio smoke passed.
- A separate local diagnostic read effective settings on all four real connections: file-backed connections reported `wal` / `synchronous=2`; all four `:memory:` connections reported `memory` / `synchronous=2`. Evidence remains ignored in `.cache/sqlite-policy-probe.json`. Process termination alone cannot distinguish FULL from NORMAL durability.
- The active Node `24.19.0` native binding reports SQLite `3.53.0`, newer than the upstream [WAL-reset fix](https://www.sqlite.org/wal.html#walreset). Other installed bindings must be verified independently.
- The unchanged synthetic in-memory quality fixture retained retrieval precision@1 0.84615, recall@3 0.92308 and MRR 0.88462; entity F1 0.81250 and zero count mismatches.

The child uses the repository's existing `ts-node/esm` development loader so it executes current source rather than stale compiled artifacts. `TS_NODE_TRANSPILE_ONLY` applies only to that child; the normal project typecheck remains a separate verification step.

## Limits

The local evidence is from Node 24 on Windows. This is one bounded process-termination scenario, not a power-loss test, performance benchmark, distributed storage qualification or backup/restore rehearsal. Hosted CI results are tracked in the pull request separately from this local checkpoint. No live LM Studio database, client configuration, Docker resource or worktree was modified.
