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

Phase 3 verification ran on Codex CLI `0.153.2`. The registered lifecycle matcher/output contract remained
compatible in offline/install/marketplace/package tests; the formal `codex plugin validate` subcommand is
still unavailable, so the version-bound installed-artifact substitute receipt remains explicit.

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

## D-014 — Local Git inode identity supplements workspace rename detection

- RFC section/invariant: §10.2–10.3, SCOPE; Phase 3 path move/rename acceptance
- Actual choice: `workspaces` stores device-local `git_common_identity` and `git_dir_identity` (`dev:ino`) beside canonical path and Git common-dir. A unique Git-dir identity may update the same workspace row after a local checkout rename; worktrees still share the logical project by common-dir and retain distinct workspace IDs.
- Reason: a renamed checkout changes both cwd and textual `.git` path, while the underlying Git directory inode remains the same on the device. Canonical path alone would split one local workspace identity.
- Alternatives considered: hash basename/remote/package; treat every moved path as a new workspace; shell out to Git for every resolve.
- Invariant evidence: resolver tests cover checkout rename, checkout plus worktree, same-remote clone isolation, explicit link/split, and no-remote directories. Inode fields and all paths remain local metadata and are excluded from sync.
- Reversal condition/trade-off: replace the inode hint if the supported runtime supplies a durable local checkout identifier. Copying a repository to another filesystem does not preserve inode identity and still requires portable/explicit linking.

## D-015 — Stable project identity is an additive protocol-v4 row shape

- RFC section/invariant: §10.2–10.3, §17, Phase 3 sync compatibility; SCOPE, PRIVACY, NO SILENT LOSS
- Actual choice: protocol number and the five exact durable files remain v4, while project fact/recall rows add stable `project_id`, optional `portable_project_key`, `subject_key`, and `promotion_state`; device path fields are serialized as null. Import accepts both released path-bearing v4 rows and the new path-free stable shape.
- Reason: changing the protocol number or adding a sixth durable file would violate the repository-wide protocol-v4 contract. Stable identity can be introduced with strict additive row validation while retaining old-generation import.
- Alternatives considered: protocol v5; sync workspace paths; silently synthesize a remote path; duplicate portable mapping in a new file.
- Invariant evidence: cross-device tests map one portable key onto a differently located local workspace, assert source paths are absent from the wire, replay idempotently, and reject conflicting stable ID/key combinations before partial mutation.
- Reversal condition/trade-off: an older v4 peer that does not know the additive fields/path-free shape rejects the complete generation visibly rather than importing it partially. A future coordinated breaking protocol may make the stable fields mandatory under a new version.

## D-016 — Legacy path queries remain a read-only compatibility surface

- RFC section/invariant: §10, §13, Phase 3 migration/MCP compatibility; SCOPE, MCP ACCESS
- Actual choice: path columns remain local provenance and released path query APIs remain supported during the compatibility window. Every project-sensitive fact/ontology/avatar/graph MCP surface now accepts explicit stable project/workspace/workstream/session scope. Unknown compatibility paths are queried without creating project/workspace rows, while stable relation expansion filters both endpoints at every hop.
- Reason: removing path readers in the same additive migration would break released callers, but deferring stable scope on ontology/avatar/graph would leave Phase 3 workstream isolation incomplete. A read-only lookup must honor MCP `readOnlyHint` and cannot create identity state merely because a caller searched an unknown path.
- Alternatives considered: delete path fields immediately; keep ontology/avatar/graph path-only until Phase 4; resolve every MCP path by creating identity rows; infer MCP scope from process cwd.
- Invariant evidence: migration keeps canonical path lookups functional; MCP tests cover stable membership on all public surfaces, path-free ontology/avatar facts, workstream relation isolation, graph counts, mixed-ID rejection, raw other-session evidence, and zero identity-row mutation for an unregistered path.
- Reversal condition/trade-off: remove legacy path readers only in a documented breaking migration after released callers have migrated. Phase 4 extends history/source depth but does not own or defer Phase 3 stable scope.

## D-017 — B gates run by a Claude general-purpose subagent

