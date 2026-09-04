FINAL INTEGRATION GATE: PASS

# Memex Continuity Architecture v1 — Final Integration gate (Prompt F1)

Prompt F1 re-verified the integrated system end to end across every Phase boundary, did not trust the
Phase 1–5 handoff tables, traced the actual diff/schema/runtime paths, built one cross-phase fixture with
crash injection and duplicate delivery at the seams, measured the 13 mandatory zero counts, and fixed the
three defects it found directly. Every mandatory verification ran in this environment and passed; nothing
was skipped, mocked away, or left unrun.

## Revision, lock and versions

| Item | Value |
| --- | --- |
| Branch / HEAD | `feat/memex-continuity-v1` at `0854797` (Phase 5 closure); F1 corrections uncommitted in the working tree for the parent's commit |
| Final RFC SHA-256 | `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a` — verified before and after the gate; never modified |
| Worker Prompt Pack SHA-256 | `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3` |
| Continuity schema | `6` (`PRAGMA user_version`, `continuity_schema_meta`); no schema change in F1 |
| Sync protocol | `4` (five-file generation, additive stable-identity/Chronicle row shape) |
| Package / plugin | `0.3.0`; packaged artifact `memex-0.3.0.tgz`, 222 files, 9 MCP tools |
| Gate runtime | Claude Code general-purpose subagent (D-017); Node `v26.0.0`; Codex CLI `0.153.2`; macOS arm64 |
| Preserved user state | the uncommitted deletion of `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` was not staged, restored, or touched; `docs/verification/plugin-validation.json` was rewritten by `validate-plugin` with timestamp/temp-path noise only and restored |

## Defects found and fixed by F1

| # | Defect (cross-phase seam) | Fix | Regression test |
| --- | --- | --- | --- |
| F1-1 (D-034) | Phase 1 `fact_extract` jobs (checkpoint ordinal = exchange rowid) and Phase 2 `capture_index` jobs (ordinal = journal byte) share the `session:<id>` partition. A `fact_extract` job left `pending` between pages sorted before every later capture checkpoint, so `nextJob`/`claimMemoryJobById` never selected the capture job, and the SessionStart launcher (which defers extraction while Continuity work is pending) never resumed extraction: P0 capture indexing for that session was blocked indefinitely. | Partition claims are ordered by priority lane first (P0 100 > P1 80 > P2 20), then by ordinal within the lane: `src/continuity-worker.ts:65-70` (`nextJob`), `src/continuity-store.ts:1364-1378` (`claimMemoryJobById`). | `test/continuity-final-integration.test.ts` "P0 capture indexing is never blocked by a pending P2 extraction job…" (fails on the previous code) |
| F1-2 (D-035) | A Work Capsule built from a purged session (or citing purged exchanges) survived `purgeConversationFromIndex` when a sibling session shared the workstream; its objective/state/verified-progress text (derived from the purged evidence) stayed injectable through rehydration and `[WORK NOW]`. | Purge deletes such Capsules inside the purge transaction and resets `capsule_generation_seen` for sessions bound to the workstream: `src/conversation-policy.ts:321-337`. | "privacy purge removes a Capsule projection derived from the purged session…" and the end-to-end residue table |
| F1-3 (D-036) | A workstream-scoped fact changed by a sibling session carries no `projects.memory_revision` token (BRANCH TRUTH), so a session holding the old revision in its context got no correction on acknowledgement prompts; the stale statement persisted until the next substantive retrieval. | Resident-revision staleness is a cheap-gate state trigger (`resident_revision_stale`), evaluated before the acknowledgement lexicon and rendered vector-free: `src/recall-gate.ts:52,103,251`; `src/inject-core.ts:297-299,341`. | end-to-end fixture: "ok" after a sibling edit renders `[MEMEX CORRECTION]` with 0 embeddings; `test/inject-write-ordering.test.ts`, recall gate/recall suites unchanged and green |

No architecture was added; each change is the smallest correction inside the RFC invariants. As-built docs
updated: `docs/SCHEMA.md` (partition claim order), `docs/RETRIEVAL-AND-CONTEXT.md` (gate trigger),
`docs/CONVERSATION-LIFECYCLE.md` (Capsule purge cascade). `dist/` is tracked and was rebuilt.

## Invariant table (RFC §19)

Evidence is end to end on the corrected tree: "F1" = `test/continuity-final-integration.test.ts` (three cases,
one 15-turn/3-compaction fixture through capture → outbox → P0/P1 worker → exact extraction → Chronicle →
injection → sync (two databases) → purge → replay); other suites are named where the F1 fixture leans on them.

