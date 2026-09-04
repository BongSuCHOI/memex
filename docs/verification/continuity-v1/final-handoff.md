MEMEX CONTINUITY ARCHITECTURE V1: IMPLEMENTATION COMPLETE

# Final handoff — Memex Continuity Architecture v1

Every mandatory gate is PASS: Phase 1B, 2B, 3B, 4B, 5B and the Final Integration gate (F1). Prompt F2 closed
the release with as-built documentation, operations/upgrade/rollback notes, changelog, the final traceability
matrix and deviation record, and a full smoke rerun. No code changed in F2.

## Final status

| Item | Value |
| --- | --- |
| Status | `MEMEX CONTINUITY ARCHITECTURE V1: IMPLEMENTATION COMPLETE` |
| Branch | `feat/memex-continuity-v1` |
| Code revision | `8d32dfd` (Final Integration gate PASS); F2 adds a documentation-only commit on top |
| Working tree at handoff | clean except the user's own uncommitted deletion of `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md`, which was never staged, restored or touched |
| Final RFC SHA-256 | `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a` (`docs/Memex Continuity Architecture v1 - FINAL RFC.md` == `docs/architecture/memex-continuity-v1.md`; `rfc-lock.json` unchanged; RFC never modified) |
| Worker Prompt Pack SHA-256 | `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3` |
| Continuity schema | `6` (`PRAGMA user_version`, `continuity_schema_meta`), additive v1→v6, crash-injected and rerunnable |
| Sync protocol | `4` (five files; additive stable identity, Chronicle event and event tombstone rows) |
| Package / plugin | `0.3.0` in `package.json` (bump not performed — see checklist); packaged `memex-0.3.0.tgz`, 223 files, 9 MCP tools |
| Runtime verified | Codex CLI `0.153.2` (contract from `0.150.1`), Node `v26.0.0`, macOS arm64 |

## Gate and commit sequence

| Gate | Result | Commit |
| --- | --- | --- |
| Phase 0 baseline / RFC lock | recorded | `e9cc91f` |
| Phase 1A + 1B (Correctness Spine) | PASS | `61501c1` |
| Phase 2A + 2B (Continuity Core) | PASS | `db548d2` |
| Phase 3A + 3B (Identity) | PASS | `5ec4909` |
| Post-gate Phase 3 defect (FTS trigger race) | fixed | `b591aa3` |
| Phase 4A (Chronicle) / 4B | PASS | `3b798a9` / `2b6635e` |
| Phase 5A (Adaptive recall) / 5B | PASS | `e588712` / `0854797` |
| Final Integration (F1) | PASS | `8d32dfd` |
| Release closure (F2) | docs only | this commit |

## Invariant PASS table (RFC §19)

All 22 invariants are PASS at the Final Integration gate; the end-to-end evidence per invariant is the table in
`final-integration-gate.md` (§"Invariant table") and the per-row "Latest gate" column of
`traceability-matrix.md`. Mandatory zero counts measured by `test/continuity-final-integration.test.ts`:
unaccounted closed exchanges 0 · checkpoint prefix hash mismatch 0 · cursor overrun 0 · silent skipped pages 0 ·
duplicate authoritative Chronicle event 0 · cross-project injection 0 · wrong-workstream injection 0 · unmerged
project-current promotion 0 · purged memory resurrection 0 · compact rehydration miss 0 · stale fact correction
failure 0 · ungrounded cause authoritative 0 · PostCompact dependency failure 0.

## Tests and benchmarks (F2 final smoke, 2026-09-04, run on `8d32dfd` + docs)

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS (`dist` identical to the committed build) |
| `npx vitest run` | 273 files / 857 tests — passed 857, failed 0, pending 0, todo 0 |
| `node --test test/*slice.test.mjs` | 94 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo (no `listen EPERM`) |
| `node scripts/lifecycle-e2e.mjs --tier offline` | PASS 9/9 steps; cleanup 7/7 |
| `node scripts/install-e2e.mjs` | PASS — dry-run, real install, idempotent rerun, removal, isolation |
| `node scripts/marketplace-e2e.mjs` | PASS; cleanup PASS |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES — formal `codex plugin validate` absent in CLI 0.153.2; all substitute checks PASS; receipt rewrite (timestamp/temp path only) restored |
| `node scripts/package-runtime-e2e.mjs` | PASS — `memex-0.3.0.tgz`, 223 files, 9 MCP tools |
| `node scripts/continuity-recall-benchmark.mjs` | all 9 verdicts true; 365 prompts: retrievals 365 → 142 (−61.1%), embedding requests 370 → 224, acknowledgement embeddings 85 → 0, duplicates 0, max bundle 432 chars; artifact unchanged apart from timestamp (restored) |
| `git diff --check`, disabled-test scan | clean; 0 `.skip/.todo/xit` |

Performance figures (hook latency p50 7.3 / p95 13.1 ms, 200 turns captured in 1.86 s and drained in 3.30 s,
journal amplification 1.0, `trace_fact` 50-event pages 10.8 / 4.5 ms) are in `final-integration-gate.md`.
Cost figures are counts of calls and bytes; no time or money savings are claimed (RFC §15.5).