- RFC section/invariant: Worker Prompt Pack gate execution rules (not an RFC invariant)
- Actual choice: from Phase 4 onward the implementation is driven from Claude Code. The Codex custom agent `memex_gate_reviewer` (`gpt-5.6-sol`, reasoning effort high) cannot be spawned from this runtime, so each B gate is delegated to exactly one Claude `general-purpose` subagent that receives the same developer instructions (`~/.codex/agents/memex-gate-reviewer.toml`), the Final RFC, the B prompt, the latest handoff, the traceability matrix and this record, and is allowed to fix defects directly.
- Reason: the user approved adapting the gate runner to the available runtime on 2026-09-04 while keeping the one-gate-one-independent-reviewer rule.
- Alternatives considered: return every B gate to Codex; run the gate in the implementing session.
- Invariant evidence: the parent session does not edit gate-owned files while the subagent runs and advances only on `PASS`.
- Reversal condition/trade-off: if the work returns to Codex, the original agent definition applies unchanged.

## D-018 — Chronicle is the extended `fact_revisions` table

- RFC section/invariant: §4.4, §15, §17 (`fact_events / extended fact_revisions`); CURRENT VS HISTORY
- Actual choice: the released `fact_revisions` table is rebuilt in place (schema v5) with nullable `fact_id`/`previous_fact`/`new_fact` and the RFC event columns added additively. Released revision rows keep their ids and are backfilled as `CHANGED`/`actor=legacy` events whose free-text reason becomes `classifier_note`. No parallel `fact_events` table exists. The sync file name `fact-revisions.jsonl` and protocol number `4` are unchanged; rows carry the additive event shape.
- Reason: RFC §17 permits either shape and the Prompt Pack forbids a duplicate history system; one table keeps legacy readers, sync and purge on a single path.
- Alternatives considered: a new `fact_events` table beside `fact_revisions`; protocol v5.
- Invariant evidence: `test/continuity-chronicle.test.ts` legacy migration case, `test/continuity-correctness-spine.test.ts` crash-injected stages `chronicle-table`/`chronicle-backfill`/`incident-tables`/`telemetry-table`/`chronicle-indexes`, `test/fk-enforcement.test.ts` orphan detection.
- Reversal condition/trade-off: an older peer that does not know the event shape rejects the whole generation visibly (same posture as D-015); device-local generation numbers are dropped on the wire.

## D-019 — Event tombstones travel inside `fact-tombstones.jsonl`

- RFC section/invariant: §9 sync, §20 purge; PRIVACY, NO SILENT LOSS
- Actual choice: purged Chronicle event ids are exported as `{fact_id: null, event_id, deleted_at, reason}` rows in the existing five-file v4 generation and stored locally in `chronicle_tombstones`. Import treats them as terminal, deletes the local event/occurrence and refuses later replays of the id.
- Reason: a sixth durable file or a new protocol number would break the repository-wide five-file v4 contract; a tombstone row shape is additive.
- Alternatives considered: no event tombstones (a peer replay could resurrect purged history); a separate file.
- Invariant evidence: `test/continuity-chronicle.test.ts` purge case (three event tombstones, zero rows, re-record rejected) and `insertReplicatedChronicleEvent` returning `tombstoned`.
- Reversal condition/trade-off: a released peer rejects a generation that contains the new tombstone shape visibly.

## D-020 — Legacy facts keep per-fact subject keys; semantic slots are extractor/user assigned

- RFC section/invariant: §4.3 subject key completion; Phase 4 "deterministic and rerunnable subject migration"
- Actual choice: migration never infers semantic subjects for released facts (no LLM in migration). Rows keep the Phase 3 per-fact keys (`legacy.fact.<id>`, `<promotion>.fact.<id>`), which are not semantic slots, so slot resolution (merge/CHANGED/historical/CONTRADICTED) applies only to keys matching the grammar `^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$`. Semantic slots are assigned by the extractor contract (validated by grammar and category prefix) or explicitly via `assignFactSubject`.
- Reason: a deterministic, rerunnable backfill cannot invent meaning; an ambiguous slot must remain unresolved rather than force a current overwrite.
- Alternatives considered: LLM-driven subject backfill at migration; text-hash subjects.
- Invariant evidence: subject grammar tests and the merged-rephrasing case in `test/continuity-chronicle.test.ts`.
- Reversal condition/trade-off: released facts without semantic slots still consolidate through the LLM consolidator path, whose verdicts now pass the same temporal judge.

