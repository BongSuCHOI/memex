PHASE 1 GATE: PASS

# Phase 1 — Correctness Spine independent gate handoff

Prompt 1B independently audited the implementation, repaired defects, and reran every mandatory
verification. Phase 2 may begin only after the parent commits this handoff and matrix on the Phase 1 code
SHA.

## Repository and lock

- Branch: `feat/memex-continuity-v1`
- Gate-start committed HEAD: `e9cc91ff36f83db6b9836841e4e7624cc3d0f0ea`
- Working tree: Phase 1 code/tests/generated `dist`/owner docs remain uncommitted for the parent.
- Preserved user-owned state: deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` was not restored,
  edited, staged, or otherwise touched.
- RFC source and locked copy SHA-256:
  `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`; byte comparison PASS.
- Worker Prompt Pack SHA-256:
  `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`.

## Schema and migration

- Continuity schema version: `1` in both `PRAGMA user_version` and
  `continuity_schema_meta.schema_version`.
- Additive exchange fields: `exchange_seq`, `content_hash`, `content_generation`, `closure_state`,
  `parser_version`.
- Durable spine: `checkpoints`, `memory_jobs`, `extraction_targets`, `extraction_target_items`,
  `exchange_extraction_state`, `extraction_failed_ranges`.
- State machines include `superseded` for obsolete generations, distinct from processed and
  failed-visible/dead.
- One `BEGIN IMMEDIATE` migration preserves exchange rowid and existing fact, revision, recall, lineage,
  vector, and sync-v4 truth. Eleven injected migration stages roll back and rerun cleanly; repeated startup
  is idempotent.

## Stable Phase 1 APIs

- Exchange/ingest: guarded `insertExchange()`, canonical `ingestArchiveExchanges()`, monotonic
  `ingestPrefixExchanges()`, `refreshExchangeMetadata()`.
- Target/page: `ensureExtractionTarget()`, `readExtractionTargetItems()`, `claimExtractionTarget()`,
  `commitExtractionPage()`, `recordExtractionFailure()`, `supersedeStaleExtractionTarget()`.
- Checkpoint/job: `createCheckpointWithJob()`, `claimMemoryJobById()`, `renewMemoryJobLease()`,
  `completeMemoryJob()`, `failMemoryJob()`.
- Scheduling/readiness: `pendingExtractionCoreQuery(cfg, "continuity")`; default legacy mode exists only
  for read-only pre-migration compatibility and tests.

Phase 2 can reuse checkpoint/job/exchange APIs without adopting the Phase 1 extraction worker as a hook
gateway. Phase 1 intentionally did not add lifecycle hook registration, rolling journal, Capsule,
rehydration, stable workspace/workstream identity, Chronicle, or adaptive recall.

## Invariant evidence

| Invariant | Code boundary | Gate evidence |
| --- | --- | --- |
| EXACT EXTRACTION | immutable target/item snapshot; page commit CAS | concurrent insert remains next target; update/delete commits zero and supersedes |
| NO SAMPLING LOSS | target ordinal cursor; contiguous window prefix | seeded 37-item randomized drain covers `1..37`; cap suffix stays pending |
| ACCOUNTABILITY / NO SILENT LOSS | exact generation state and failed ranges | singleton fingerprint/range, dead target/job/checkpoint; legacy markers never imply coverage |
| OPEN TURN | earliest open/interrupted row fence; generation/hash/closure CAS | open row below legacy live-MAX still blocks later closed rows |
| MONOTONIC INGESTION | separate prefix API and DB guards | CP2 then CP1: zero delete, line/generation regression, or row churn |
| OUTBOX / RECOVERY | transactional checkpoint+job; ordinal partition; lease generation | two half-state crashes, ten duplicate deliveries, stale/expired owner rejection, final-attempt dead range |
| MIGRATION | additive immediate transaction | released-shape fixture, all write stages interrupted/rerun, durable counts/provenance retained |
| AUTHORITY / PRIVACY / SYNC | verifier/provenance lane plus queued-work purge | 259 focused regressions; pending work purged before source; protocol-v4 suites pass |

## Defects found and directly repaired by Prompt 1B

1. Page commit returned a CAS miss after earlier writes, allowing partial target/generation state. Every
   post-write CAS now rolls the transaction back; six page write stages are crash-injected.
2. Target creation and claim updated related rows outside one outer immediate transaction. Target snapshot
   creation and job/target/checkpoint claim are now atomic across connections.
3. Page input could be noncontiguous or differ from durable target rows. Exact identity, ordinal, cursor,
   generation/hash/closure, owner, lease generation, and unexpired lease are revalidated.
4. Stale generation/deletion polluted readiness as failure or lost identity via FK cascade. Obsolete work
   now becomes `superseded`; privacy purge still deletes it transactionally.
5. Final-attempt lease expiry could strand a running job. Recovery now records its exact remaining
   failed-visible range and terminalizes job/target/checkpoint.
6. `failMemoryJob()` accepted an expired owner; late failure now requires an unexpired lease.
7. Same-partition jobs used arrival order and semantic idempotency collisions could reuse unrelated rows.
   Claims now use checkpoint ordinal; mismatched key reuse rolls back.
8. Tool-tail hashing used inconsistent ordering between insert and refresh, causing spurious generations.
9. A deterministic failure on historical context could escape target accounting. Recursive split now
   continues to the target half and records only exact target IDs.
10. A model window returning more than the fact cap silently dropped candidates while completing the page.
    Window results are atomic; the cap applies between windows/runs.
11. Backfill seeded live `MAX(rowid)` from one fact, while legacy `SEED`/`PERMANENT` suppressed unseen
    generations. The seed path was removed; only exact current-generation processed rows prove completion.
12. An open exchange below a legacy watermark did not fence later closed rows. Target formation now applies
    the earliest open/interrupted fence before compatibility markers.

## Verification receipts

| Command / matrix | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; generated `dist` refreshed |
| Phase 1 focused suites | PASS — 6 files / 81 tests |
| authority/provenance/privacy/sync/MCP/ontology focused regression | PASS — 14 files / 259 tests |
| `npm test` final | PASS — 71 files / 721 tests |
| `node --test test/codex-slice.test.mjs` | PASS — 24/24, skipped 0, todo 0 |
| `node --test test/*slice.test.mjs` in managed sandbox | 92/93; only inject-daemon Unix socket `listen EPERM`; skipped 0, todo 0 |
| exact `node --test test/inject-daemon-slice.test.mjs` outside sandbox | PASS — 1/1, skipped 0, todo 0 |
| isolated `node --test test/reliability-slice.test.mjs` after fixture correction | PASS — 4/4 |
| static disabled-test scan and `git diff --check` | PASS; no `.skip`, `.only`, `.todo`, or whitespace errors |

Intermediate failures were not hidden. The first full run was 700/721 because legacy-only query fixtures
lacked Continuity tables and one old completion fixture lacked exact generation state. Compatibility mode
and the exact fixture were added, then the final 721/721 passed. The first aggregate slice rerun exposed a
one-exchange fixture below the configured two-exchange worker gate; it was corrected to two exchanges and
the isolated reliability suite passed. The remaining aggregate failure is the documented managed-sandbox
Unix socket denial; the exact outside-sandbox rerun passed.

Expected stderr from negative provider, stale-CAS, and privacy-race tests was observed; no test was skipped.

## Deviations, debt, and Phase 2 boundary

- D-005: transitional rowid fence plus immutable generation snapshot remains the Phase 1 design.
- D-006: raw EOF cannot fully type event-grounded assistant-only `final` versus interruption. Phase 2 must
  normalize installed runtime lifecycle payloads; generation CAS protects Phase 1.
- D-007: legacy extraction markers are compatibility hints only; exact missing generations are reprocessed.
- D-008: obsolete source generations use `superseded`; target item identity is non-FK with purge-atomic
  deletion.
- Non-blocking debt: `extraction_log`, legacy claim SQL, and legacy readonly scheduling mode remain for the
  support window. They are not production completion authority.
- Phase 2 blocker: none from Phase 1 correctness. D-006 and RFC lifecycle/capture requirements are mandatory
  Phase 2 work, not waived by this PASS.
