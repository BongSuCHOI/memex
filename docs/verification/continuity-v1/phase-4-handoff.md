PHASE 4 GATE: PASS

# Phase 4 — Chronicle & Deep Memory Exploration gate handoff

Prompt 4B independently traced the Phase 4A schema migration, projection/event transaction, subject-slot
resolver, consolidator temporal judge, incident API, MCP `trace_fact`, sync export/import and privacy purge
paths, crash-injected the transaction seams, built a two-database sync matrix, and fixed the defects found
directly. Every Prompt 4B PASS condition holds on the corrected working tree: duplicate authoritative events 0,
history deletion on rollback 0, ungrounded cause stored as authoritative 0, temporal order corruption 0,
incident count inflation 0, MCP current→event→source trace success, bounded history pagination, safe
sync/purge, all mandatory tests passing, and the Phase 5 Chronicle/incident/current-revision APIs documented.
Phase 5 (adaptive gate, WATCH/TRACE injection routing) was not started.

## Gate, revision and lock

- Branch: `feat/memex-continuity-v1`
- Phase 4A HEAD reviewed: `3b798a9e12a07e2ab305eccb9b7fe8e62426915d`; 4B corrections are uncommitted in the
  working tree for the parent's Phase 4 closing commit.
- Final RFC SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a` (verified, unmodified)
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Gate runtime: Claude Code general-purpose subagent (D-017), Node `v26.0.0`, Codex CLI `0.153.2`, macOS arm64.
- Preserved user-owned state: the uncommitted deletion of `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` was not
  staged, restored, or touched.

## Schema and protocol versions

- Continuity schema `5` (`PRAGMA user_version`, `continuity_schema_meta`): `fact_revisions` rebuilt in place as
  the single Chronicle table (nullable `fact_id`/`previous_fact`/`new_fact`, RFC event columns, `chronicle_seq`),
  `chronicle_tombstones`, `incident_occurrences`, `incident_signatures`, `continuity_telemetry`. Migration stages
  `chronicle-table`/`chronicle-backfill`/`incident-tables`/`telemetry-table`/`chronicle-indexes` are
  crash-injected in `test/continuity-correctness-spine.test.ts` and rerun idempotently.
- Sync protocol `4` (five exact files, additive event row shape and `{fact_id: null, event_id}` tombstone rows;
  D-018/D-019). Package/plugin `0.3.0`.

## Subject and event contract

- Subject grammar `^(state|decision|constraint|preference|pattern)(\.[a-z0-9_]{1,40}){1,4}$`, category prefix
  enforced; invalid proposals become classifier notes, never slots (D-020). Legacy per-fact keys are not semantic
  slots.
- Slot resolution at extraction commit: empty → `ASSERTED`; same normalized text → provenance merge, no event;
  newer evidence with authority ≥ current → `CHANGED` on the same identity (generation CAS); older evidence →
  historical `ASSERTED` (`projection_applied = 0`); tie or lower authority → `CONTRADICTED` candidate. The current
  projection is never overwritten by worker order.
- Event id = `sha256(kind, project, subject, fact, effective_at, previous, new, sources, evidence, reverts,
  outcome)[0:32]`: duplicate delivery and sync replay collapse; same id with different content is a visible
  conflict (`ChronicleConflictError` locally, `malformedRows` on import), never an overwrite.
- Projection kinds (`ASSERTED`, `CHANGED`, `RETIRED`, `RESTORED`) are written inside the same SQLite
  transaction as the projection mutation; event-only kinds (`VALIDATED`, `INCIDENT`, `CONTRADICTED`) reject
  `projection_applied = 1`. Consolidator `DUPLICATE` → no event; `EVOLUTION`/`CONTRADICTION` → temporal judge;
  the consolidator reason is always a classifier note. Rollback links `reverts_event_id`; nothing is deleted.

## Temporal and grounding contract

- `effective_at` = max timestamp of cited authoritative exchanges (`effective_at_source = source`), else the
  worker clock marked `recorded`; replicated rows are marked `peer`. `recorded_at` = commit time. Timelines order
  by `effective_at, recorded_at, chronicle_seq`; `chronicle_seq` and worker order are never history clocks.
- 4B correction: the consolidator's local-clock fallback for a candidate without source time is now labeled
  `recorded` (it was labeled `source`).
- Grounded `problem`/`grounded_cause`/`rationale` are written only when the exact span is present in the cited
  human message or trusted tool result (`verifyGroundedField`, fail-closed) or when actor `user` states the
  rationale. 4B correction: the exchange cited by a grounded field is always added to the event's
  `source_exchange_ids`, so a source-free grounded field cannot exist locally, and the sync importer rejects any
  peer row with that shape (D-022). MCP/CLI render `grounded cause (source-cited)` and
  `classifier note (model inference, NOT authoritative)` on separate lines; `search_facts` revision lines
  render the compatibility `reason` as `note:`.
- Authority rank: `human-decision` 3 > `human` 2 = `trusted-tool` 2 > `unknown` 1. Unknown existing effective
  time is un-ordered (D-021).

## Incident match API (Phase 5 WATCH source)

- `recordIncidentOccurrence(db, {projectId, workspaceId?, workstreamId?, sessionId?, subjectKey?, signatureText,
  summary?, sourceExchangeIds, sourceEvidenceIds?, evidenceAuthority, userFlaggedRepeat?, effectiveAt?, actor})`:
  evidence is verified (trusted `test_execution` results, failures allowed, or a human-authored exchange). 4B
  rules (D-024): a delivery whose exchanges are already cited by an occurrence of the same signature is a
  no-op regardless of session; a same-session retry within 30 minutes coalesces only into an `open`
  occurrence (`retry_count`, exchange ids merged); an episode effective before the verified remediation is
  stored `remediated` and keeps the signature remediated; an episode after it reopens `pattern`.
  `episode_count >= 2` or `user_flagged_repeat` → `pattern`; no-recurrence never resolves.
- `recordIncidentRemediation` accepts only successful trusted test evidence or explicit human confirmation,
  writes `VALIDATED`, marks occurrences with `effective_at <= remediation` as `remediated`.
- `matchIncidentPatterns(db, {projectId, text, limit≤20, includeCandidates?, includeRemediated?, minScore?})`:
  deterministic, bounded (500 newest signatures scanned; normalized substring or token Jaccard ≥ 0.5).
- `listIncidentOccurrences(db, {projectId, signatureKey?, subjectKey?, sessionId?, limit≤100})` keeps
  workstream/session provenance; signatures are project-level (§15.4).
- Other Phase 5 APIs: `readChronicleTimeline` (keyset cursor, `limit ≤ 100`, `kinds`, workspace/workstream/
  session/`projectTruthOnly` visibility), `currentFactRevision` (semantic/lifecycle generation, latest projection
  event, `latestEffectiveAtSource`), `currentEffectiveTime`/`currentEffectiveAt`, `summarizeTelemetry`.

## MCP contract

- `trace_fact` accepts `query | fact_id | subject_key` plus stable scope (`project|workspace|workstream|session|
  global|all`), `include_timeline`, `timeline_limit ≤ 50`, `timeline_cursor`, `timeline_order`,
  `include_incidents`, `include_sources`, `include_hot_evidence`. Lanes: `CURRENT FACT`, `CHRONICLE EVENT`,
  `RAW EVIDENCE`, `ASSISTANT CONTEXT-ONLY`, `HOT EVIDENCE — NOT YET DISTILLED`. Purged sources print
  `source unavailable (purged or missing)`. Out-of-scope facts are errors, never widened.
- 4B correction (D-023): timeline visibility now mirrors `factMatchesScope`: project-wide truth is visible in
  every scope of its project; a workspace/workstream fact's history only inside that scope; event-only rows where
  their evidence lives; `project` scope hides unmerged histories; events on unmerged facts are labeled
  `scope: workstream <id> (unmerged; not project-wide truth)`. Before the fix a workstream-scoped trace hid
  project truth and a sibling workstream's unmerged history could surface.
- CLI: `memex facts history --id <uuid>` and `memex facts explain --subject <key> --project-id <id>` print the
  labeled timeline (4B fixed a `ReferenceError` that made both commands crash after printing, and the
  un-awaited `facts restore`).

## Sync, privacy and telemetry tests

`test/continuity-chronicle-gate.test.ts` (new, 13 tests) plus `test/continuity-chronicle.test.ts` (22 tests):

- Sync two-database matrix: export from device A (3 events) → import on B twice (3 then 0 new rows, counts
  stable); effective-ordered timeline with `peer` marking, grounded cause and classifier note preserved,
  purged/absent source rendered unavailable; same-id conflict from a third device recorded in `malformedRows`
  with local history intact; released 7-field peer row imported as `CHANGED`/`actor=legacy` with the reason as
  classifier note; peer row with a grounded cause and no sources rejects its generation; event tombstone import
  deletes the event, records `chronicle_tombstones`, and device A's still-committed generation cannot replay it.
- Out-of-order generations: the later `CHANGED` arrives before the earlier `ASSERTED` (recorded order proven by
  `chronicle_seq`), the timeline still reads `ASSERTED → CHANGED` by effective time.
- Purge: origin purge → 0 events, 3 event tombstones → export → peer import deletes events, occurrences and the
  fact → a third device replaying the pre-purge snapshot resurrects nothing. Local purge while a job is queued
  (4A l/u) remains covered.
- Telemetry: allowlisted metrics only, `TELEMETRY — MEASURED, NOT A FACT` notice, no fact/event rows (4A).

## Defects found and fixed by 4B

1. `cli/memex.js`: `facts history`/`facts explain` referenced an undefined `revs` after printing (ReferenceError
   on every run); `facts restore` did not await the async restore. Fixed; verified by running both commands.
2. `src/chronicle.ts` `recordChronicleEvent`: a grounded field's exchange was not guaranteed to be in
   `source_exchange_ids`; now unioned (structural GROUNDED CAUSE invariant, basis for D-022).
3. `src/sync-import.ts` `parseRevision`: peer event rows with `problem`/`grounded_cause` and no sources, a
   non-user `rationale` without sources, or `projection_applied = 1` without `fact_id` are schema-invalid
   (generation rejected, visible).
4. `src/chronicle.ts` incidents: null-session duplicate delivery inflated episodes (and produced a second event
   id); retry coalescing could target a remediated occurrence; a late older episode reopened a verified
   remediation. Fixed per D-024.
5. `src/chronicle.ts` `readChronicleTimeline` + `src/mcp-server.ts`: workspace/workstream filters excluded
   project-wide truth and could expose a sibling workstream's unmerged history via evidence membership;
   `project` scope did not hide unmerged histories. Fixed per D-023; unmerged events are labeled.
6. `src/consolidator.ts`/`src/fact-management.ts`: local-clock fallback effective time was labeled `source`;
   `ChronicleMutationContext.effectiveAtSource` added and `currentEffectiveTime` reports the source.
7. `test/fact-management-slice.test.mjs` asserted a UUID-shaped revision id and the released revision row shape;
   the 4A change to content-hashed event ids and `factHistory` returning Chronicle events was not covered by a
   rerun (4A stated the slices were not rerun). Updated to assert the event id, kind, actor, rationale vs note.

## Debt

- `getRevisions` compatibility view flattens `rationale ?? grounded_cause ?? classifier_note` into `reason`;
  `search_facts include_revisions` labels it `note:`. Callers needing the distinction use `trace_fact`/
  `factHistory`. Not a Phase 4 gap; recorded for Phase 5 formatting work.
- Extraction prompt additions (`subject_key`, `change_context`, observation candidates) are validated fail-closed
  but no recorded model fixtures exist; the extraction eval baseline was not re-run in Phase 4.
- A peer that forges a grounded field with a fabricated exchange id passes the structural import guard; the row
  is marked `peer` and never `source` (D-022).
- Incident signatures are project-level; a sibling workstream's independent episode contributes to the project
  pattern (by design, §15.4) with occurrence-level provenance.
- Consolidation candidate search still uses the legacy `exact-project` path scope (Phase 3 debt); the temporal
  judge and event kinds apply regardless.

## Phase 5 blockers

None. Phase 5 may consume `readChronicleTimeline`, `matchIncidentPatterns`, `listIncidentOccurrences`,
`currentFactRevision`, `currentEffectiveTime`, and `summarizeTelemetry` as documented in
`docs/FACT-LIFECYCLE.md` §13 and `skills/remembering-conversations/references/mcp-tools.md`.

## Verification evidence (Prompt 4B, 2026-09-04)

| Command / workload | Independent gate result |
| --- | --- |
| RFC SHA-256 check | `146d9a58…163a` matches; file unmodified |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; `dist` refreshed (bundle 931.9 kB) |
| `npx vitest run` before 4B changes (baseline) | 259 files / 816 tests, failed 0, pending 0, todo 0 |
| `npx vitest run` after 4B changes (JSON reporter) | 264 files / 829 tests, passed 829, failed 0, pending 0, todo 0 |
| `test/continuity-chronicle-gate.test.ts` + `test/continuity-chronicle.test.ts` | 13 + 22 = 35 passed |
| `node --test test/*slice.test.mjs` first run | 93/94; sole failure `fact-management-slice` (4A revision-id/history shape regression, defect 7) |
| `node --test test/*slice.test.mjs` after fix | 94/94; fail 0, cancelled 0, skipped 0, todo 0 (no `listen EPERM` in this environment) |
| `node --test test/inject-daemon-slice.test.mjs` alone | 1/1; skipped 0, todo 0 |
| `node scripts/lifecycle-e2e.mjs --tier offline` | PASS — 9/9 steps; cleanup 7/7 |
| `node scripts/install-e2e.mjs` | PASS — dry-run/install/idempotent rerun/removal/isolation |
| `node scripts/marketplace-e2e.mjs` | PASS — lifecycle surfaces registered; cleanup PASS |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES — CLI 0.153.2 has no formal validator; all installed-artifact substitute checks PASS |
| `node scripts/package-runtime-e2e.mjs` | PASS — `memex-0.3.0.tgz`, 215 files, 9 MCP tools, onboarding, hooks, deferred worker |
| `git diff --check` | clean |
| disabled-test scan (`\.skip|\.todo|xit(`) | no disabled tests (matches are `skipped` result-field assertions only) |
| CLI `memex facts history --id` / `facts explain --subject --project-id` on a seeded temp DB | both print the labeled timeline and `(1 Chronicle events)`; exit 0 |

Expected stderr from negative grounding, stale-CAS, privacy and retry tests was observed. Nothing mandatory was
skipped or left unrun.
