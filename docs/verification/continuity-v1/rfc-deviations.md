# Memex Continuity v1 RFC deviation record

This file records as-built choices and runtime compatibility differences. It does not amend the Final RFC. Empty or informational records do not relax an invariant.

## D-000 — Baseline document placement

- RFC section/invariant: §22 Phase 0 / RFC lock
- Actual choice: preserve the supplied source at `docs/Memex Continuity Architecture v1 - FINAL RFC.md` and keep the byte-identical locked repository copy at `docs/architecture/memex-continuity-v1.md`.
- Reason: the supplied source is already inside the repository; a conventional architecture path gives later owner documentation a stable target without deleting or renaming user input.
- Alternatives considered: lock only the supplied path; move the supplied file.
- Invariant evidence: both files hashed to `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a` and `cmp` returned success on 2026-09-03.
- Reversal condition/trade-off: consolidate paths only through an explicit RFC amendment; duplication requires hash checking at every phase.

## D-001 — Installed hook contract is newer than repository comments

- RFC section/invariant: §2, §6.8, HOOK BOUNDARY, POSTCOMPACT INDEPENDENCE
- Actual choice: Phase 0 treats Codex CLI `0.150.1` and the current official Hooks page as the compatibility target. Existing comments that say `0.149`/`0.149.1` are historical, not runtime authority.
- Reason: installed runtime and official release documentation outrank RFC examples and comments.
- Alternatives considered: retain `0.149.1` as the target; infer contracts from current scripts only.
- Invariant evidence: official contract currently includes `SessionStart` sources `startup|resume|clear|compact`, compaction triggers `manual|auto`, `Stop`, `Interrupt`, `PreCompact`, `PostCompact`, and synchronous `SessionEnd`. Phase 2 must implement event-specific compatibility fixtures.
- Reversal condition/trade-off: refresh the record when the supported minimum/runtime matrix is deliberately changed.

## D-002 — Existing database has no explicit global schema version

- RFC section/invariant: §17 data model; Phase 1 migration/compatibility
- Actual choice: current schema is additive initialization in `src/db.ts`; `PRAGMA user_version` is `0`. Phase 1 must introduce an explicit continuity schema/migration version without rewriting existing durable tables.
- Reason: current repository state is authoritative; claiming a version that is not persisted would be false.
- Alternatives considered: treat package `0.3.0` or sync protocol `4` as database schema version.
- Invariant evidence: a fresh Phase 0 database returned `PRAGMA user_version = 0`; sync protocol remains independently versioned at `4`.
- Reversal condition/trade-off: close this deviation after an additive, idempotent migration version is implemented and verified against a released fixture.

Phase 1 resolution: Continuity schema version `1` is now recorded in both `PRAGMA user_version` and
`continuity_schema_meta`. The additive transaction and released-shape fixture preserve exchange rowid and
survive injected interruption plus repeated startup. This closes the missing-version implementation gap;
the historical Phase 0 observation remains in this record.

## D-003 — Sandbox Unix socket limitation

- RFC section/invariant: Phase 0 baseline verification only
- Actual choice: preserve the sandbox run (`92/93`, `listen EPERM`) and the exact isolated rerun outside the sandbox (`1/1 PASS`) as separate evidence.
- Reason: managed sandbox denies Unix socket listen under `/tmp`; the same product test passes outside it.
- Alternatives considered: label the slice suite a product failure; omit the failed run.
- Invariant evidence: `node --test test/inject-daemon-slice.test.mjs` passed outside the sandbox on 2026-09-03.
- Reversal condition/trade-off: none; later mandatory socket suites must use an execution environment that permits Unix sockets.

## D-004 — Phase 0 benchmark fixture respects relation scope

- RFC section/invariant: §10 scope; Phase 0 baseline benchmark
- Actual choice: the synthetic benchmark still creates 50 facts across 7 projects and 49 relations, but a relation between adjacent different-project facts uses the most recent global fact as its source endpoint.
- Reason: the old fixture generated forbidden direct cross-project ontology edges and failed before measuring anything; product code correctly rejected them.
- Alternatives considered: weaken the relation invariant; collapse the benchmark to one project; reduce relation count.
- Invariant evidence: only `scripts/benchmark.mjs` fixture construction changed. The exact 200-rollout/30-query benchmark passed outside the managed sandbox and produced 50 nodes and 49 edges.
- Reversal condition/trade-off: replace with a richer scope-valid corpus when Phase 5 builds the Continuity-specific calibration harness.

## D-005 — Phase 1 extraction uses rowid fence plus immutable generation items