## D-021 — Unknown existing effective time is un-ordered, not "newer"

- RFC section/invariant: §16 temporal semantics; TEMPORAL ORDER
- Actual choice: `currentEffectiveAt()` returns null when a fact has neither a projection event nor a resolvable source exchange. The judge then applies incoming evidence (as the released consolidator did) instead of comparing a local write time against real evidence time. Ties and lower-authority newer evidence still become `CONTRADICTED` candidates.
- Reason: a local `semantic_updated_at` is a recorded clock; treating it as evidence time made genuinely older sources look newer than facts created seconds earlier.
- Alternatives considered: compare against `semantic_updated_at`; always contradict when unknown.
- Invariant evidence: `test/recall-provenance.test.ts` trusted-repo evolution and `test/consolidator.test.ts` fallback cases pass under the rule; out-of-order source evidence still yields a historical event (`test/continuity-chronicle.test.ts` case i).
- Reversal condition/trade-off: facts predating the Chronicle whose sources were purged cannot be temporally ordered; their next evidenced change becomes the first ordered event.

## D-022 — Replicated Chronicle grounded fields are trusted as delivered, behind a structural guard

- RFC section/invariant: §4.4 grounded cause rule, §13 sync; GROUNDED CAUSE, PRIVACY
- Actual choice: sync does not carry exchanges, so an importing device cannot re-verify a peer event's `problem`/`grounded_cause`/`rationale` against the cited source text. Peer rows keep those fields as delivered because the exporting device verified them at write time with the same fail-closed `verifyGroundedField` path, and the row is marked `effective_at_source = 'peer'` with its original `actor`/`evidence_authority`. Phase 4B added the structural invariant that makes this sound: `recordChronicleEvent` always adds the exchange cited by a grounded field to the event's `source_exchange_ids`, and the importer's row validator rejects (whole generation, the repository's schema-invalid posture) any event row that has `problem`/`grounded_cause` without cited sources, a `rationale` without sources from an actor other than `user`, or `projection_applied = 1` without a `fact_id`.
- Reason: importing grounded fields as classifier notes would silently downgrade verified history on every device but the origin; re-verification is impossible without the source; a structural guard closes the only shape a non-Memex writer could produce cheaply.
- Alternatives considered: downgrade peer grounded fields to `classifier_note`; sync exchanges; ignore the shape entirely.
- Invariant evidence: `test/continuity-chronicle-gate.test.ts` two-database matrix (grounded cause and classifier note preserved with `peer` marking; ungrounded peer row rejects its generation; source shown as `source unavailable (purged or missing)` on the peer) and the grounded-source union case.
- Reversal condition/trade-off: if a future protocol ships source excerpts, import may re-verify spans locally. A peer that deliberately forges a grounded field with a fake exchange id is not detectable by structure alone; it is still labeled `peer` and never `source`.

## D-023 — Chronicle timeline visibility mirrors the fact-search scope contract

