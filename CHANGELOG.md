# Changelog

All notable changes to Memex are documented here. Dates use Asia/Seoul.

## Unreleased

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