- RFC section/invariant: §8.1–8.3, EXACT EXTRACTION, NO SAMPLING LOSS, OPEN TURN
- Actual choice: Phase 1 keeps the transitional `from_rowid/through_rowid` fence, but snapshots every target as ordered `(exchange_id, rowid, content_generation, content_hash)` items and advances a target ordinal cursor.
- Reason: the existing durable index is rowid-based. Ordered target items add generation-aware reprocessing without rewriting exchange rows or prematurely introducing Phase 3 identity.
- Alternatives considered: reset a session rowid watermark when an old exchange grows; migrate immediately to checkpoint sequence as the sole cursor.
- Invariant evidence: concurrent insert stays outside the fixed target, a grown generation fails stale commit, and a deterministic-seed 37-item drain covers ordinals `1..37` exactly.
- Reversal condition/trade-off: Phase 2 checkpoint ingestion may use closed exchange sequence as its native fence; rowid remains a compatibility cursor until a verified staged migration removes it.

## D-006 — Phase 1 parser closure is conservative but lifecycle-final typing is deferred

- RFC section/invariant: §8.3, OPEN TURN; Phase 1/2 boundary
- Actual choice: parser version 2 marks exchanges closed when a later user turn proves the boundary, marks an EOF exchange with an unfinished tool call interrupted, and otherwise emits closed. `final` remains available in schema/API but is assigned by later lifecycle checkpoint context.
- Reason: Phase 1 may change parser/schema but must not register Stop, Interrupt, PreCompact, or SessionEnd final-fence hooks. Raw EOF alone cannot distinguish completed Stop from every interruption shape under the unstable transcript contract.
- Alternatives considered: mark every EOF exchange open, which would starve normal completed final turns; infer `final` from archive filename or process timing.
- Invariant evidence: open/interrupted rows block the closed target fence; any later content/tool-tail change increments generation; commit validates current hash/generation/closure.
- Reversal condition/trade-off: Phase 2 must normalize official hook payloads and assign event-grounded interrupted/final closure. Until then, completed assistant-only EOF and an interrupted assistant-only EOF can be indistinguishable; generation CAS prevents stale overwrite but event-level closure is not yet fully proven.

## D-007 — Legacy extraction markers are compatibility hints, not completion authority

- RFC section/invariant: §8.1–8.3, §19–20; EXACT EXTRACTION, ACCOUNTABILITY, NO SILENT LOSS
- Actual choice: production Continuity scheduling trusts only the current `(exchange_id, content_generation, policy_version)` processed state. Legacy `SEED`, `PERMANENT`, success markers and `last_exchange_rowid` remain reporting/legacy-reader compatibility data but cannot suppress a missing generation. Read-only legacy databases without Continuity tables retain the old query mode until migration.
- Reason: the released extractor spread-sampled windows, stopped at a fact cap, dropped deterministic failures, and seeded live `MAX(rowid)` from the existence of one fact. None of those markers proves exact presentation.
- Alternatives considered: backfill every row below legacy watermarks as processed; trust only non-negative markers; preserve `PERMANENT` as terminal.
- Invariant evidence: `test/backfill-seed-watermark.test.ts` proves both `SEED` and `PERMANENT` sessions remain pending and target all unseen generations; an open row below a legacy live-MAX fence still blocks later closed rows.
- Reversal condition/trade-off: the compatibility columns/query mode may be removed only after a versioned migration and support-window decision. Reprocessing can spend additional model work, but silent loss is not accepted.

## D-008 — Obsolete extraction generations use `superseded`, not failed-visible

- RFC section/invariant: §8.3, §16, §19; OPEN TURN, ACCOUNTABILITY, PRIVACY
- Actual choice: if an exchange grows, changes closure/hash, or is canonically deleted during async extraction, the owned target/job/checkpoint and unprocessed items become `superseded`; no failure range is emitted. Target item exchange identity is intentionally non-FK so deletion remains observable until stale CAS handling; privacy purge deletes the target before the source in the same transaction.
- Reason: an obsolete source generation is neither successfully processed nor an irreducible failure. FK cascade previously erased the immutable identity before the worker could distinguish staleness from an internal error.
- Alternatives considered: classify every stale result as failed-visible; let exchange deletion cascade the target item; keep stale target retrying forever.
- Invariant evidence: growth and canonical-delete-during-model tests commit zero facts/cursor, retire the target as superseded, emit no failed range, and retarget the current generation; queued privacy purge leaves zero Continuity/source rows.
- Reversal condition/trade-off: Phase 2 may replace row identity with journal/checkpoint-native identity, but stale work must remain explicitly accounted and purge-atomic.

## D-009 — PostCompact is registered as telemetry-only compatibility surface

- RFC section/invariant: §6.2; POSTCOMPACT INDEPENDENCE
- Actual choice: Codex CLI `0.150.1` exposes `PreCompact` and `PostCompact` with `manual|auto` matchers, so Memex registers both. `PostCompact` records only the privacy-safe hook event and may wake an already-durable queue; it performs no epoch, checkpoint, residency, or completion transition.
- Reason: registration gives operational visibility without making correctness depend on event delivery. Required state is committed by `PreCompact` and idempotently ensured by `SessionStart(compact)`.
- Alternatives considered: omit PostCompact entirely; use it as the epoch commit point.
- Invariant evidence: the 200-turn adversarial fixture executes six auto and two manual compact cycles with zero PostCompact calls and preserves all bytes, eight epoch transitions, and immediate context.
- Reversal condition/trade-off: PostCompact registration may be removed if the supported runtime drops it; no correctness code must change.

