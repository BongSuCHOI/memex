PHASE 2 GATE: PASS

# Phase 2 — Continuity Core implementation handoff

Prompt 2B independently inspected and corrected the actual hook registration, packaged process boundary,
journal/checkpoint bytes, database state, privacy races, Capsule authority, recovery, and tests. Phase 2
meets its mandatory acceptance criteria. Phase 3 may start from the APIs and boundaries documented here.

## Repository and lock

- Branch: `feat/memex-continuity-v1`
- Phase 2A base HEAD: `61501c1cca59360040b200013d5054c7f60dccc2`
- Working tree: Phase 2 implementation, tests, generated `dist`, owner docs, and this handoff are
  uncommitted for the independent gate.
- Preserved user-owned state: deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` remains untouched and
  must not be staged, restored, or included in the Phase 2 commit.
- RFC source and locked copy SHA-256:
  `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`.
- Worker Prompt Pack SHA-256:
  `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`.
- Continuity schema version: `3`; sync protocol remains `4`; package/plugin version remains `0.3.0`.

## Verified runtime contract and registration

- Installed runtime: Codex CLI `0.150.1`, Node `v26.0.0`, macOS arm64.
- Official contract target: `SessionStart` sources `startup|resume|clear|compact`; compact triggers
  `manual|auto`; lifecycle events `UserPromptSubmit`, `Stop`, `Interrupt`, `PreCompact`, optional
  telemetry-only `PostCompact`, and synchronous `SessionEnd`.
- `scripts/continuity-hook.js` is the packaged unified capture gateway. The retained
  `scripts/session-end-hook.js` name is a thin compatibility alias; the old foreground
  stabilize/extract/consolidate/export chain is unreachable.
- A materialized plugin runs the version-pinned local artifact through `cli/runtime-exec.js`; moving
  `github:...#main` is only the compatibility fallback before dependency materialization.