| Invariant | End-to-end evidence |
| --- | --- |
| CAPTURE | F1: after crash injection at `afterJournalFsync`/`afterCheckpoint`/`afterJob`, an Interrupt, duplicate Stop/PreCompact/SessionStart deliveries and a grown-prefix same-turn double compaction, journal bytes == transcript bytes (single active stream, `copied_byte_end` == file size), open capture gaps 0, recovered gaps ≥ 1; P0 verifies every block/prefix hash before parsing (`continuity-adversarial` hash-mismatch → retry, exhaustion → dead-visible) |
| ACCOUNTABILITY | F1: `unaccounted_closed_exchanges` 0 (15/15 closed exchanges have a `processed` generation row); a transient model crash leaves an audit `retry` range and no `failed-visible`/`dead` job; `continuity-correctness-spine` exact failed-visible/dead-letter ranges |
| MONOTONIC INGESTION | F1: an older, shorter, open-closure prefix (CP1 after CP2) is ignored with zero row change; spine CP2-then-CP1 case |
| EXACT EXTRACTION | F1: every cursor-passed target item's exchange text appears in a model envelope actually sent (presented-set check, 15/15); target cursor == item_count; spine concurrent-insert/stale-update cases |
| NO SAMPLING LOSS | F1: `MEMEX_MAX_EXTRACT_WINDOWS=1` pages over a 15-item target drain contiguously (ordinals 1..15 all `processed`), `silent_skipped_pages` 0, `cursor_overrun` 0; spine randomized 37-item drain |
| OPEN TURN | F1: the PreCompact-fenced turn 15 stayed `interrupted` and was excluded from the target until its Stop closed it (item_count 14 → 15); `continuity-adversarial` Interrupt vs Stop closure |
| AUTHORITY | F1: rehydration renders Capsule and tail baton as context-only; WATCH only after two verified independent episodes; extractor evidence limited to human/trusted-tool spans; recall harness `assistant_above_truth` 0, `watch_false_positives` 0 |
| CAPSULE TYPING | F1: Capsule model crash → `retry` → strict typed patch accepted (generation ≥ 1, `source_session_id` recorded); stale Capsule supplemented by the deterministic tail baton; `continuity-core` exact-shape/authority/CAS cases |
| CURRENT VS HISTORY | F1: extractor slot resolution ASSERTED(MySQL) → CHANGED(Redis) on one identity; duplicate delivery → provenance merge, no event; older evidence → historical ASSERTED (`projection_applied` 0) with projection untouched; rejected commit marker rolls facts and events back together (`fact_revisions`/`facts` counts unchanged) |
| GROUNDED CAUSE | F1: source-cited cause stored with the citing exchange in `source_exchange_ids`; a rationale span absent from the source became a classifier note; `ungrounded_cause_authoritative` 0 (no grounded field without sources, no authoritative "probably cheaper"); MCP renders `grounded cause (source-cited)` and `NOT authoritative` on separate lines |
| TEMPORAL ORDER | F1: `effective_at` equals the cited exchange timestamp (`effective_at_source = source`); older-effective evidence delivered after the newer CHANGED becomes history; `continuity-chronicle-gate` recorded-vs-effective order |
| RESIDENCY | F1: three compactions advance the epoch (0→3) with residency cleared per epoch, rehydration marks the Capsule generation seen so the next prompt does not repeat it; sibling session C receives `[WORK NOW]` once with 0 embeddings; after purge the sibling's `capsule_generation_seen` resets to 0 |
| REVISION-AWARE INJECTION | F1: a resident workstream fact changed by a user/sibling → `[MEMEX CORRECTION]` on the next acknowledgement with 0 embeddings, quoting the earlier statement; the promoted generation is corrected again; `stale_fact_correction_failure` 0; recall harness corrections 3/3 |
| SCOPE | F1: another project's fact never enters any injected bundle (`cross_project_injection` 0 across all prompts); a same-project different-workstream session never receives the workstream fact (`wrong_workstream_injection` 0); `trace_fact` with the other project's scope returns an error rather than widening |
| BRANCH TRUTH | F1: every extracted fact is `promotion_state = workstream`; `unmerged_project_current_promotion` 0 before the explicit `assignFactSubject(evidence: merged)` promotion; only after promotion does session B and the sync export see it |
| OUTBOX | F1: checkpoint + `capture_index` + coalesced `capsule_update` share one transaction; crashes after fsync/checkpoint/job leave no half state and the re-delivered Stop converges (`created: true`, same prefix); priority-lane claim (D-034) keeps the session partition drainable |
| RECOVERY | F1: index crash → `retry` → drained; stale lease owner's completion rejected after a newer claim; Capsule and extraction model crashes retried to completion; after every stage `checkpoints.state NOT IN ('processed')` == 0 for the session; 200-turn run: 224 jobs completed, 0 retry/dead |
| HOOK BOUNDARY | F1: acknowledgement corrections and Capsule carry with 0 embedding requests; capture hooks perform no model/embedding call (`continuity-core` boundary test); Stop capture p95 13.1 ms in-process (200-turn run) |
| POSTCOMPACT INDEPENDENCE | F1: zero PostCompact deliveries across three compactions (auto, manual same-turn double, auto); `compact_rehydration_miss` 0; `postcompact_dependency_failure` 0; `continuity-adversarial` 200-turn/8-compaction fixture |
| MCP ACCESS | F1: `trace_fact(subject_key, scope: project)` shows `[CURRENT FACT]`, CHANGED history and the grounded cause on the origin and on the sync peer (purged source labeled `source unavailable (purged or missing)`); 300-event subject pages at 50 events with a cursor (10.8 ms / 4.5 ms) |
| PRIVACY | F1: purge crash (trigger abort) rolls back with no exclusion row and all rows intact; real purge leaves 0 of exchanges/vectors/journal streams/blocks/checkpoints/jobs/targets/generation state/hot evidence/session state/recall/Capsule/fact/events/incidents and no journal directory; hooks, worker, extraction and injection replay recreate nothing; purge propagates as tombstones through sync and a stale pre-purge generation from a third device resurrects nothing (`purged_memory_resurrection` 0) |
| NO SILENT LOSS | F1: model crash is visible as `retry` on job and target; `silent_skipped_pages` 0; sync conflicts and uncommitted generations are rejected/ignored visibly (`sync-generation`, `continuity-chronicle-gate`) |