## Install, upgrade, rollback

- Clean install: `docs/GUIDE.md` §2–5 (plugin install, onboarding, hooks); verified by `install-e2e` and
  `marketplace-e2e` including hook setup idempotency.
- Upgrade: first run migrates the DB to schema `6` additively inside one immediate transaction; interrupted
  migrations resume (`docs/GUIDE.md` §15, `CHANGELOG.md` migration notes).
- Rollback: older plugin versions ignore the new tables/columns; the DB needs no downgrade; older sync peers
  reject new-shape generations visibly; restore a pre-upgrade backup only for a full revert (`GUIDE.md` §15).

## Runtime contract

Lifecycle events, matchers, timeouts and what each hook never waits for: `docs/CONTINUITY.md` §1;
`hooks.json` registers `SessionStart(startup|resume|clear|compact)`, `UserPromptSubmit`, `Stop`, `Interrupt`,
`PreCompact(manual|auto)`, `PostCompact(manual|auto, telemetry only)`, `SessionEnd`, all through
`cli/runtime-exec.js` pinned to the installed artifact (D-013). Hook output is the Codex
`hookSpecificOutput.additionalContext` JSON shape; capture hooks emit nothing on stdout and never call a
model or embedding.

## Diagnostics and operations

`docs/GUIDE.md` §13 (doctor/status/E2E) and §15 (worker start/recovery, backlog/retry/dead-letter,
journal/checkpoint integrity, capture gaps, project link/split, workstream rebind, Capsule/current
fact/Chronicle diagnostics via `memex facts history|explain` and MCP `trace_fact`, privacy purge, rollback,
compatibility surfaces). Environment flags: `docs/CONTINUITY.md` §10.

## Known limitations

- Extracted facts default to `workstream` scope; project-wide `decision`/`project-current` truth requires
  explicit evidence-bearing promotion (`assignFactSubject`); sync exports only promoted/legacy project facts.
- `SessionStart(resume|compact)` rehydration still emits the Phase 3 scope-wide correction list; the prompt
  path is residency-derived (Phase 5B debt).
- Gate thresholds were calibrated on the deterministic embedding stub plus a 20-pair real-model spot check
  (D-027); a real-transcript replay on the production model and the product A/B remain manual protocols.
- Formal `codex plugin validate` is unavailable in CLI 0.153.2; substitute installed-artifact checks apply.
- Project link/split, remote approval and workstream rebind are library APIs (no dedicated CLI verbs).
- Sync import has no crash seam; recovery relies on pinned generations and idempotent re-import.
- The authenticated lifecycle tier was last run in Phase 2B; F1/F2 ran the mandated offline tier plus
  install/marketplace/package E2E.

## Non-blocking future ideas and explicit non-scope

Future (not required by the RFC): CLI verbs for link/split/rebind, production-model calibration replay,
`buildRehydrationContext` on the Memory Bundle renderer, watch precision feedback (`watch_confirmed`)
collection, sync import crash seam. Explicit non-scope (RFC §23): per-turn LLM summaries, model calls in
capture hooks, every-prompt embedding, all-history injection, latest-session restore, basename/remote
auto-merge, unmerged branch promotion, full event-sourced DB, CRDT, external broker/vector DB, assistant answers
as evidence, automatic global promotion, unmeasured ROI facts, task manager, PostCompact dependency.

## Final deviation list

D-000–D-037 in `rfc-deviations.md`. Phase 4–F2 additions: D-017 (Claude gate runner), D-018 (Chronicle =
extended `fact_revisions`), D-019 (event tombstone rows), D-020 (legacy subject keys), D-021 (unknown effective
time un-ordered), D-022–D-024 (4B: peer grounded fields, timeline visibility, incident ordering), D-025
(embedding stub seam), D-026 (new-session revision seen), D-027 (gate thresholds), D-028–D-033 (5B
corrections), D-034–D-036 (F1 corrections), D-037 (release closure keeps compatibility surfaces).

## User checklist before publish

1. Review the branch: `git log --oneline e9cc91f^..HEAD` (logical per-phase commits, gates committed
   separately). The user-owned deletion of `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` is still uncommitted —
   commit or restore it deliberately.
2. Decide the version: recommended `0.4.0` (additive schema v6, new sync row shapes, new CLI subcommand
   `facts explain`, changed default extraction scope). Suggested commands, to run only after approval:
   `npm version minor --no-git-tag-version`, move the `Unreleased` CHANGELOG section under `## 0.4.0 - <date>`,
   commit `chore(release): prepare v0.4.0`, then `git tag v0.4.0`.
3. Optionally rerun the authenticated lifecycle tier on the release candidate
   (`node scripts/lifecycle-e2e.mjs --tier authenticated`) and a real-transcript calibration replay.
4. Merge/push only after review: `git push origin feat/memex-continuity-v1`, open the PR to `main`, and push
   the tag after merge. None of these were executed.
