# Phase 0 — Baseline & RFC Lock

Status: `PHASE 0 AUDIT: COMPLETE`

## Repository and environment

| Item | Observed value |
| --- | --- |
| Baseline branch | `main` |
| Baseline HEAD | `c790480b3d2406d415643d0781fb2977e0d163b0` (`v0.3.0`) |
| Work branch | `feat/memex-continuity-v1` |
| Initial user-owned working tree | deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md`; untracked supplied RFC and Worker Prompt Pack |
| Preservation | no reset, clean, checkout overwrite, or stash; the unrelated deletion remains unstaged |
| OS | macOS 26.6.2 (25G83), Darwin arm64 |
| Node/npm | Node `v26.0.0`; npm `11.12.1` |
| SQLite | `3.51.0` |
| Codex | `codex-cli 0.150.1`; `hooks` feature stable/enabled |
| Memex | repository/package/plugin `0.3.0`; installed `memex@memex` `0.3.0` enabled |
| Sync protocol | v4 |
| DB schema version | no explicit global version; `PRAGMA user_version = 0` |

## RFC lock

- Source: `docs/Memex Continuity Architecture v1 - FINAL RFC.md`
- Locked copy: `docs/architecture/memex-continuity-v1.md`
- SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Amendment rule: explicit user approval plus recorded amendment. Every Phase and B gate reopens both source documents, latest handoff, traceability matrix, and deviation record, then re-hashes the locked RFC.

## Verified Codex hook contract

Authority: installed `codex-cli 0.150.1` plus the official OpenAI Hooks documentation fetched 2026-09-03.

| Event | Matcher/input | Output/timeout/lifecycle |
| --- | --- | --- |
| `SessionStart` | matcher filters `source`: `startup`, `resume`, `clear`, `compact` | plain stdout or JSON additional context; `compact` runs before the immediate next model request |
| `UserPromptSubmit` | matcher ignored; `turn_id`, `prompt`, common fields | plain stdout or JSON additional context; can block |
| `Stop` | matcher ignored; `turn_id`, `stop_hook_active`, `last_assistant_message` | exit-0 output must be JSON or empty; plain text invalid; continuation decision exists but is not needed for capture |
| `Interrupt` | matcher ignored; `turn_id`, `permission_mode` | empty output or JSON `systemMessage`; plain text invalid; default 1s, configured 1–3s; cannot restart/block interruption |
| `PreCompact` / `PostCompact` | matcher filters `trigger`: `manual|auto`; `turn_id` | plain stdout ignored; JSON common output; correctness must not depend on PostCompact |
| `SessionEnd` | matcher filters `reason`, currently `other` | always synchronous, advisory, cannot keep thread open; default 1s and maximum 3s |

Common fields include `session_id`, nullable `transcript_path`, `cwd`, `hook_event_name`, `model`; many turn hooks add `permission_mode`. Transcript format is explicitly unstable. Most command hooks default to 600s, but `SessionEnd` and `Interrupt` default to 1s and cap at 3s. Matching hooks launch concurrently. Background hooks can finish out of order, are capped at eight per session, and unfinished background output is discarded when a session ends. Default visible-output spill threshold is about 2,500 tokens; `additionalContextLimit` is per handler.

## Current lifecycle sequence

```text
SessionStart(any source; empty matcher)
  -> four independent background hooks:
     version drift, full sync --background, sync import, maintenance
  -> maintenance may spawn consolidation, vector, ontology, extraction workers

UserPromptSubmit(any prompt)
  -> synchronous inject hook
  -> prompts shorter than 20 chars skip
  -> otherwise embedding + baseline + fact vector search + unconditional 1-hop expansion
  -> fact-ID-only session ledger dedup

SessionEnd(reason other)
  -> synchronous transcript stabilization up to 30s
  -> foreground fact extraction up to 600s
  -> foreground sync export up to 120s