## Mandatory scenario groups (Prompt F1)

| # | Group | What ran | Result |
| --- | --- | --- | --- |
| 1 | Long session | `continuity-adversarial` 200 turns / 6 auto + 2 manual compactions / same-turn double compaction / 5 Interrupts / duplicate deliveries / SessionEnd / P0 drain; F1 fixture 15 turns with 3 compactions and topic-changing turns; 200-turn measurement run (`/tmp/f1-200.mjs`, below) | 200/200 closed or final, 214 checkpoints processed, 8 epochs, 0 gaps, rehydration miss 0 |
| 2 | Crash injection | journal fsync→DB, checkpoint→job, job→commit (F1 + `continuity-core` seams); index (`beforePrefixIngest`); Capsule model; extraction model; Chronicle transaction (commit marker rejected after events); sync export (uncommitted generation ignored; `sync-generation` crashed-export/CURRENT-flip cases); privacy purge (trigger abort); page-commit and migration stages (`continuity-correctness-spine`, every write stage); consolidation (`continuity-chronicle-gate` injected failures around `applyFactMeaningMutation`, the consolidator's mutation path) | every seam rolls back to a state the retry/re-delivery converges from |
| 3 | Duplicate / out-of-order | CP1 after CP2; duplicate Stop/PreCompact/SessionStart(compact)/SessionEnd; no PostCompact; stale-lease completion (capture_index in F1, extraction in spine); duplicate sync import (0 new), duplicate Chronicle delivery (merged, no event); old fact generation after new (historical), stale Capsule generation (`continuity-adversarial`) | idempotent; zero regression |
| 4 | Multi-session / workspace | F1: same workstream A/C share Capsule and current truth; different workstream B isolated; `continuity-identity` 27 cases: checkout + worktree, renamed checkout, same-remote clones isolated until approval, explicit portable link/split idempotent and audited, no latest-unrelated-session binding, strong topic margin | leakage 0, ambiguous merge 0 |
| 5 | Branch truth | F1: extracted Redis fact stays `workstream`; main-workstream session never sees it; explicit merged promotion makes it project-current and visible; `continuity-identity` project-current guard, `continuity-chronicle-gate` unmerged history labeled/hidden; rollback (`continuity-chronicle` reverts link) | unmerged promotion 0 |
| 6 | Chronicle | F1: ASSERTED/CHANGED/historical ASSERTED/VALIDATED(incident remediation path in chronicle suites)/INCIDENT ×2 episodes; grounded cause vs classifier note; effective-vs-recorded order; `continuity-chronicle` + `continuity-chronicle-gate` (35 cases: rollback, contradiction, missing cause, repeated incidents/remediation, duplicate sync event) | duplicate authoritative event 0 |
| 7 | Context / retrieval | F1: pre-compact carry, immediate rehydrate (tail baton, then Capsule), same fact new generation correction, ack gate skip (0 embeddings), TRACE pointer on explicit "why", WATCH on signature match, MCP deep trace; `continuity-recall-gate` 8 cases, `continuity-recall` 17 cases, recall harness 365 prompts | corrections 3/3, mandatory recall 20/20, duplicate injections 0 |
| 8 | Privacy / security | F1 purge cascade + replay + sync tombstones + stale replay; `continuity-core` malformed payload, traversal/foreign-root/symlink paths, session-id mismatch, transcript replacement (same-size and growing rewrite, new stream epoch); `security-slice` (traversal, oversized inputs, parameterized SQL, redacted hook log); `sync-export-import` path-free wire rows | resurrection 0, path leakage 0 |
| 9 | Migration / upgrade | `continuity-correctness-spine`: released-shape fixture → v6 with every write stage crash-injected and rerun; repeated startup idempotent; `continuity-identity` path→project/workspace backfill and Phase 2-shaped upgrade; older peer row shape (`continuity-chronicle-gate` legacy 7-field row, D-015/D-018); install/marketplace/lifecycle/update E2E and slices for hook install/setup/upgrade/uninstall idempotency | fresh DB `user_version` 6; all PASS |

## Mandatory zero counts (measured in `test/continuity-final-integration.test.ts`)

| Count | Measured | How |
| --- | ---: | --- |
| unaccounted closed exchanges | 0 | closed/final exchanges of the session without a `processed` row at their current generation |
| checkpoint prefix hash mismatch | 0 | jobs with a hash-mismatch error after the full P0 drain |
| cursor overrun | 0 | target cursor > item_count |
| silent skipped pages | 0 | target items not `processed` after completion |
| duplicate authoritative Chronicle event | 0 | `projection_applied = 1` events grouped by subject/effective_at/kind with count > 1 |
| cross-project injection | 0 | injected bundles containing the other project's fact |
| wrong-workstream injection | 0 | workstream fact text in the other workstream's bundle |
| unmerged project-current promotion | 0 | `promotion_state IN ('project-current','decision')` before explicit promotion |
| purged memory resurrection | 0 | purged exchanges/facts/checkpoints after hook, worker, extraction, injection and stale-generation sync replay |
| compact rehydration miss | 0 | SessionStart(compact) outputs without `WORK NOW` (3 compactions) |
| stale fact correction failure | 0 | acknowledgement after the sibling change without the corrected text |
| ungrounded cause authoritative | 0 | grounded fields without cited sources, plus unsupported rationale stored as `rationale` |
| PostCompact dependency failure | 0 | epoch count equals compaction count with zero PostCompact deliveries |

## Performance and operations observations (measured on this machine, Node v26, arm64)

| Observation | Value |
| --- | --- |
| Hook latency, `captureTranscriptPrefix` in-process, 200 Stops (`scripts/continuity-benchmark.mjs`) | p50 6.035 ms, p95 7.449 ms, max 43.545 ms |
| Hook latency, full `handleContinuityHook` Stop path, 200 turns + 5 Interrupts + 8 compactions (`/tmp/f1-200.mjs`) | p50 7.296 ms, p95 13.099 ms, max 47.61 ms; 200 turns captured in 1,862 ms total |
| Journal growth / retention | journal bytes == transcript bytes (49,075 and 80,866 in the two runs; amplification 1.0); one active stream epoch per session; purge removes the session directory |
| DB size after 200 turns + drain | 2,506,752 bytes main file + 4,206,552 bytes WAL (not checkpointed during the run); 214 checkpoints, 224 jobs, 200 exchanges |
| Worker backlog / retry / dead | 214 `capture_index` + 10 `capsule_update` completed in 3,300 ms (8-job batches); retry 0, dead 0, stale 0; priority lane P0 → P1 → P2 observed (extraction resumes only after the capture lane drains) |
| Capsule/fact/Chronicle priority behavior | Capsule jobs coalesced (1 per 200 Stops in the benchmark; 10 across 8 compactions + final in the 200-turn run); extraction P2 pages of 5 with cursor resume |
| Retrieval / injection baseline (`scripts/continuity-recall-benchmark.mjs`, deterministic stub, 365 prompts) | retrievals 365 → 142 (−61.1%), embedding requests 370 → 224, inferences 44 → 0, injected chars 7,557 → 6,035, acknowledgement embeddings 85 → 0, duplicate injections 2 → 0, max bundle 432 chars (hard 1,000/2,000); all 9 verdicts true; artifact `recall-calibration.json` refreshed |
| MCP pagination / latency | `trace_fact` on a 300-event subject: page 1 (50 events, 18,648 chars) 10.8 ms, page 2 via cursor 4.5 ms |
| 200-turn total processing | capture 1.86 s + P0/P1 drain 3.30 s ≈ 5.2 s wall for 200 turns (embedding stub); `continuity-adversarial` 200-turn case 6.4 s under Vitest |
| Package | `memex-0.3.0.tgz` 1,050,967 bytes packed / 4,109,664 unpacked, 222 files, 9 MCP tools |

## Verification receipts (all run by F1 on the corrected tree)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (0 errors) |
| `npm run build` | PASS; `dist/` refreshed (7 files) |
| `npx vitest run` (JSON reporter) | 80 files, 857 tests: passed 857, failed 0, pending 0, todo 0 (baseline before F1: 854/854) |
| `node --test test/*slice.test.mjs` | 94 tests: pass 94, fail 0, cancelled 0, skipped 0, todo 0; no `listen EPERM` (no isolated rerun needed) |
| `node scripts/lifecycle-e2e.mjs --tier offline` | 9/9 steps; cleanup 7/7 surfaces |
| `node scripts/install-e2e.mjs` | verdict PASS (dry-run, isolated install, idempotent rerun, removal, user-surface isolation) |
| `node scripts/marketplace-e2e.mjs` | status PASS; all seven lifecycle surfaces registered; cleanup PASS |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES (formal `codex plugin validate` absent in CLI 0.153.2; every pre-authorized installed-artifact check passed); artifact restored after timestamp/temp-path noise |
| `node scripts/package-runtime-e2e.mjs` | status PASS |
| `node scripts/continuity-benchmark.mjs` | PASS (figures above) |
| `node scripts/continuity-recall-benchmark.mjs` | all 9 verdicts true, retrieval reduction 61.1% |
| `git diff --check` | clean |
| disabled-test scan (`\.skip\|\.todo\|xit(` and the precise `\.(skip\|todo\|only)\(` form) | 0 disabled declarations (the broad pattern's 40 hits are `process.exit(` strings and `.skipped` result fields) |
| RFC SHA-256 | unchanged before and after |

Expected stderr from the injected model crashes, negative grounding and retry tests was observed; no
failure or skip is hidden.

## Debt and known limitations (not release blockers)

- Extracted facts are always `workstream`-scoped (the extractor sets no promotion state; `resolveFactInsertIdentity` defaults to `workstream` when the source exchanges carry a workstream). Project-wide `decision`/`project-current` truth exists only through explicit promotion (`assignFactSubject`, CLI/MCP), so sync never exports newly extracted facts until they are promoted. This is the conservative BRANCH TRUTH reading; release notes must say so.
- A transient extraction failure leaves an `extraction_failed_ranges` row in `retry` after the page later succeeds; only `failed-visible` rows are surfaced by pipeline status, so it is audit history, not a false pending signal.
- `buildRehydrationContext` (SessionStart resume/compact) still emits the Phase 3 scope-wide correction list (5B debt); the prompt path is residency-derived.
- Production-model calibration still rests on the Phase 5B 20-pair offline sample; a real-transcript replay with the model was not part of F1 (D-027).
- The authenticated lifecycle tier (`--tier authenticated`) was last run in Phase 2B; F1 ran the mandated offline tier plus install/marketplace/package E2E. The formal `codex plugin validate` subcommand remains unavailable in CLI 0.153.2.
- Product A/B (plugin-less vs pre-continuity vs v1) remains the manual protocol from Phase 5; the harness covers the automated B-vs-C subset.
- Sync import has no crash seam; recovery relies on pinned generations, per-fact transactions and idempotent re-import (verified: second import 0 new, stale replay 0). A mid-import crash re-imports on the next SessionStart.
- WAL was 4.0 MB after the 200-turn run because no checkpoint ran; normal SQLite auto-checkpointing applies in production.

## Blockers for release closure (F2)

None. Carry into F2: release notes must state cost figures as call/byte counts (never time or money), the
workstream-scoped extraction default and explicit promotion path, the PostCompact telemetry-only registration,
the compatibility surfaces kept for the support window (legacy path readers, `session-end-hook.js` alias,
`extraction_log`), and the D-034/D-035/D-036 behavior changes; decide the package version bump; optionally re-run
the authenticated lifecycle tier on the release candidate.
