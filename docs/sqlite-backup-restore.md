# Disposable SQLite backup and restore rehearsal

Date: 2026-10-08. Parent implementation: `d6ac843`. Scope: a local regression and documentation; no new command, tool, runtime behavior or live user-data operation.

## Mechanism

The existing `better-sqlite3` [backup API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md#backupdestination-options---promise) uses SQLite's [Online Backup API](https://www.sqlite.org/backup.html). It copies a consistent database image, including committed WAL changes, instead of treating the main `.db` file as a complete live backup. Completion must be awaited before using the backup.

The rehearsal pauses application writes and waits for pending document embeddings with `KnowledgeIndex.flush()`. Source connections stay open. This avoids claiming that a SQLite snapshot alone makes separate knowledge-ingest and graph-index transactions an atomic application operation. Pending jobs and other process-only state are outside the database backup.

## Executed regression

`src/__tests__/sqlite-backup-restore.test.ts` owns one temporary directory containing separate source, backup, restored and negative-control database paths. It performs these steps:

1. Populate the source through the four public stores with a session note and its metadata, cached content, cache vector/namespace, a knowledge document and its chunk vector, and entity links. Only model inference is replaced with a fixed fixture embedding; native SQLite, FTS and `sqlite-vec` execute normally. No model downloads or network calls occur.
2. Keep an older read snapshot open so a new committed note remains outside the main database file. A main-file-only copy must not recover that note: missing data or `SQLITE_CORRUPT` is accepted only in this negative control. Unexpected errors fail the regression. Release the old snapshot before the actual backup.
3. Use the read-only source connection and await `backup()` into an owned new path. Require zero remaining pages. No new application writes occur while copying.
4. Change the source after backup completion. Copy the completed backup into a new restore path using exclusive creation; no source or existing target is overwritten.
5. Open all four stores on the restore path. Require the original note/metadata, content, cache-vector lookup, document/FTS retrieval, knowledge-vector count and lookup, and graph references to survive. Require post-backup source changes to be absent and SQLite integrity/foreign-key checks to pass.
6. Write to the restored memory store and verify the source is independent. Close all owned connections and remove only the owned temporary directory.

This regression checks physical backup portability and useful restored state within the same installed runtime. It does not measure semantic embedding quality or prove that copying a live `.db` file is ever an adequate backup policy.

Local pre-PR verification with Node 24 passed: the focused rehearsal, project typecheck and all 54 test files / 566 tests. The source baseline is `d6ac843`; hosted CI results are tracked separately in the pull request.

## Operating boundaries

- A future operator workflow must resolve the actual source path, protect access to the whole database, pause application writes, drain pending indexing, create a new backup destination and await successful completion.
- Restore into a separate new directory first, verify representative queries and integrity, and preserve the original database. Replacing an active database or its WAL sidecars is outside this rehearsal.
- The backup includes every table/scope in the physical file. It is not a tenant-filtered export or a hosted user-facing operation.
- Backup retention, encryption, access control, disk exhaustion, cancellation, interrupted backup cleanup, automatic scheduling, offline recovery, cross-version restore and production recovery timing remain unqualified.
- No live LM Studio database or configuration was changed. No Docker resources or worktrees were created or removed. CI evidence must be recorded separately when this test is published.