- Hook input normalization preserves `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
  `turn_id`, `source`, `trigger`, `reason`, `permission_mode`, `stop_hook_active`, and
  `last_assistant_message`. Transcript paths are resolved, restricted to allowed session roots, and
  rejected when malformed, non-regular, traversing, or symlink-escaping.

| Event | Matcher | Timeout | Synchronous effect | Context/output |
| --- | --- | ---: | --- | --- |
| SessionStart | `startup|resume|clear|compact` | 3s | state ensure/recovery; clear/compact epoch ensure | bounded JSON context only for resume/compact |
| UserPromptSubmit | none | existing path | existing retrieval plus revision-aware residency | event-valid JSON or empty |
| Stop | none | 3s | delta journal, closed checkpoint, atomic outbox | silent |
| Interrupt | none | 3s | delta journal, interrupted/open checkpoint, atomic outbox | silent |
| PreCompact | `manual|auto` | 5s | remaining complete delta, fsync, checkpoint/outbox | silent |
| PostCompact | `manual|auto` | 3s | privacy-safe telemetry only; may wake already-durable work | silent |
| SessionEnd | none | 3s | final delta, final fence, atomic outbox | silent |

Codex `0.150.1` authenticated fixture supplied `session_id`, `transcript_path`, `cwd`, event name, prompt,
source/trigger where applicable, and accepted hook-specific JSON `additionalContext`. Capture events are
silent; only SessionStart resume/compact and UserPromptSubmit may emit bounded JSON context. A valid capture
whose source/path operation fails exits open with a durable gap and stderr warning unless
`MEMEX_STRICT_CAPTURE=1`; malformed JSON, missing identity, unsupported events, and invalid SessionStart
state fail nonzero. Runtime timeout maxima are the registered values above. Rehydration hard-truncates at
2,000 characters and has no spill side channel. Codex may deliver duplicate/concurrent hooks; the DB writer
boundary converges them. A detached wake has no foreground cancellation dependency because durable leases
and the next startup recover work. Rollout JSONL remains a compatibility parser surface: incomplete trailing
lines are deferred and raw EOF is never used as the final/interrupted authority.

Capture hooks perform zero model, embedding, consolidation, extraction, full-sync, or foreground export
calls. On a successful capture the launcher may detach a best-effort worker wake; correctness depends on
the already-committed queue, not on wake completion or hook ordering.

## Journal and checkpoint contract

- `journal_streams` records source realpath/device/inode/mtime, a bounded copied-prefix tail guard,
  copied source byte/line boundary, journal byte boundary, prefix hash, parser version, and a
  monotonically increasing stream epoch.
- Each capture reads only bytes after `copied_byte_end`, appends only complete newline-terminated bytes,
  defers a trailing partial line, fsyncs the Memex-owned journal, and records an append block.
- Block/prefix hash: the persisted segment hash and chained prefix hash are verified again by the P0
  capture-index worker before parsing.
- Path/device/inode change, truncation, same-size rewrite, or growing rewrite of already-copied bytes
  creates a new stream epoch; old journal bytes are never rewound or overwritten.
- Checkpoint identity includes session, stream epoch, through byte, prefix hash, and kind. Duplicate event
  delivery converges to the same effect; a grown same-turn prefix receives a different checkpoint.
- Checkpoint and `capture_index` outbox insertion share one SQLite transaction. Capsule scheduling state
  and any coalesced `capsule_update` job are included in the same transaction.
- The journal append and DB boundary are serialized by an immediate SQLite writer transaction, including
  across competing hook processes. Startup recovery trims an fsynced orphan journal tail back to the last
  committed DB boundary. A missing/short committed journal creates a durable gap, opens a new stream epoch,
  and recaptures the intact source; later success marks that gap recovered.

## Worker ordering and exchange closure

- `src/continuity-worker.ts` claims P0 `capture_index` before P1 `capsule_update`; Phase 1 fact extraction
  remains a separate later pipeline.
- Capture indexing verifies every segment and prefix hash, parses only through the immutable checkpoint
  byte boundary, and calls monotonic prefix ingestion. Later transcript bytes cannot alter an older
  checkpoint parse.
- The latest lifecycle fence applies event-grounded closure after parsing: `Stop` is closed,
  `Interrupt`/`PreCompact` remain interrupted/open, and `SessionEnd` is final. Closure change increments
  exchange content generation and supersedes pending stale extraction state.
- A user-role conversation-exclusion marker causes the continuity worker to execute the full privacy
  purge before indexing or model work.
- `conversation_exclusions` is a terminal session guard. Hook capture is refused after purge, while an
  already-running capture-index worker rechecks around ingest and re-purges if exclusion won the race.
- Expired running continuity leases are startup wake candidates; failed hash/model work remains retryable
  and is never reported as completed. Retry exhaustion synchronizes job/checkpoint/Capsule state as
  failed-visible/dead and prevents a dependent Capsule job from remaining falsely pending.

## Context epoch and residency

- `session_memory_state` stores path-compatible project, session-local workstream, `context_epoch`,
  epoch token, Capsule generation seen, memory revision seen, revision-aware resident/carry tuples, and
  latest checkpoint.
- Resident identity is `(fact_id, semantic_generation, lifecycle_generation)`. Same fact ID with a newer
  semantic or lifecycle generation is a new delta/correction candidate.
- `SessionStart(compact)` idempotently advances the epoch from the latest PreCompact checkpoint, clears
  old residency, carries only latest active revisions, and immediately reads local projection state.
- `clear` advances the epoch and drops old carry/residency. `PostCompact` is not consulted for any of
  these correctness transitions.
- Rehydration is hard-bounded to 2,000 characters and waits for no new extraction or semantic query.

## Work Capsule and deterministic tail baton

- `work_capsules` is a workstream-scoped context-only projection with typed objective/current state,
  source-linked verified progress, source-linked hypotheses, blockers, open questions, next actions,
  touched areas, carry revisions, source exchanges, generation, and through-checkpoint identity.
- Strict validation rejects non-exact model JSON, missing required fields, unsourced verified/hypothesis
  items, non-authoritative verified sources, overlong values, and authority mixing.
- Capsule updates use workstream generation CAS. With an owned queue lease, Capsule projection,
  checkpoint state, Capsule checkpoint state, and job completion commit atomically; a rejected completion
  rolls the entire projection write back.
- P1 jobs are coalesced after six Stop/Interrupt boundaries or 8 KiB, and are always scheduled at
  PreCompact and SessionEnd. Segments are contiguous and advance only on successful Capsule commit.
- If Capsule work is absent, stale, or failed, the bounded deterministic tail baton uses only the latest
  substantive user request, trusted tool/test/file evidence, and unresolved error fields. It is labeled
  context-only and never becomes fact or Chronicle evidence.
- A Capsule older than the latest captured checkpoint is also supplemented by a deterministic tail baton,
  so a valid but stale projection cannot hide a recent authoritative suffix.

## Recovery and privacy matrix

| Fault/boundary | Durable result |
| --- | --- |
| invalid payload/path before capture | fail-open warning plus `capture_gaps` record when session identity is usable; strict switch throws |
| trailing partial source line | deferred; no copied-boundary advance past complete newline |
| crash after journal fsync, before DB commit | orphan tail detected and trimmed on startup/recovery |
| checkpoint/outbox committed, wake lost | pending job remains discoverable by startup maintenance |
| journal hash mismatch | exact capture-index job becomes retry with visible error |
| missing/short committed journal with intact source | durable gap, new epoch, source recapture, recovered marker |
| Capsule model/validation failure | Capsule job retry; checkpoint suffix remains pending; tail baton remains available |
| retry exhaustion | job/checkpoint/Capsule failed-visible state converges; dependent work cannot strand |
| stale Capsule generation/lease | zero projection regression; retry/rebase path |
| no PostCompact event | PreCompact + SessionStart(compact) provide epoch and immediate rehydration |
| user exclusion races deferred ingest | terminal guard plus before/after checks prevent or remove regenerated private state |

## Phase 2A defects fixed before handoff

1. Same-size transcript replacement was initially indistinguishable from a duplicate capture; persisted
   source mtime now opens a new stream epoch.
2. Capture worker originally parsed beyond its checkpoint when the journal later grew; parsing is now
   bounded by the immutable through-byte fence.
3. Raw parser EOF closure could override lifecycle evidence; the latest Stop/Interrupt/final checkpoint
   now applies closure and increments generation on change.
4. `applyLatestLifecycleClosure()` referenced a nonexistent `exchanges.updated_at` column; the update now
   uses only persisted exchange fields and has a direct lifecycle regression test.
5. A failed Capsule queue completion could return after writing the projection and commit partial state;
   it now throws to roll back the transaction, with a trigger-forced failure regression test.
6. Package runtime E2E treated expected `npm warn` installation diagnostics as hook stderr; the assertion
   now requires silent hook output while allowing npm-owned warnings.
7. Install/marketplace/lifecycle fixtures had hard-coded six-hook assumptions; they now validate all 11
   owned matcher entries across seven lifecycle surfaces.

## Phase 2B independent defects fixed

1. Concurrent hook processes appended to the journal before taking a DB writer lock, so two processes
   could create conflicting hash-chain prefixes. Capture is now serialized across the complete
   source-read/journal/checkpoint/outbox boundary, with a four-process regression.
2. Same-inode source content could be rewritten and then grow, producing a hybrid journal. Schema v3 adds
   a bounded copied-prefix tail guard and capture revalidates source identity before append.
3. A short committed journal produced a diagnostic gap but had no intact-source recovery path. It now
   opens a new epoch, recaptures the source, and closes the durable gap.
4. A valid stale Capsule suppressed the unprocessed recent suffix. Compact rehydration now includes the
   deterministic tail baton whenever the Capsule is missing or behind the latest checkpoint.
5. Privacy purge could race an already-running capture-index worker and allow deleted exchanges to be
   reinserted. A terminal `conversation_exclusions` guard plus ingest-boundary rechecks closes the race.
6. Retry exhaustion marked only the queue job dead, leaving checkpoint/Capsule accountability stale.
   Terminal state now converges atomically, and the worker reports `dead` instead of `retry`.
7. Capsule validation silently filtered/defaulted/truncated malformed model output and accepted undeclared,
   nonexistent, or assistant-only sources. Exact fields, bounded values, declared/existing sources, and
   authoritative verified-source checks now fail closed; the model prompt states the same wire shape.
8. Hook payload `cwd` could override canonical project authority. A bounded session-meta probe now binds
   the transcript's canonical cwd/session and ignores payload drift.
9. Lifecycle closure selection and update were separate DB operations. Both now run in one immediate
   transaction so extraction scheduling cannot observe a half-applied fence.
10. Installed plugin hooks executed moving GitHub `main`, not the installed candidate, adding network/package
    manager work and revision drift to foreground hooks. A materialized installation now executes its local
    pinned binaries; authenticated Codex E2E proves the corrected path.

## Verification evidence

| Phase 2 PASS condition | Observed result |
| --- | --- |
| captured prefix hash/accountability | every long-fixture capture-index completed; mismatches 0 |
| unaccounted closed exchange | 0; all 200 parsed turns were `closed`/`final` after P0 drain |
| wrong closure | 0 across Stop/Interrupt/PreCompact/SessionEnd assertions |
| PostCompact absence failure | 0 across all eight compact cycles |
| compact rehydration miss | 0; deterministic fixture and authenticated plugin-only runtime |
| old epoch suppress/carry error | 0; old ledger cleared and inactive revisions rejected |
| Capsule authority contamination | 0; malformed/mixed/assistant-only/nonexistent sources rejected |
| heavy foreground hook work | 0 model/embedding/sync/extraction calls; actual final fence 577 ms |
| migration | v1/v2 to v3 additive migration, injected rollback/re-run PASS |
| Phase 3 reuse boundary | journal/checkpoint/Capsule/session/privacy APIs documented in owner docs and this handoff |

| Command / workload | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; generated `dist` refreshed |
| Phase 2 focused suites | PASS — 4 files / 57 tests; no skip/todo |
| `npm test` final | PASS — 73 files / 754 tests; skipped 0, todo 0 |
| `node --test test/codex-slice.test.mjs` | PASS — 24/24; skipped 0, todo 0 |
| `node --test test/*slice.test.mjs` managed sandbox final | 93/94; only inject-daemon Unix socket `listen EPERM`; skipped 0, todo 0 |
| exact `node --test test/inject-daemon-slice.test.mjs` outside sandbox | PASS — 1/1 |
| `node scripts/lifecycle-e2e.mjs --tier offline` | PASS — 9/9, seven surfaces and 11 owned entries cleaned |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES — formal `codex plugin validate` absent in CLI 0.150.1; all authorized installed-artifact substitute checks PASS |
| `node scripts/install-e2e.mjs` | PASS — dry-run, isolated install, rerun, remove, user-surface isolation |
| `node scripts/marketplace-e2e.mjs` | PASS — seven events, cleanup PASS |
| `node scripts/package-runtime-e2e.mjs` outside sandbox | PASS — final candidate tarball, 209 files, nine MCP tools, onboarding, final fence + deferred worker |
| `node scripts/lifecycle-e2e.mjs --tier authenticated` outside sandbox | initial 8/11 FAIL exposed remote-main execution and Capsule/fixture defects; second 10/11 isolated the strict model-shape failure; corrected plugin-only final PASS 12/12 with exact-once UserPromptSubmit/Stop/SessionEnd, actual Codex additionalContext, 577 ms final fence, deferred Luna Capsule generation 1, compact immediate rehydrate, cleanup 7/7 |
| `node scripts/continuity-benchmark.mjs` final | PASS — 200 turns, 49,075 source/appended/journal bytes, amplification 1.0, p50 6.865 ms, p95 10.767 ms, max 17.568 ms, 200 checkpoints, one Capsule job, zero gaps |
| static `.skip/.only/.todo` scan and `git diff --check` | PASS |

Expected stderr from negative provider, stale-CAS, privacy-race, and irreducible-failure tests was
observed. No failure or skipped test is hidden. The aggregate slice sandbox failure is retained separately
from the exact outside-sandbox PASS. Authenticated failures and the final successful rerun are retained
separately rather than rewriting the initial outcome.
An exploratory `npm pack --dry-run --json` inside the managed sandbox could not write npm's home log
directory and returned no JSON; the repository package-runtime E2E was therefore run outside the sandbox
against the actual tarball and is the package verdict above.

## Deviations, debt, and Prompt 2B focus

- D-009: registered PostCompact is telemetry-only.
- D-010: Phase 1 queue is reused; every prefix gets P0 capture-index and bounded Capsule work is P1.
- D-011: the public SessionEnd executable name is a thin continuity alias during the support window.
- D-012: rewrite detection uses persisted mtime plus a bounded copied-prefix guard instead of full-prefix
  hashing on every hook.
- D-013: a materialized plugin executes its pinned installed artifact; moving GitHub runtime is fallback only.
- Phase 3-only work remains intentionally absent: stable logical project/workspace identity, cross-device
  linking, full conservative multi-session workstream resolver, branch-truth promotion, and Hot Evidence.
- Phase 3 blockers: none from the Phase 2 gate. Phase 3 must preserve the published journal/checkpoint,
  Capsule, terminal privacy guard, and context-epoch APIs while replacing path compatibility identity.