## D-010 — Capture indexing and Capsule work share the Phase 1 durable queue

- RFC section/invariant: §7, §9, §14; CAPTURE, OUTBOX, RECOVERY, CAPSULE TYPING
- Actual choice: Phase 2 extends `checkpoints`/`memory_jobs` rather than creating a second queue. Every capture prefix gets P0 `capture_index`; P1 `capsule_update` is coalesced at six Stop/Interrupt boundaries, accumulated 8 KiB, PreCompact, or SessionEnd. Workstream partitions serialize Capsule generations while session partitions serialize prefix indexing.
- Reason: the Phase 1 queue already provides atomic outbox insertion, leases, retries, ordinal ordering, and privacy cascade. Reuse avoids a competing completion authority.
- Alternatives considered: one Capsule model call per turn; a separate filesystem queue; merging Capsule and fact extraction.
- Invariant evidence: 200-turn benchmark observed 200 checkpoints, one threshold Capsule job, byte amplification `1.0`, and zero gaps; crash/hash/CAS tests keep failed work retryable.
- Reversal condition/trade-off: thresholds are deliberately fixed and few in Phase 2; Phase 5 may tune them only with measured product evidence.

## D-011 — Legacy SessionEnd executable is a thin final-fence alias

- RFC section/invariant: §6.7–6.8; HOOK BOUNDARY
- Actual choice: plugin registration uses `scripts/continuity-hook.js`; the packaged `scripts/session-end-hook.js` name remains as a compatibility alias importing the same gateway. Its old stabilize → extract → consolidate → export chain is unreachable.
- Reason: external installations or tests may still invoke the public executable name during the support window, while foreground heavy work violates the final architecture.
- Alternatives considered: delete the old executable immediately; keep its old behavior outside plugin registration.
- Invariant evidence: process tests assert silent stdout/stderr, final checkpoint plus two durable jobs, duplicate same effect, no sync export directory, and no model/embedding call in the hook process.
- Reversal condition/trade-off: remove the alias in a future breaking release after installed callers are migrated.

## D-012 — Rewrite detection uses mtime plus a bounded copied-prefix guard

- RFC section/invariant: §7.1; CAPTURE
- Actual choice: `journal_streams` schema v3 records `source_mtime_ms` plus the SHA-256 and start offset of at most 4KiB immediately before `copied_byte_end`. A same-size mtime rewrite or a rewrite that changes the copied prefix and then grows the file starts a new stream epoch. Capture revalidates source identity/size/mtime before journal append.
- Reason: truncate/replace can reuse an inode, preserve byte length, or grow after rewriting existing bytes; inode/size and same-size mtime alone can silently create a hybrid journal.
- Alternatives considered: full-prefix rehash on every hook, which reintroduces quadratic I/O; trust inode and size only; treat every normal append mtime change as replacement.
- Invariant evidence: same-size and growing-rewrite regressions preserve the old journal and write the replacement to epoch `N+1`; competing hook processes are serialized before file append; Phase 1 schema upgrades additively and an interrupted guard-column migration rolls back.
- Reversal condition/trade-off: a future runtime-provided immutable transcript identity may replace the mtime compatibility guard.

## D-013 — Materialized plugin execution is pinned to the installed artifact

- RFC section/invariant: §2, §6.8, §19 HOOK BOUNDARY
- Actual choice: `cli/runtime-exec.js` executes the locally installed binary whenever production dependencies have been materialized beside the plugin. The `npx github:BongSuCHOI/memex#main` path remains only as a compatibility fallback for an incomplete raw plugin registration.
- Reason: Phase 2B observed that authenticated hooks from an installed `0.3.0` artifact actually launched the moving remote `main`, including behavior/output different from the candidate under test. It also placed package-manager and network work inside every foreground capture boundary.
- Alternatives considered: keep moving `main` for every invocation; bypass `runtime-exec.js` only for Continuity hooks; vendor a second runtime package.
- Invariant evidence: the local-runtime process test proves stdin/arguments reach the installed Continuity script without invoking `npx`; plugin-only authenticated lifecycle E2E then observed exact-once UserPromptSubmit/Stop/SessionEnd delivery, additionalContext, a 577 ms final fence, deferred Luna Capsule generation 1, and immediate compact rehydration.
- Reversal condition/trade-off: remove the remote fallback after Codex plugin installation itself guarantees dependency materialization. Until then, raw `codex plugin add` without the Memex installer is compatible but does not have the same pinned/offline guarantee.
