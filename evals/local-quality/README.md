# Local quality characterization

This synthetic, manually labelled fixture contains eight documents, fifteen retrieval queries and eight entity cases. It characterizes the current compiled implementation without web access, model downloads or user data. It is a small diagnostic baseline, not a general search benchmark or a production acceptance gate.

Build with the Node 24 runtime that matches the installed native SQLite binding, then run:

```text
npm run build
node scripts/eval-local-quality.mjs
```

The runner prints JSON. Keep generated reports in ignored `.cache/`; fixture text and the runner are project-owned evaluation inputs.

## Retrieval labels

All documents share one in-memory index with embeddings disabled. Queries include direct lexical matches, natural language, Turkish text, mixed language, a Turkish-only query targeting English content, paraphrasing, multiple relevant sources and unrelated requests.

The index returns at most five chunks. The runner deduplicates their sources in returned order before calculating document-level recall, precision and reciprocal rank. It does not overfetch to obtain five distinct sources. `duplicateSourceChunks` exposes repeated chunks consuming the result budget. Precision uses the number of returned distinct sources, consistent with the existing metric implementation.

Positive queries and empty-gold negative queries are reported separately: irrelevant-query behavior must not inflate or dilute recall. Negative labels mean no document answers the complete request; a token overlap alone is insufficient. Mixed-language performance does not establish cross-language semantic retrieval. Embeddings, reranking and live provider quality are outside this baseline.

## Entity labels

Gold labels include named software, languages and multi-word product names, with their exact visible spelling and number of textual mentions. Generic headings, instructions and fragments of a multi-word name are excluded. Matching is exact and case-sensitive; this fixture does not claim a universal entity ontology. No aliases or fuzzy matching conceal differences.

The report lists extra names, missing names and incorrect counts separately. An entity present with a wrong mention count still counts as a true positive for name precision/recall; `countMismatches` captures the independent counting defect. Scores are micro-averaged across cases. A zero exit status means the evaluation ran successfully, not that quality is acceptable.

## Initial observation

Measured against implementation commit `445fced9e65d391eecc3eb107afa1ec9052d1fb2` with Node v24.19.0. Two consecutive runs produced identical reports.

- Thirteen positive retrieval queries: precision@1 0.8462, recall@3 0.9231, MRR 0.8846. The ten lexical queries each returned a relevant source first. The Turkish-only query targeting English content returned no result; this is an expected limitation of the FTS-only mode. The paraphrase ranked its relevant source second.
- One of two negative queries returned no result; the other returned a Redis document based on token overlap despite an unrelated certification request.
- Repeated chunks from one document consumed result slots in two queries. Metrics deduplicate these source IDs, so repeated chunks do not inflate recall.
- Entity name precision 0.5200, recall 0.8667, F1 0.6500. There were nine incorrect mention counts. The phrase/token extraction passes count standalone names twice; multi-word names also emit their component words, headings span line breaks, punctuation joins names across a sentence boundary, and C++/C# are absent.

These observations identify separate candidates, not an approved combined rewrite. A narrow first correction would prevent double-counting the same standalone mention, with a focused regression and this unchanged fixture as before/after evidence.

## Standalone mention correction

The extractor now counts an occurrence only once when both extraction passes return the same name at the same text offset. Distinct mentions and overlapping multi-word/component names remain separate.

With the unchanged fixture, incorrect mention counts fell from nine to zero. Entity name precision/recall/F1 and all retrieval results remained identical to the initial observation; this fix does not improve name selection. A failing count regression passed after the change, graph count storage was checked through its public interface, and all 553 tests plus typecheck/build and compiled stdio smoke passed locally. Existing stored counts are not migrated; the correction applies to newly indexed or re-indexed documents.
