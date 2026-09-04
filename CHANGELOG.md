# Changelog

All notable changes to Memex are documented here. Dates use Asia/Seoul.

## Unreleased

### Memex Continuity Architecture v1

Normative target: `docs/architecture/memex-continuity-v1.md` (SHA-locked). As-built map:
`docs/CONTINUITY.md`. Deviations: `docs/verification/continuity-v1/rfc-deviations.md` (D-000–D-036).
Final gate: `docs/verification/continuity-v1/final-integration-gate.md`.

#### Added

- Rolling journal + hash-verified checkpoints with an atomic outbox and a durable
  priority queue (`capture_index` → `capsule_update` → exact extraction), detached
  worker wake, lease/retry/dead-visible states, and capture-gap recovery.
- Exact extraction spine: immutable ordered targets, contiguous cursor, generation
  reprocessing for grown exchanges, exact failed ranges (no sampling loss).
- Work Capsule (typed, context-only) with generation CAS and a deterministic tail
  baton; immediate `SessionStart(compact|resume)` rehydration without PostCompact.
- Stable `project_id → workspace_id → workstream_id → session_id` identity with
  additive migration, explicit link/split/remote approval, conservative workstream
  binding, promotion slots, project `memory_revision` invalidation, Hot Evidence lane.
- Chronicle: `fact_revisions` extended into the append-only event history (7 kinds,
  content-hashed idempotent ids, `effective_at` vs `recorded_at`, grounded cause vs
  classifier note, rollback linkage), subject-slot resolution at extraction, incident
  episodes/patterns/remediation with a bounded match API, `trace_fact` timeline
  pagination, `memex facts history|explain`.
- Adaptive recall: lexical pre-retrieval gate (no LLM), single reused embedding on
  the ambiguous path, revision-aware delta/correction, deterministic Memory Bundle
  under hard budgets, verified-only WATCH, TRACE pointers, demoted assistant lane,
  measured telemetry, `npm run bench:recall` calibration harness and artifact.

#### Changed

- Continuity schema `6` (`PRAGMA user_version`), additive and rerunnable; sync
  protocol stays `4` with additive stable-identity, Chronicle event and event
  tombstone rows (older peers reject such generations visibly).
- Extracted facts default to `workstream` scope; `decision`/`project-current`
  truth requires explicit evidence-bearing promotion (BRANCH TRUTH).
- `PostCompact` is registered as telemetry only; correctness never depends on it.
- New sessions start at the current project memory revision; short explicit memory
  questions reach the gate (the 20-character hook floor was removed).
- Consolidator verdicts pass a source-effective temporal judge; its reason is a
  classifier note, never a grounded cause.

#### Fixed

- Concurrent `initDatabase()` could fail with `trigger exchanges_fts_au already exists`.
- Paged extraction jobs could block capture indexing in the same session partition.
- A Work Capsule sourced from a purged session could survive privacy purge.
- Sibling changes to workstream-scoped resident facts were not corrected on
  acknowledgement prompts.

#### Migration notes

- First run after upgrade performs the v1→v6 additive migration inside one immediate
  transaction; interrupted migrations resume. No manual step is required.
- `session-end-hook.js` remains as a final-fence alias; plugin registration uses
  `continuity-hook.js`. Legacy path queries and extraction markers remain read-only
  compatibility surfaces.

#### Rollback notes

- Older plugin versions ignore the new tables/columns; the DB does not need to be
  downgraded. Older sync peers reject new-shape generations rather than importing
  them partially. Restore a pre-upgrade DB backup only if a full revert is required.

#### Known limitations

- Cost figures are counts of calls and bytes (calibration on the deterministic
  embedding stub plus a 20-pair real-model spot check); no time or money savings are
  claimed. Production-model calibration replay and the product A/B remain manual.
- `SessionStart(resume|compact)` rehydration still uses the Phase 3 scope-wide
  correction list; the prompt path is residency-derived.
- Formal `codex plugin validate` is unavailable in CLI 0.153.2; substitute checks apply.

## 0.3.0 - 2026-09-03

### Added

- Added bounded semantic context windows and long-range referent retrieval for
  deictic approvals, workflow adoption, and cross-language fact extraction.
- Added local `fact_context_dependencies` for persisted long-range interpretive
  lineage, separate from authoritative `source_exchange_ids`.
- Added curated legacy/P2 real-model evaluation fixtures, rejection telemetry,
  archive-shadow methodology, and merge-gate evidence.
- Added Fact Detail and `trace_fact` surfaces that distinguish authoritative
  provenance from non-authoritative context.

### Changed

- Fact scope now follows durable applicability instead of conversation location.
- The semantic verifier reports the context it used; server validation
  canonicalizes the minimal persisted dependency set and rejects malformed,
  unknown, duplicate, overlapping, or out-of-pool usage.
- Immediate local context remains transient while persisted historical context
  participates in consolidation, privacy purge, and local lifecycle handling.
- Tier-C repeated-signal inference is limited to the same session's current
  authoritative extraction window; assistant and recall text remain context-only.

### Fixed

- Prevented assistant, recall, negative ratification, and translated-text paths
  from laundering unsupported claims into durable facts.
- Preserved semantic antecedents across watermark and extraction-window
  boundaries without promoting historical context to authority.
- Improved open-vocabulary recommendation, workflow, sequence, and original
  choice resolution while retaining fail-closed ambiguity handling.
- Removed local/historical referent duplication and stale dependency telemetry.

### Verification