- RFC section/invariant: §10.5, §13, §19; SCOPE, BRANCH TRUTH, MCP ACCESS
- Actual choice: Phase 4A filtered a workspace/workstream timeline by direct fact membership (`facts.workstream_id = ?`) or evidence membership, which excluded project-wide truth from a workstream-scoped trace and could show a sibling workstream's unmerged history from an event that cited its evidence. Phase 4B made `readChronicleTimeline` apply the same visibility rule as `factMatchesSearch`: project-wide truth (`legacy-project|decision|project-current`) is visible in every scope of its project, a `workspace`/`workstream` fact's history is visible only inside that workspace/workstream, event-only rows are visible where their cited evidence lives, and `project` scope (`projectTruthOnly`) hides unmerged workspace/workstream histories. `formatChronicleEvent` labels events on unmerged facts `scope: workstream <id> (unmerged; not project-wide truth)`. The CLI `memex facts explain` reads the full project timeline (local deep exploration) with the same label.
- Reason: MCP history must be at least as reachable as current facts under the same scope and must not widen a scope silently; deep exploration of another workstream is explicit (`scope: workstream`), never implicit.
- Alternatives considered: keep membership-only filters; show every project event under every scope with labels only.
- Invariant evidence: `test/continuity-chronicle-gate.test.ts` scope isolation case (workstream A sees project truth plus A, never B; project scope sees project truth only; session scope sees that session's evidence; label rendered) plus the Phase 4A q/r/s cases.
- Reversal condition/trade-off: an event on a project-wide fact that cites a workstream's evidence is visible in both the project and that workstream scope; incident signatures remain project-level by design (§15.4), with workstream/session provenance on each occurrence.

## D-024 — Incident duplicate delivery and out-of-order remediation

- RFC section/invariant: §15.4, §16, §20 (duplicate delivery); TEMPORAL ORDER, NO SILENT LOSS
- Actual choice: Phase 4A coalesced only same-session retries inside a 30-minute window; a null-session duplicate delivery or a replayed job created a new episode (and, because `episode_index` is part of the event content, a new event id), and a retry could coalesce into an already remediated occurrence. Phase 4B rules: a delivery whose cited exchanges are already cited by an occurrence of the same signature is a no-op regardless of session (not a retry, not an episode); same-session retries coalesce only into an `open` occurrence and merge their exchange ids; a new episode whose `effective_at` precedes the verified remediation's effective time is stored `remediated` and keeps the signature remediated; an episode after the remediation reopens the pattern and clears the remediation link.
- Reason: duplicate delivery idempotency is a Phase 4 requirement (Prompt 4A §8); worker order must not reopen or resolve a pattern (TEMPORAL ORDER); a retry of a remediated failure is a recurrence, not a retry.
- Alternatives considered: make the event id independent of the episode index; a global dedupe by signature+effective_at.
- Invariant evidence: `test/continuity-chronicle-gate.test.ts` incident cases (null-session duplicate, retry duplicate, late older episode, cross-workstream episodes) and the Phase 4A n/o/p and recurrence cases.
- Reversal condition/trade-off: two genuinely independent failures proven by the same exchange are counted once; the model must cite distinct evidence for distinct episodes.

## D-025 — Deterministic embedding stub seam for reproducible calibration

- RFC section/invariant: §21.7 reproducible workloads; Phase 5 calibration harness
- Actual choice: `MEMEX_EMBEDDING_STUB=1` replaces the embedding model with a deterministic hashed bag-of-words vector and `MEMEX_EMBEDDING_STUB=fail` simulates an unavailable model. Both are opt-in environment seams; production never sets them.
- Reason: the calibration harness and no-model test environments must measure gate behaviour without network or model downloads, and the RFC requires a reproducible workload artifact.
- Alternatives considered: record/replay real embeddings (large fixtures); skip calibration when the model is absent.
- Invariant evidence: `scripts/continuity-recall-benchmark.mjs` writes `recall-calibration.json` with the stub; all similarity thresholds are probe-baseline relative so the stub and the production model share the same rule shape.
- Reversal condition/trade-off: absolute similarity numbers on the stub are not production numbers; Prompt 5B must re-measure on the real model before tuning thresholds.

## D-026 — New sessions start at the current project memory revision

- RFC section/invariant: §11.4, §12.6; REVISION-AWARE INJECTION, RESIDENCY
- Actual choice: `bindSessionWorkstream` initialises `memory_revision_seen` to the project's current `memory_revision` instead of `0`.
- Reason: a brand-new session has no resident context to correct; starting at `0` made the first substantive prompt of every session render ordinary project facts as `[MEMEX CORRECTION]`. Sibling changes after creation still raise the revision above `seen` and force a correction at the next boundary.
- Alternatives considered: keep `0` and special-case the first injection; treat the first prompt as a correction.
- Invariant evidence: `test/continuity-recall.test.ts` (stale revision correction after a sibling update; first prompt renders `[CURRENT TRUTH]`) and the Phase 3 identity/core/adversarial suites still pass.
- Reversal condition/trade-off: none identified; a resumed session keeps its stored `seen` value.

## D-027 — Gate thresholds are few, deterministic, calibrated on the stub and spot-checked on the production model

- RFC section/invariant: §12.3; Prompt 5A "threshold는 deterministic/configurable but few defaults"
- Actual choice: `DEFAULT_RECALL_GATE_CONFIG` = ack ≤ 4 tokens, safety refresh 6 substantive prompts, drift Jaccard < 0.12 (≥ 5 tokens), coverage ≥ 8 tokens, lexical coherent Jaccard ≥ 0.35, ambiguous coherence `cos − baseline ≥ 0.08`, substantive ≥ 5 tokens. The lexical coherent skip is an as-built addition that avoids one embedding on strongly overlapping follow-ups. Phase 5B left every threshold unchanged.
- Reason: the RFC leaves numbers to calibration. On the stub workloads (365 prompts) these defaults give 0 acknowledgement embeddings, 0 stale/wrong-scope/duplicate injections, 0 mandatory-intent misses and a 61.1% retrieval reduction (`recall-calibration.json`). Phase 5B also ran the cached production model (`Xenova/multilingual-e5-small`, offline, 20 topic/prompt pairs, EN and KR): related follow-ups scored margins 0.083–0.111 (skip) or fell to lexical drift (retrieve, safe direction); every unrelated prompt retrieved (margins −0.011…0.076); the closest unrelated case ("Rewrite the deployment rollout pipeline…" against a Redis client topic) was 0.076, only 0.004 under the skip line, but such prompts (≥ 5 tokens, Jaccard < 0.12) are decided by lexical drift before any embedding. Korean short follow-ups had negative margins on the model (retrieve), so the Korean cost stays on the safe side.
- Alternatives considered: absolute cosine threshold (model dependent); no lexical coherent skip (one embedding per follow-up); raising the margin to 0.10 (would turn measured related pairs at 0.083–0.104 into retrievals without a recall benefit).
- Invariant evidence: `recall-calibration.json` verdict block; `test/continuity-recall.test.ts` cases a–x; `test/continuity-recall-gate.test.ts` case 8; the 5B handoff records the 20-pair model sample.
- Reversal condition/trade-off: any threshold change must be justified with recall and cost evidence together; lowering retrieval by dropping mandatory memory intents is forbidden. The production-model sample is small (20 pairs); a larger replay on real transcripts is Final Integration work.

## D-028 — Corrections are derived from residency, not pushed from the project scope

- RFC section/invariant: §11.4 ("다른 session의 변경을 현재 context에 강제로 push하지 않는다"), §12.4, §12.6; RESIDENCY, REVISION-AWARE INJECTION
- Actual choice: on the prompt path `[MEMEX CORRECTION]` is computed by `readResidentRevisionCorrections` from the session's resident tuples: a resident fact whose row moved to a new semantic/lifecycle generation or was deactivated is corrected on every retrieval, whether or not the prompt is about it; the Chronicle's `previous_fact` is quoted as the earlier statement when known. A stale project revision forces the pass (even on an acknowledgement, vector-free) but never-resident facts are not corrections — they reach the context only through relevance retrieval. The revision is acknowledged only once every stale resident revision has been emitted (bounded drain under the CORRECTION item cap). `buildRehydrationContext` (SessionStart resume/compact) keeps its Phase 3 scope-wide correction list.
- Reason: Phase 5A reused the rehydration renderer on the prompt path and returned early, so a stale revision (a) replaced the prompt's own recall (an explicit "why …" question received only the sibling's correction and the next prompt on that topic was skipped as coherent), (b) injected every never-resident fact in scope as a "correction", and (c) missed a resident fact that changed without a project-revision bump (workstream-promoted facts) unless it happened to be in the search results.
- Alternatives considered: keep the early return and add the prompt's recall after it (still pushes never-resident facts); bump the project revision for workstream facts (breaks BRANCH TRUTH separation).
- Invariant evidence: `test/continuity-recall-gate.test.ts` cases 2 and 6; `test/inject-write-ordering.test.ts` stale-resident correction ordering; harness `same-fact-evolution-rollback-correction` 3/3 and `same-project-same-workstream` correction on an acknowledgement.
- Reversal condition/trade-off: if a product signal shows that never-resident sibling facts must be surfaced eagerly, add them as a relevance-ranked CURRENT TRUTH candidate set, not as corrections.

