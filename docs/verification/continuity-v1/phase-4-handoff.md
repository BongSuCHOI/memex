PHASE 4 GATE: PENDING (4A implementation handoff; independent 4B gate not yet run)

# Phase 4 — Chronicle & Deep Memory Exploration implementation handoff

Prompt 4A implemented the sparse Chronicle on top of the released revision table, stable subject slots,
grounded-cause versus classifier-note separation, source-effective temporal ordering, rollback and
contradiction handling, incident episodes/patterns with a bounded match API, MCP deep exploration, sync and
privacy coverage, and measured outcome telemetry. Phase 5 adaptive recall and WATCH/TRACE injection routing
were not started.

## Repository and lock

- Branch: `feat/memex-continuity-v1`
- Phase 4A base HEAD: `b591aa3` (Phase 3 `5ec4909` plus the post-gate trigger-race fix)
- Final RFC SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Continuity schema: `5` (was `4`); sync protocol: `4` (additive rows); package/plugin: `0.3.0`
- Runtime: Node `v26.0.0`, macOS arm64. Implementation session: Claude Code (see D-017).
- Preserved user-owned state: deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` remains untouched.

## Current Facts vs Chronicle

`facts` stays the fast materialized projection with semantic/lifecycle generation CAS. `fact_revisions` is
rebuilt in place (schema v5) as the single append-only Chronicle table (D-018): nullable `fact_id`,
`previous_fact`, `new_fact`; added `project_id`, `subject_key`, `event_kind`, from/to semantic generation,
`lifecycle_generation`, `problem`, `grounded_cause`, `rationale`, `classifier_note`, `outcome_json`,
`source_exchange_ids`, `source_evidence_ids`, `reverts_event_id`, `related_event_ids`, `actor`,
`policy_version`, `evidence_authority`, `effective_at`, `effective_at_source`, `recorded_at`,
`projection_applied`, `chronicle_seq`. Legacy rows are backfilled deterministically as
`CHANGED`/`actor=legacy` with `reason → classifier_note`. No query replays events to compute current state.

## Subject and event contract

- Subject grammar `^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$`; prefix must match
  the category (knowledge → `state`). Invalid proposals become classifier notes, never slots (D-020).
- Slot resolution in the extraction commit: empty → `ASSERTED`; same normalized text → provenance merge, no
  event; newer evidence with sufficient authority → `CHANGED` on the existing identity; older evidence →
  historical `ASSERTED` (`projection_applied = 0`); tie or lower authority → `CONTRADICTED` candidate.
- Event ids are content hashes (`sha256[0:32]`): duplicate delivery and sync replay collapse; same id with
  different content is a visible conflict, never an overwrite.
- Kinds: `ASSERTED`, `CHANGED`, `RETIRED`, `RESTORED` may change the projection and are written in the same
  transaction as the projection mutation; `VALIDATED`, `INCIDENT`, `CONTRADICTED` are event-only and are
  rejected if they claim a projection change.
- Consolidator mapping: `DUPLICATE` → no event; `EVOLUTION`/`CONTRADICTION` → temporal judge → `CHANGED`
  or historical/`CONTRADICTED`; consolidator reason → `classifier_note` only.
- Rollback: returning to the value a prior `CHANGED` replaced links `reverts_event_id`; nothing is deleted.

## Temporal and grounding contract

- `effective_at` = max timestamp of the cited authoritative source exchanges (`effective_at_source=source`),
  else the recorded time flagged `recorded`; peer rows are `peer`. `recorded_at` = worker commit time.
- Timelines order by `effective_at, recorded_at, chronicle_seq`; generation numbers and worker order never
  order history. Unknown existing effective time is un-ordered (D-021).
- Authority rank `human-decision` > `human` = `trusted-tool` > `unknown`.
- Grounded fields are written only when the exact supporting span is present in the cited human message or
  trusted tool result (`verifyGroundedField`, extractor `change_context` validation), or when actor `user`
  states the rationale directly. Anything else is `classifier_note` or a `ChronicleGroundingError`.

## Incident match API

- `recordIncidentOccurrence` (trusted `test_execution` evidence, failures allowed, or human
  `repeated_signal`): same project+signature+session within 30 minutes coalesces (`retry_count`), otherwise a
  new episode with an `INCIDENT` event. `episode_count >= 2` or `user_flagged_repeat` → `pattern`.
- `recordIncidentRemediation`: only successful trusted test evidence or explicit human confirmation writes
  `VALIDATED` and marks `remediated`; recurrence reopens `pattern`. No-recurrence never resolves.
- `matchIncidentPatterns(db, {projectId, text, limit, includeCandidates?, includeRemediated?})`: bounded
  deterministic match (normalized substring or token Jaccard ≥ 0.5) for Phase 5 WATCH.
- `listIncidentOccurrences`, signature normalization strips ANSI/uuid/time/path/hex/numbers.

## MCP contract

`trace_fact` accepts `query | fact_id | subject_key` plus stable scope, `include_timeline`, `timeline_limit`
(≤50), `timeline_cursor`, `timeline_order`, `include_incidents`, `include_sources`, `include_hot_evidence`.
Output lanes: `CURRENT FACT`, `CHRONICLE EVENT`, `RAW EVIDENCE`, `ASSISTANT CONTEXT-ONLY`,
`HOT EVIDENCE — NOT YET DISTILLED`; grounded cause and classifier note are labeled separately; purged sources
print `source unavailable (purged or missing)`; out-of-scope facts are errors. `search_facts` revision lines
show the event kind. CLI: `memex facts history --id` prints events; `memex facts explain --subject <key>
--project-id <id>` reads a subject timeline. Phase 5 APIs: `readChronicleTimeline`, `currentFactRevision`,
`currentEffectiveAt`, `matchIncidentPatterns`, `summarizeTelemetry` (exported from `src/index.ts`).

## Sync, privacy, telemetry

- Export: `fact-revisions.jsonl` rows carry the event shape plus `portable_project_key`; device-local
  generations are dropped; event-only project rows are exported; `fact-tombstones.jsonl` gains
  `{fact_id: null, event_id}` rows (D-019). Import accepts legacy and event rows, maps projects through the
  portable key, appends idempotently by id, skips tombstoned ids, and records same-id conflicts in
  `malformedRows` while preserving local history.
- Purge: `purgeChronicleForSources` removes events of purged facts and events citing purged exchanges,
  cascades incident occurrences, recounts signatures, and tombstones every id in the purge transaction.
  A later attempt to record an incident on a purged exchange fails closed.
- Telemetry: `continuity_telemetry` samples for allowlisted metrics only; inject-core records
  `semantic_retrieval_calls`, `injected_chars`, `repeated_context_turns`; `summarizeTelemetry` returns a
  labeled measured report, never a fact or event.

## Tests and results (4A self-report; 4B must re-verify)

- `test/continuity-chronicle.test.ts`: 22 tests covering a–v of the Prompt 4A matrix (a ASSERTED, b/j
  CHANGED + grounded/null cause, c rollback, d RETIRED/RESTORED, e event-only, f contradiction candidate,
  g duplicate id, h stale worker, i effective vs recorded order, k classifier note/hallucinated cause,
  l/u purge with pending job, m subject collision, n/o/p incident coalescing/pattern/remediation,
  q/r/s MCP trace/pagination/session filter, t sync covered in `sync-export-import` suite, v contamination,
  telemetry, legacy migration).
- `test/continuity-correctness-spine.test.ts` migration crash matrix extended with the five Chronicle stages.
- Existing suites adjusted: consolidator temporal fixtures, restore result shape (`eventId`), sync fixture
  validated through the event parser, FK orphan detection retained.
- `npm run typecheck` PASS; `vitest run` 259 files / 816 tests, failed 0, skipped 0 (2026-09-04).
- Not rerun in 4A: `node --test` slices, lifecycle/package/install/marketplace E2E scripts.

## Phase 4B focus risks

1. Projection/event atomicity under injected failure after the projection UPDATE (event insert failure must
   roll back the projection) — covered indirectly; 4B should crash-inject.
2. Sync: out-of-order generation replay and same-id conflict need an end-to-end two-database test in
   `sync-export-import`; 4A only proved parser acceptance and idempotent insert paths.
3. Incident coalescing window when `sessionId` is null (no coalescing) and cross-workstream signatures.
4. `trace_fact` timeline scope filters for workspace/workstream rely on fact or exchange membership; events
   with neither may be visible project-wide.
5. Extraction prompt additions (`subject_key`, `change_context`, observation candidates) are validated
   fail-closed but have no recorded model fixtures; the eval baseline was not re-run.
6. `getRevisions` compatibility view now includes event-only rows for the fact (VALIDATED/INCIDENT tied to a
   fact id) — callers counting revisions may see more rows.
