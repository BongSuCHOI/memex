PHASE 5 GATE: PENDING (5A implementation handoff; independent 5B gate not yet run)

# Phase 5 — Adaptive Recall & Product Calibration implementation handoff

Prompt 5A implemented the pre-retrieval cheap gate, revision-aware delta/correction on the prompt path, the
Memory Bundle with deterministic ranking and hard budgets, intent-gated graph/TRACE expansion, verified-only
WATCH, the demoted assistant lane, measured metrics, and a reproducible calibration harness with a committed
result artifact. MCP deep exploration is unchanged. Nothing here weakens a Phase 1–4 invariant.

## Repository and lock

- Branch: `feat/memex-continuity-v1`
- Phase 5A base HEAD: `2b6635e` (Phase 4 gate closure)
- Final RFC SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Continuity schema: `6` (was `5`; additive `session_memory_state` gate columns, stage `recall-gate-columns`);
  sync protocol: `4`; package/plugin: `0.3.0`
- Runtime: Node `v26.0.0`, macOS arm64. Implementation session: Claude Code (D-017).
- Preserved user-owned state: deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` remains untouched.

## Gate rules, thresholds, config

`src/recall-gate.ts` — `decideRecall()` runs before any embedding/vector/graph/model work and never calls an
LLM. Decision order and defaults (`DEFAULT_RECALL_GATE_CONFIG`, D-027):

| # | Rule | Result |
| --- | --- | --- |
| 1 | explicit memory intent (KR/EN why/when/history/source/previous/again/기록/출처/왜/이전…) | retrieve, regardless of length |
| 2 | verified incident signature match; `project.memory_revision > seen`; Capsule generation changed | retrieve |
| 3 | acknowledgement/continuation lexicon (≤ 4 tokens); short minor correction | skip (0 embeddings) |
| 4 | context epoch changed / compact first prompt / first substantive prompt in epoch | retrieve (+ WORK NOW) |
| 5 | high-impact intent; safety refresh after 6 substantive prompts | retrieve |
| 6 | topic drift: Jaccard(prompt tokens, topic fingerprint) < 0.12 with ≥ 5 tokens | retrieve |
| 7 | low resident coverage: ≥ 8 tokens and no overlap with resident fact vocabulary | retrieve |
| 8 | short prompt overlapping the topic (≥ 0.3) or substantive prompt strongly overlapping (≥ 0.35) | skip (0 embeddings) |
| 9 | otherwise ambiguous: one embedding, reused for retrieval; coherent when `cos(prompt, topic) − baseline ≥ 0.08` | skip or retrieve (`embedding_drift`) |

Session state (schema v6): `topic_fingerprint_json`, `topic_embedding`, `informative_prompts_since_retrieval`,
`last_retrieval_epoch`, `last_retrieval_at`, `resident_bundle_hash`, `watch_emitted_json`. New sessions start
with `memory_revision_seen` = current project revision (D-026). `computeInjectContext(..., { gate: false })`
is the calibration baseline only.

Embeddings unavailable: skip paths cost nothing; the retrieve path degrades to CORRECTION / WORK NOW / WATCH /
RECENT EVIDENCE without throwing (`gate: retrieve:…+embeddings_unavailable`). Retrieval/index failure returns
`""`, logs `error`, and leaves residency and receipts untouched.

## Delta, correction, Memory Bundle

- Resident identity `(fact_id, semantic_generation, lifecycle_generation)`; identical revision → suppressed
  (`deduped`, `repeated_context_turns`); same fact newer generation → `[MEMEX CORRECTION] Updated (supersedes
  earlier context)`; resident fact deactivated → `No longer active`; inactive facts never enter CURRENT TRUTH;
  candidate search is workstream-scoped so sibling-workstream/workspace facts are never injected.
- Stale project revision keeps the Phase 3 path (`buildRehydrationContext` correction before semantic results,
  bounded drain, scalar seen only when complete).
- `src/memory-bundle.ts`: fixed section order CORRECTION > WORK NOW > CURRENT TRUTH > WATCH > TRACE >
  RECENT EVIDENCE > ASSISTANT CONTEXT; per-section item caps; deterministic truncation; budgets normal
  target 700 / hard 1,000 chars (line 160), rehydration target 1,500 / hard 2,000. Rendering reports exactly
  which items were emitted; only emitted revisions become resident.
- Graph 1-hop expansion only on why/related/dependency/contradiction/trace intent.

## WATCH, TRACE, assistant, MCP

- WATCH uses Phase 4 `matchIncidentPatterns` (patterns only: independent episodes ≥ 2 or user-flagged;
  candidates/remediated excluded), bounded to 2, with a per-session TTL of 5 substantive prompts unless the
  signature recurred; emission is counted (`watch_emissions`). Assistant similarity never creates WATCH.
- TRACE on why/history/source intent points at the Chronicle (`N events, latest KIND effective DATE, use
  trace_fact subject_key=…`) instead of injecting history.
- The assistant repeat lane is demoted to `[ASSISTANT CONTEXT-ONLY — NOT AUTHORITATIVE]`, emitted only when no
  current truth or correction exists and the user explicitly asks about memory; it always renders after
  current truth.
- MCP `trace_fact`/`search_facts` are untouched by gate skips (test v).

## Metrics and calibration

Telemetry allowlist extended (`TELEMETRY_METRICS`): `retrieval_gate_skip_count`(reason),
`retrieval_execute_count`(triggers), `embedding_calls`, `candidate_facts`, `current_facts`, `delta_facts`,
`injected_facts`, `injected_chars`, `section_chars`(section), `bundle_size`, `estimated_tokens`,
`correction_count`, `correction_delay_prompts`, `watch_emissions`, `watch_confirmed`,
`project_revision_invalidations`, `repeated_context_turns`, `mcp_trace_success`, worker metrics. Test w proves
`embedding_calls` equals the mocked model call count and `retrieval_execute_count + retrieval_gate_skip_count`
equals the prompt count.

`node scripts/continuity-recall-benchmark.mjs` (`npm run bench:recall`) runs the Prompt 5B workloads
(follow-up-heavy, ack-heavy, topic-shift-heavy, explicit history/source, same-fact evolution/rollback/
correction, 200-turn compaction-heavy, same project different workstreams with a planted EXPERIMENTAL fact,
incident recurrence/no recurrence/false signature, embeddings unavailable) twice — baseline (gate off) and
gated — on the deterministic embedding stub (D-025) and writes
`docs/verification/continuity-v1/recall-calibration.json`.

| Measure (340 prompts) | Baseline | Gated |
| --- | --- | --- |
| retrievals | 340 | 126 (−62.9%) |
| embedding calls | 337 | 209 |
| ack-prompt embedding calls | 73 | 0 |
| injected chars | 11,357 | 9,864 |
| stale / wrong-workstream injections (gated) | — | 0 / 0 |
| mandatory memory-intent misses (gated, 18 intents) | — | 0 |
| corrections seen / expected | — | 2 / 2 |
| WATCH seen / expected, false positives, TTL suppressions | — | 1 / 1, 0, 1 |
| assistant above current truth | — | 0 |
| max bundle chars | — | 514 (hard cap 1,000 / 2,000) |
| MCP trace success / timeline bounded | — | true / true |

The stub numbers are call and byte counts, not time or money savings. Production-model thresholds must be
re-measured by 5B. Product A/B (plugin-less / pre-continuity / final) cannot be automated in this environment;
the manual protocol is: same repository, same 3 tasks (resume after compaction, cross-session decision recall,
incident recurrence), record background re-explanation turns, turns to first correct tool action, duplicate
file/test work, stale or wrong-scope injections, retrievals and injected chars per 100 prompts from
`continuity_telemetry`, WATCH precision from `watch_emissions`/`watch_confirmed`, and MCP source/history
success — the harness supplies B-vs-C counts for the automated subset.

## Tests and results (5A self-report; 5B must re-verify)

- `test/continuity-recall.test.ts` (17 tests): a ack/continue embeddings 0; b short explicit memory question;
  c/f/g/h first-in-epoch, drift, coverage, safety refresh, lexical coherent skip; d/i Capsule generation and
  compact first prompt render WORK NOW; e stale project revision correction; j/k/l same revision suppressed /
  new generation correction / inactive retraction; m workstream isolation; n/o deterministic bundles and hard
  caps; p intent-gated graph; q/r verified WATCH only, TTL, no assistant WATCH; s stale assistant below
  truth + TRACE; t embeddings unavailable; u retrieval failure; v MCP unaffected; w metrics exactness;
  x 150-turn synthetic workload; rehydration cap.
- Existing suites adjusted: `test/inject-write-ordering.test.ts` mocks (`readWorkCapsule`, chronicle),
  `test/continuity-correctness-spine.test.ts` stage list (`recall-gate-columns`),
  `test/continuity-chronicle.test.ts` schema version 6.
- `npm run typecheck` PASS; `npm run build` PASS; harness verdict all true; full `vitest run` result recorded
  in the commit message of the 5A commit (5B reruns everything).
- Not rerun in 5A: `node --test` slices, lifecycle/package/install/marketplace E2E scripts.

## Phase 5B focus risks

1. Threshold calibration on the real e5 model (baseline-relative margins were tuned on the stub).
2. The lexical coherent skip (rule 8) could suppress an important substantive follow-up that shares vocabulary;
   safety refresh (6) bounds the delay — 5B should probe false negatives with important short prompts.
3. WATCH TTL is keyed on `informative_prompts_since_retrieval` snapshots; a signature recurring inside the TTL
   window re-emits only when `lastEffectiveAt` advances.
4. Stale-project-revision corrections still bypass the Memory Bundle renderer (Phase 3 path, 1,000-char cap);
   two corrections in one prompt are ordered by that path, not by `memory-bundle.ts`.
5. `buildRehydrationContext` (SessionStart compact/resume) keeps its Phase 3 section renderer; only its budget
   (2,000) matches `REHYDRATION_BUNDLE_BUDGET`.
6. `scripts/inject-context.js` previously dropped prompts shorter than 20 characters before the core ran; 5A
   removed that floor so short explicit memory questions reach the gate (only empty prompts return early).
   The cold fallback path now imports the core for every prompt; the gate keeps the model unloaded on skips,
   but 5B should confirm cold-path latency on acknowledgements stays acceptable.