The authoritative release evidence is stored in
`docs/verification/merge-gate.json`. Known real-model and archive quality limits
remain recorded as `PASS-WITH-NOTES`; hard authority and leakage checks remain
release blockers.

## 0.2.0 - 2026-08-31

### Added

- Added `memex home [--json]` to print the resolved Memex data root.
- Added opt-in terminal CLI shim management through
  `memex setup --install-cli` / `--uninstall-cli`.
- Added `memex backfill all` for sequential extract → ontology → embeddings
  onboarding with idempotent retry behavior.
- Added durable multi-device sync protocol v4 with committed generations,
  integrity manifests, tombstones, and recall receipts.
- Added independent semantic and lifecycle generations/clocks for durable facts.
- Added local taxonomy epoch invalidation so in-flight classification cannot
  recreate taxonomy after a privacy purge.
- Added guarded manual KR fact translation with strict batch validation and
  semantic CAS.

### Changed

- Fact reconciliation now treats **semantic**, **lifecycle**, and **lineage** as
  independent axes instead of allowing one winner row to overwrite unrelated
  state.
- Cross-device lineage is monotonic: source exchange IDs are unioned and
  consolidated counts use max, including brand-new remote inserts.
- Replicated deactivate/restore events preserve their original remote event
  timestamps and are revalidated at commit time.
- Consolidation now discards stale model verdicts when either participant's
  semantic or lifecycle generation changes.
- Ontology, relations, KR translations, and vectors are local-derived state and
  are excluded from the durable sync payload.
- Privacy conversation exclusion now invalidates taxonomy state, resets
  surviving classification attempts, and prevents stale peers from resurrecting
  excluded facts.
- Sync import is fail-closed at the generation boundary: required files,
  manifest hashes, strict row shape, and identity are validated before DB
  mutation.
- Export serialization now uses the local SQLite database's process-owned
  `BEGIN IMMEDIATE` transaction instead of a cloud-synced lockfile.
- Exchange and fact-derived embedding/classification writers use commit-time
  CAS/content revalidation to discard stale async results.
- `memex backfill <target>` runs in the foreground by default; background mode is
  explicit.
- Data-root resolution is consistently `MEMEX_HOME` →
  `$XDG_CONFIG_HOME/memex` → `~/.config/memex`.
- Public README, Korean README, contributor rules, and owner documentation were
  refreshed around the current protocol v4 architecture and operating model.

### Fixed

- Fixed remote→remote reconciliation where the semantic winner could
  accidentally replace an independently newer lifecycle state.
- Fixed replicated lifecycle events being stamped with local wall-clock time.
- Fixed same-state newer lifecycle clocks being ignored.
- Fixed stale lifecycle/consolidation operations committing after concurrent
  deactivate/restore races.
- Fixed fresh sync imports dropping provenance collected from non-winning peer
  rows.
- Fixed stale ontology classification recreating taxonomy after privacy purge.
- Fixed privacy purge leaving ontology retry state permanently exhausted.
- Fixed stale KR translations attaching to facts whose meaning changed during
  translation.
- Fixed export-lock ownership/stale-break races by removing the sync lockfile
  design.
- Fixed generation/reader integrity paths that could otherwise observe or apply
  partial sync state.

### Verification

The release gate covers:

- Typecheck: PASS
- Build: PASS
- Vitest: 68 files / 598 tests PASS
- Codex slice: 23/23 PASS
- All Node slices: 91/91 PASS
- Install E2E: PASS
- Marketplace E2E: PASS
- Package-runtime E2E: PASS
- Lifecycle E2E: PASS

The raw release-candidate evidence is stored at
`docs/verification/merge-gate.json`. Its `candidate.codeSha` is the only
authoritative commit attribution; it is regenerated from the final clean
committed baseline before release.

## 0.1.0 - 2026-08-27

First independent public Memex release.

### Highlights

- Codex-native ingestion of `$CODEX_HOME/sessions` rollout JSONL with
  canonical project identity and read-only source handling.
- Local conversation archive with vector, FTS5/BM25, and hybrid search.
- Incremental durable fact extraction with provenance, confidence gating,
  consolidation, revisions, and retry-safe watermarks.
- Evidence-level trust model that keeps Memex recall and assistant synthesis
  searchable without allowing self-reinforcing fact extraction.
- Domain/category ontology, typed relations, scoped graph traversal, and
  cross-project insights.
- Bounded UserPromptSubmit context injection with relevance filtering and
  per-session deduplication.
- Nine MCP tools and three bundled Codex skills.
- Loopback-only Web UI with conversations, facts, pipeline health, and 3D
  Knowledge Galaxy.
- Codex plugin marketplace installation, plugin-managed lifecycle hooks,
  isolated runtime launcher, setup/update/doctor flows, and explicit fallback
  hook management.
- Project/global/all scope enforcement across CLI, MCP, graph traversal,
  retrieval, UI, and import surfaces.
- Isolated installer, lifecycle, MCP, browser, cleanup, packaging, and
  performance verification infrastructure.

Memex `0.1.0` is intentionally pre-1.0: the product is usable and substantially
tested, while public marketplace and Codex host-adapter contracts may still
evolve.

## Project lineage

Memex continues the MIT-licensed knowledge-system lineage of
[`obra/episodic-memory`](https://github.com/obra/episodic-memory) and
[`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank), while
replacing the previous host adapter with a Codex-native implementation.

See [docs/LINEAGE.md](docs/LINEAGE.md) for attribution and migration context.
