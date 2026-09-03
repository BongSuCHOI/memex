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