## D-029 — Acknowledgements carry pending state without a vector

- RFC section/invariant: §12.3 skip candidates and recall triggers; §4.2/§24 ("새 세션을 열었다 → Capsule로 이어받는다"); HOOK BOUNDARY
- Actual choice: the gate evaluates state triggers (epoch change, Capsule generation, project revision, incident, explicit memory intent) before the acknowledgement/continuation lexicon. An acknowledgement with a pending trigger is a vector-free retrieval: no embedding, no fact search, no topic-fingerprint replacement; it renders WORK NOW, corrections, WATCH and sibling evidence only. WORK NOW itself is emitted whenever the current Capsule generation is not resident in the epoch, and an empty Capsule generation is marked resident so it cannot force retrieval on every prompt.
- Reason: with 5A's order, "계속해줘"/"continue" as the first prompt of a new session or after compaction skipped entirely, so the Capsule arrived one prompt late; a memory question as the first prompt in an epoch consumed the epoch trigger without ever rendering WORK NOW; and the first prompt after a SessionStart(compact) rehydration repeated the Capsule the rehydration had already injected.
- Alternatives considered: rehydrate on SessionStart(startup) as well (would inject the Capsule before the user's intent is known); keep acknowledgements as pure skips (loses the Capsule on the most common resume prompt).
- Invariant evidence: `test/continuity-recall-gate.test.ts` cases 1, 5 and 8; harness `compaction-heavy-200` continuation carry 4/4 with 0 acknowledgement embeddings.
- Reversal condition/trade-off: none identified; the acknowledgement path costs one SQL residency check.

## D-030 — Hot Evidence on the prompt path is sibling-only with an epoch watermark

- RFC section/invariant: §11.2 ("sibling session의 최신 결정이 아직 fact로 증류되지 않았을 때 보완"); RESIDENCY
- Actual choice: `readHotEvidence` accepts `excludeSessionId` and `afterCreatedAt`; the prompt path excludes the session's own evidence and only injects evidence indexed after `last_retrieval_at`. `advanceContextEpoch` resets `last_retrieval_at` to NULL (nothing is resident in a new epoch) and the SessionStart resume/compact rehydration stamps it after emitting its own RECENT EVIDENCE block. The rehydration read itself is unchanged.
- Reason: 5A (and Phase 3 before it) re-injected the same two evidence lines on every retrieval for the 14-day TTL, including the session's own last human message.
- Alternatives considered: a separate emitted-evidence ledger (more state for the same effect); dropping the lane from the prompt path (loses the sibling-freshness supplement the RFC asks for).
- Invariant evidence: `test/continuity-recall-gate.test.ts` case 3; harness `same-project-same-workstream` sibling evidence 1/1 with 0 repeats; `duplicate_injections` 0 across all workloads.
- Reversal condition/trade-off: evidence cut by the budget or indexed inside the read/commit window is not retried on the prompt path (bounded loss; MCP still serves it).

## D-031 — `embedding_calls` counts real inferences; the harness reports requests

- RFC section/invariant: §15.5 measured outcomes; Prompt 5A metric 12 "embedding call/cache hit"; Prompt 5B check 13
- Actual choice: `embeddings.ts` keeps process-wide `modelCalls`/`cacheHits` counters (`embeddingCallStats`); the prompt path samples the delta, so `embedding_calls` equals model inferences including the eight background-probe embeddings on a cold process and `embedding_cache_hits` counts query-memo hits. `scripts/continuity-recall-benchmark.mjs` reports `embeddingCalls` as requests (inferences + memo hits) and `embeddingInferences` separately, because the harness recycles prompt text through the 32-entry memo.
- Reason: 5A incremented a local counter around `generateEmbedding`, which reported 1 while a cold-process retrieval performed 9 inferences, and never recorded cache hits at all.
- Alternatives considered: counting probes statically (wrong once cached); disabling the memo in the harness (would misreport production behaviour).
- Invariant evidence: `test/continuity-recall-gate.test.ts` case 7 (telemetry equals the module counters, memo hit recorded); `test/continuity-recall.test.ts` case w under the mocked counter.
- Reversal condition/trade-off: none; counters are monotonic per process and cost nothing.

## D-032 — Hint ledger: WATCH TTL in substantive prompts, TRACE resident per epoch

- RFC section/invariant: §12.5 WATCH/TRACE policies, §15.4; Prompt 5A "bounded ranking/TTL"
- Actual choice: `watch_emitted_json` is a hint ledger keyed `watch:<signature>` / `trace:<subject>` with the epoch, a change token (newest verified episode or Chronicle count@effective_at) and a counter of substantive prompts since emission that advances on every retrieval. A WATCH line is repeated only after 5 substantive prompts or when a newer verified episode exists; a TRACE pointer is repeated only when the Chronicle for that subject changed. The TRACE text starts with `trace_fact subject_key=…` so the actionable pointer survives the 160-char line cap.
- Reason: 5A's TTL compared against a counter that every retrieval reset, so a WATCH never re-emitted inside an epoch; TRACE had no residency and repeated on every explicit-history prompt (33 duplicate lines in the harness).
- Alternatives considered: TTL for TRACE too (re-emits a pointer already in context); no TTL for WATCH (a live signature is never re-warned in a long epoch).
- Invariant evidence: `test/continuity-recall-gate.test.ts` case 4; harness `duplicate_injections` 0 and `watch_ttl_suppressions` 1.
- Reversal condition/trade-off: the TTL constant (5) is unmeasured on real sessions; it bounds fatigue and is not a recall control.

## D-033 — Korean suffix stripping in the fingerprint tokenizer and a wider acknowledgement lexicon

- RFC section/invariant: §12.3 lexical fingerprint, "단순 길이만으로 중요한 짧은 질문을 버리지 않는다"
- Actual choice: `tokenizePrompt` strips one trailing Korean particle/verb ending (을/를/도/에서/해줘/해주세요 …) from tokens that keep at least two characters; the acknowledgement/continuation lexicon adds polite Korean forms (계속해주세요, 알겠어요, 좋습니다 …) and English filler-only phrases (sounds good, go ahead; nice work). Memory, trace and high-impact intent regexes are unchanged.
- Reason: attached particles made Korean follow-ups look like topic drift (Jaccard 0), forcing retrieval on every Korean prompt, and polite acknowledgements went to the ambiguous path (one embedding each).
- Alternatives considered: full morphological analysis (dependency); Korean-specific thresholds (more knobs).
- Invariant evidence: `test/continuity-recall-gate.test.ts` case 8 (KR/EN short memory, high-impact and incident prompts retrieve; acknowledgements skip); harness `korean-follow-up-ack` retrievals 22 → 7 with 2/2 Korean history intents recalled.
- Reversal condition/trade-off: stripping only affects fingerprint overlap, never the retrieval embedding; a false coherent skip would still be bounded by the safety refresh.

## D-034 — Session partition claims are ordered by priority lane before checkpoint ordinal

- RFC section/invariant: §9 durable queue and worker priority (P0 capture > P1 Capsule > P2 extraction), §16 session partition serialization; OUTBOX, RECOVERY, HOOK BOUNDARY, ACCOUNTABILITY
- Actual choice: `claimMemoryJobById` orders a partition's outstanding jobs by `priority DESC` first and by checkpoint ordinal only within the same priority; the Continuity worker's `nextJob` applies the same rule. Capture checkpoints keep journal-byte ordinals and extraction checkpoints keep exchange-rowid ordinals; the two are never compared across lanes.
- Reason: Phase 1 extraction jobs (`fact_extract`, ordinal = `through_rowid`) and Phase 2 capture jobs (`capture_index`, ordinal = journal byte offset) share the `session:<id>` partition. A `fact_extract` job left `pending` between pages had a smaller ordinal than every later capture checkpoint, so the worker never selected the capture job and the startup launcher (which defers extraction while Continuity work is pending) never resumed extraction either: P0 capture indexing for that session was blocked indefinitely. Found by the Final Integration probe; reproduced before the fix.
- Alternatives considered: a separate `extraction:<session>` partition key (would need a data migration for pending rows and loses the RFC's single session partition); kind-aware ordinal spaces.
- Invariant evidence: `test/continuity-final-integration.test.ts` "P0 capture indexing is never blocked by a pending P2 extraction job in the same session partition" (fails on the previous ordering); `test/continuity-correctness-spine.test.ts` partition ordering/serialization cases unchanged and passing.
- Reversal condition/trade-off: a `capture_index` job in `retry` with backoff defers extraction for that session until it retries or is dead-lettered (accountability first); extraction never starves capture.

## D-035 — Privacy purge removes Capsules derived from the purged session

- RFC section/invariant: §18 privacy purge cascade (journal/checkpoint/capsule/event/cache/sync), §21.6; PRIVACY
- Actual choice: inside the purge transaction, every `work_capsules` row whose `source_session_id` is the purged session or whose `source_exchange_ids_json` cites a purged exchange is deleted, and `session_memory_state.capsule_generation_seen` is reset to 0 for sessions bound to that workstream so the sibling's next Capsule generation is re-injected as `[WORK NOW]`. Phase 3's rule that a shared workstream row itself survives for the sibling is unchanged.
- Reason: Phase 3 preserved a Capsule "still owned by a sibling session" as a whole, so a projection quoting purged human statements remained readable through rehydration and `WORK NOW` on the sibling. A Capsule is model-derived state built from the purged evidence; the RFC lists it in the purge cascade.
- Alternatives considered: strip only the items citing purged exchanges (leaves objective/state text derived from the same evidence); rebuild immediately (model call inside a purge).
- Invariant evidence: `test/continuity-final-integration.test.ts` "privacy purge removes a Capsule projection derived from the purged session even when a sibling shares the workstream" and the end-to-end residue table; `test/continuity-identity.test.ts` sibling-Capsule case still passes (its Capsule is not sourced from the purged session).
- Reversal condition/trade-off: the sibling loses its projection until its next Capsule job; the deterministic tail baton from its own evidence covers the gap.

## D-036 — Stale resident revision is a cheap-gate state trigger

- RFC section/invariant: §11.4 (sibling change corrected at the next boundary), §12.3 cheap gate triggers, §12.6 correction semantics; REVISION-AWARE INJECTION, RESIDENCY, BRANCH TRUTH
- Actual choice: `computeInjectContext` reads the session's resident revisions and `readResidentRevisionCorrections` before the gate decision and passes `residentRevisionStale` to `decideRecall`, which adds the `resident_revision_stale` trigger alongside `project_revision_stale`. An acknowledgement that hits it is the existing vector-free retrieval (0 embeddings): only CORRECTION/WORK NOW/WATCH/RECENT EVIDENCE render.
- Reason: workstream-scoped truth deliberately does not bump `projects.memory_revision` (BRANCH TRUTH), so a sibling session's change to a fact resident in this session had no invalidation token; the stale statement stayed uncorrected across acknowledgement prompts until the next substantive retrieval. Phase 5B gate case 6 covered the substantive-prompt path only. Found by the Final Integration fixture ("ok" after a sibling edit rendered nothing).
- Alternatives considered: bump the project revision for workstream facts (rejected in D-028 — it breaks BRANCH TRUTH separation); a per-workstream revision counter (new state for the same signal residency already carries).
- Invariant evidence: `test/continuity-final-integration.test.ts` sibling correction on "ok" with 0 embeddings; `test/inject-write-ordering.test.ts`, `test/continuity-recall-gate.test.ts`, `test/continuity-recall.test.ts` unchanged and passing; recall benchmark re-run in the Final Integration gate (retrieval reduction unchanged at 61.1%).
- Reversal condition/trade-off: one primary-key row read plus one `facts WHERE id IN (...)` query per prompt when the session has resident revisions; no embedding or model work is added.

## D-037 — Release closure keeps the support-window compatibility surfaces

- RFC section/invariant: §22 Final Integration & Release Closure; Prompt F2 code cleanup
- Actual choice: F2 changed no runtime code. `scripts/session-end-hook.js` (final-fence alias, D-011), `scripts/sync-export-hook.js`, `scripts/inject-context-hook.sh` (explicit fallback hook path used by the installer and lifecycle tests), legacy canonical path queries (D-016) and the `extraction_log`/`SEED`/`PERMANENT` markers (D-007) remain as documented read-only or alias surfaces. The repository contains no TODO/FIXME markers and no disabled tests.
- Reason: removing released executables or readers in the same release would break installed callers during the support window; none of them is a completion or truth authority.
- Alternatives considered: delete the aliases now; leave them undocumented.
- Invariant evidence: `docs/GUIDE.md` §15 lists the surfaces; `test/codex-slice.test.mjs`, `test/session-end-*.test.ts` and `test/lifecycle-slice.test.mjs` pin their behavior; the F2 smoke matrix passed unchanged.
- Reversal condition/trade-off: remove in a documented breaking release after installed callers migrate.