```

Current plugin registration has only `SessionStart`, `UserPromptSubmit`, and `SessionEnd`. `Stop`, `Interrupt`, `PreCompact`, and `PostCompact` are absent. Empty `SessionStart` matcher also runs startup maintenance for `compact` and `clear`. This conflicts with current runtime timeout rules for `SessionEnd` and makes heavy finalization cancellation/failure likely.

## Current data flow

### Capture/index

`$CODEX_HOME/sessions` rollouts are discovered recursively. Session metadata `cwd` is canonicalized lexically and used as project identity. Source rollouts are copied atomically to a project-keyed archive, parsed, desired-set reconciled, embedded, and upserted through `src/archive-ingestion.ts`. The archive path is a snapshot boundary, but there is no rolling journal, checkpoint prefix/hash, capture gap, or durable outbox.

`reconcileArchiveExchanges()` is a canonical desired-set reconciliation: it can rename and delete rows missing from the latest full parse. It is not safe as a monotonic prefix-ingestion primitive. `insertExchange()` preserves the row for a stable exchange ID, but blindly replaces `line_end` and content without generation or shorter-prefix guards.

### Exchange schema/parser

`exchanges` has stable UUID `id`, SQLite `rowid`, `line_start`, `line_end`, provenance, recall taint, and session/path metadata. It lacks `exchange_seq`, `content_hash`, `content_generation`, `closure_state`, and `parser_version`. A growing turn can update an existing ID while keeping `rowid`; extraction is rowid-watermark based and therefore does not guarantee reprocessing.

### Extraction

`runFactExtraction()` claims per session using `extraction_log`, renews a 30-minute lease, and commits facts plus a completion marker transactionally. Existing semantic and lifecycle fact CAS, authority validation, source lineage, and privacy boundaries are substantial strengths.

Critical current mechanics:

1. Claim does not persist a fixed upper target.
2. Query is `rowid > last_exchange_rowid` with no `rowid <= through_rowid` fence.
3. Semantic windows are spread-sampled to at most 12.
4. Fact accumulation stops at 20 facts.
5. Deterministic failed windows increment `dropped_batches` but processing continues.
6. Completion re-reads live `MAX(rowid)` and writes it to `last_exchange_rowid`.

Therefore concurrently inserted rows, unselected windows, post-cap suffixes, and deterministic failed windows can all be covered by the final watermark despite not being presented successfully to the extractor. This contradicts EXACT EXTRACTION, NO SAMPLING LOSS, ACCOUNTABILITY, and NO SILENT LOSS.

`extraction_log` has session-level state, owner, retry count reuse, dropped-batch count, and watermark. It lacks immutable targets, page cursors, exact failed ranges/fingerprints, job states, lease tokens/epochs, and dead-visible accounting that cannot be mistaken for completion.

### Facts/derived state

Facts already separate semantic and lifecycle generations/timestamps, retain authoritative `source_exchange_ids`, keep interpretive `fact_context_dependencies` local, reject assistant/recall authority, use CAS across model/embedding awaits, and sync semantic/lifecycle axes independently. Ontology, relations, KR translation, and vectors are derived/local. These foundations must be preserved.

### Injection/continuity

`computeInjectContext()` always initializes embeddings for eligible prompts, embeds once, searches facts, expands graph relations, and optionally searches repeat history. Dedup is fact ID only, not semantic/lifecycle revision or context epoch. There is no session memory state, correction semantics, or compact rehydration.

`getLastSessionContext()` selects the most recent session for a path project and formats the last user request plus assistant summary. It has no workstream binding and treats assistant synthesis as continuity text. It is not currently registered at SessionStart, but its policy would contaminate parallel workstreams if promoted.

### Scope/sync/MCP/privacy

Project identity is canonical absolute `session_meta.cwd`; path is identity, not location. Same-basename isolation and explicit MCP `project|global|all` scope are already enforced. MCP exposes nine tools including `trace_fact`, but no stable project/workspace/workstream entities or Chronicle pagination.

Sync protocol v4 atomically exports only facts, revisions, tombstones, recall events, and meta; local derived ontology/vectors are excluded. Import validates complete generation manifests and applies semantic/lifecycle conflict rules. Phase 3 must migrate identity without weakening v4 behavior.

Conversation exclusion reads user-role markers, purges indexed conversation/fact dependencies, and tombstones fact deletion. Current purge cannot cover journals, checkpoints, capsules, hot evidence, Chronicle events, or new jobs because they do not exist yet.

## Invariant gap summary

| Status | Invariants |
| --- | --- |
| Already satisfied in current covered paths | AUTHORITY (fact extraction), semantic/lifecycle CAS basis, existing scope enforcement for path projects, protocol-v4 generation integrity |
| Partially satisfied | MONOTONIC INGESTION, OPEN TURN, OUTBOX, RECOVERY, MCP ACCESS, PRIVACY, SCOPE |
| Missing | CAPTURE, ACCOUNTABILITY, CAPSULE TYPING, CURRENT VS HISTORY, GROUNDED CAUSE Chronicle boundary, TEMPORAL ORDER, RESIDENCY, REVISION-AWARE INJECTION, BRANCH TRUTH, POSTCOMPACT INDEPENDENCE |
| Contradicted | EXACT EXTRACTION, NO SAMPLING LOSS, HOOK BOUNDARY, NO SILENT LOSS |
| Requires later runtime/E2E proof | compact immediate rehydration, long-session accounting, cross-workstream leakage, purge resurrection prevention |

The complete per-invariant mapping is in `traceability-matrix.md`.

## Highest-risk problems

1. Silent extraction loss: live completion watermark can cross unseen concurrent/sampled/capped/failed rows.
2. No durable processing accountability: session marker cannot represent exact target/page/failure ranges.
3. Heavy synchronous SessionEnd exceeds the runtime's supported 1–3 second contract by orders of magnitude.
4. No capture boundaries before Stop/interrupt/compact; session loss and compaction recovery are unaccounted.
5. Path identity and latest-session continuity cannot safely represent worktrees, clones, devices, or parallel workstreams.
6. Fact-ID-only injection ledger suppresses corrected generations and survives no context epoch model.
7. Current fact changes have revisions but no sparse grounded Chronicle, temporal event semantics, or incident provenance.

## Phase 1 dependency-ordered implementation map

1. Add additive versioned schema for exchange content generation/closure, extraction targets/pages/failures, checkpoints, and `memory_jobs`.
2. Backfill exchange hash/generation/closure conservatively without changing rowid or authoritative provenance.
3. Split canonical archive reconciliation from monotonic prefix upsert; enforce generation/line guards in SQL/API.
4. Replace session-live extraction with an immutable `(from, through]` target and contiguous durable pages.
5. Reinterpret window/fact limits as per-run budgets; leave suffix pending.
6. Record transient, split, retry, and irreducible exact failed ranges without marking target complete.
7. Atomically commit fact/current mutations with page cursor/state under lease ownership; reject stale owners/generations.
8. Add checkpoint+job transactional outbox, idempotency, lease reclaim, retry/backoff/dead-visible states.
9. Add migration crash/re-run fixtures plus concurrent insert/update, out-of-order prefix, and deterministic-seed property tests.
10. Update schema/fact lifecycle/architecture/verification owner docs. Do not add Phase 2 lifecycle registration yet.

Candidate owners: `src/db.ts`, `src/fact-extractor.ts`, `src/pending-extraction.ts`, `src/archive-ingestion.ts`, `src/indexer.ts`, `src/types.ts`, new narrowly scoped checkpoint/job/extraction-progress modules, and focused tests.

## Temporary designs forbidden before later phases

- no stable project/workspace migration in Phase 1
- no lifecycle event expansion, rolling journal, compact rehydration, Capsule, or adaptive recall in Phase 1
- no turn-ID-only checkpoint identity
- no session-level completion marker that hides pending pages
- no canonical reconciliation reuse for partial prefixes
- no path-to-project UUID compatibility shortcut that silently merges clones
- no assistant/Capsule evidence promotion
- no PostCompact correctness dependency
- no branch-scoped full knowledge graph or external broker/CRDT

## Baseline verification

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `npm test` | PASS — 70 files / 691 tests |
| `node --test test/codex-slice.test.mjs` | PASS — 24/24, skipped 0 |
| `node --test test/*slice.test.mjs` in managed sandbox | 92/93; one `listen EPERM` for inject-daemon Unix socket |
| `node --test test/inject-daemon-slice.test.mjs` outside sandbox | PASS — 1/1, skipped 0 |
| `node scripts/benchmark-contract.mjs` | PASS (existing receipt schema validates) |
| `node scripts/benchmark.mjs --rollouts 200 --queries 30` | initial product-validity failure: fixture created forbidden cross-project edges; after fixture-only repair, managed sandbox hit `EMFILE`; exact outside-sandbox run PASS and refreshed `docs/verification/benchmark.json` |

No tests are statically disabled with `.skip`/`.only`. Existing receipt at `docs/verification/merge-gate.json` records v0.3.0 release evidence but does not prove Continuity v1.

## Blockers and uncertainties

- Full live Codex event replay was not performed in Phase 0; event contracts are official/current documentation plus repository fixtures. Phase 2 must add and run installed-runtime fixtures.
- Transcript format is officially unstable; Phase 2 parser versioning and replacement handling are mandatory.
- No released DB fixture is currently identified as a formal migration fixture. Phase 1 must construct one from the v0.3.0 schema and verify repeated/interrupted upgrade.
- Product A/B continuity calibration belongs to Phase 5; current benchmark measures pre-continuity search/injection performance only.
- The managed sandbox benchmark cannot currently prove browser/watch behavior because it hit `EMFILE`; the exact outside-sandbox run is the current PASS evidence.
