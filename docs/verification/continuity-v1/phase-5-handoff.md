PHASE 5 GATE: PASS

# Phase 5 — Adaptive Recall & Product Calibration gate handoff

Prompt 5B independently traced the Phase 5A cheap gate, delta/correction, Memory Bundle, WATCH/TRACE, assistant
lane, metrics and calibration harness against the Final RFC, instrumented the real prompt path (no mocked
embedding module) with two-session, two-workstream, compaction and feature/main cases the 5A suite did not
cover, re-measured the reproducible workload, spot-checked the production embedding model offline, and fixed
every defect found directly. Every Prompt 5B PASS condition holds on the corrected working tree: no-op path
expensive calls 0, mandatory memory intents recalled, compaction/multi-session continuity preserved,
stale/wrong-scope/duplicate injection 0 in the covered matrix, corrections correct, hard budgets respected,
WATCH authority safe, MCP deep path unchanged, metrics equal to real calls and bytes, the reproducible workload
and the entire test suite pass, and no test is skipped or placeholder.

## Gate, revision and lock

- Branch: `feat/memex-continuity-v1`
- Phase 5A HEAD reviewed: `e588712b54abde9a638fdfde4c8c20dedabf87e2`; 5B corrections are uncommitted in the
  working tree for the parent's Phase 5 closing commit.
- Final RFC SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a` (verified before and after
  the gate, unmodified)
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Gate runtime: Claude Code general-purpose subagent (D-017), Node `v26.0.0`, Codex CLI `0.153.2`, macOS arm64.
- Continuity schema `6` (unchanged by 5B; column semantics clarified in `docs/SCHEMA.md`), sync protocol `4`,
  package/plugin `0.3.0`.
- Preserved user-owned state: the uncommitted deletion of `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` was not
  staged, restored, or touched. `docs/verification/plugin-validation.json` was rewritten by `validate-plugin`
  with timestamp/temp-path noise only and restored to the committed version.

## Gate rules, thresholds, config

`src/recall-gate.ts` `decideRecall()` runs before any embedding, vector search, relation expansion or model
call and never calls an LLM. 5B changed the decision order (state triggers before the acknowledgement
lexicon), removed the "no fingerprint → skip" rule, widened the KR/EN acknowledgement lexicon, and added
Korean suffix stripping to the fingerprint tokenizer. Every numeric threshold is unchanged
(`DEFAULT_RECALL_GATE_CONFIG`, D-027).

| # | Rule | Result |
| --- | --- | --- |
| 1 | state trigger: explicit memory intent; verified incident match; `project.memory_revision > seen`; Capsule generation changed; context epoch changed (compact/clear first prompt, first prompt in epoch) | retrieve, regardless of length or acknowledgement |
| 2 | acknowledgement/continuation (≤ 4 tokens), short minor correction | skip, 0 embeddings |
| 3 | high-impact intent; safety refresh after 6 substantive skips | retrieve |
| 4 | topic drift: Jaccard(prompt, fingerprint) < 0.12 with ≥ 5 tokens | retrieve |
| 5 | low resident coverage: ≥ 8 tokens, no overlap with resident fact vocabulary | retrieve |
| 6 | short prompt overlapping the topic (≥ 0.3) or substantive prompt strongly overlapping (≥ 0.35) | skip, 0 embeddings |
| 7 | otherwise: one embedding, reused for retrieval; coherent when `cos − baseline ≥ 0.08`; no topic embedding → retrieve | skip or retrieve |

Acknowledgements that reach rule 1 are vector-free retrievals (`needsVector` false in `src/inject-core.ts`):
no embedding, no fact search, fingerprint untouched; they render WORK NOW, corrections, WATCH and sibling
evidence only. Session state columns: `topic_fingerprint_json`, `topic_embedding`,
`informative_prompts_since_retrieval`, `last_retrieval_epoch`, `last_retrieval_at` (also the Hot Evidence
watermark: NULL on epoch change, stamped by rehydration and retrieval), `watch_emitted_json` (hint ledger with
`watch:`/`trace:` keys), `resident_bundle_hash` (RFC-listed, reserved, unused). Embeddings unavailable: skips
stay free; retrieve degrades to vector-free sections and never throws; a vector index failure returns `""`
with residency and receipts untouched (test u).

Production model spot check (`Xenova/multilingual-e5-small`, cached under `node_modules/@xenova/transformers/.cache`,
loaded offline in 645 ms, one query embedding 4 ms; 20 topic/prompt pairs through the full gate decision):

| Class | Pairs | Margin `cos − baseline` | Gate outcome |
| --- | --- | --- | --- |
| related EN follow-ups | 6 | 0.060 … 0.111 | 3 skip via embedding (0.083–0.111); 2 lexical drift retrieve; 1 embedding retrieve (0.073) |
| short EN ("tests?", "fix the failing one") | 2 | −0.052, 0.023 | retrieve |
| unrelated EN | 6 | 0.017 … 0.076 | all retrieve (4 lexical drift, 2 embedding) |
| related KR | 3 | −0.040 … 0.104 | all retrieve (1 lexical drift, 2 embedding) |
| unrelated KR | 3 | −0.011 … 0.028 | all retrieve |

No unrelated prompt skipped. The closest call is the unrelated EN 0.076 (0.004 under the line), but prompts of
that shape (≥ 5 tokens, Jaccard < 0.12) are decided by lexical drift before the embedding. Korean follow-ups
err toward retrieval on the real model (negative margins), which is cost, not a miss. The sample is small
(20 pairs); it justifies leaving the thresholds where they are, not retuning them.

## Baseline / after metrics (`node scripts/continuity-recall-benchmark.mjs`, deterministic stub, 365 prompts)

5B added workloads (Korean follow-up/ack, same-project-same-workstream sibling correction and evidence,
continuation carry after compaction, an acknowledgement-lexicon variant set) and metrics (per-epoch duplicate
injection, Capsule carry, sibling evidence once, residency-aware mandatory recall, embedding requests vs
inferences). Baseline = `computeInjectContext(..., { gate: false })` (every prompt retrieves).

| Workload | Prompts | Retrievals B→G | Embedding requests B→G | Injected chars B→G | Ack emb G | p95 ms G |
| --- | --- | --- | --- | --- | --- | --- |
| follow-up-heavy | 40 | 40 → 17 | 48 → 29 | 182 → 182 | 0 | 2.18 |
| ack-heavy | 40 | 40 → 1 | 40 → 1 | 330 → 77 | 0 | 2.29 |
| topic-shift-heavy | 24 | 24 → 24 | 24 → 24 | 278 → 278 | 0 | 2.34 |
| explicit-history-source | 18 | 18 → 18 | 18 → 18 | 720 → 720 | 0 | 7.13 |
| same-fact-evolution-rollback-correction | 5 | 5 → 3 | 5 → 3 | 416 → 416 | 0 | 8.97 |
| compaction-heavy-200 (8 compactions, 4 continuation carries) | 191 | 191 → 60 | 191 → 120 | 3,509 → 2,449 | 0 | 1.05 |
| korean-follow-up-ack | 22 | 22 → 7 | 22 → 14 | 718 → 719 | 0 | 1.10 |
| same-project-same-workstream | 4 | 4 → 2 | 4 → 1 | 566 → 356 | 0 | 5.51 |
| same-project-different-workstreams (feature/main) | 12 | 12 → 3 | 12 → 8 | 182 → 182 | 0 | 7.93 |
| incident-recurrence / no recurrence | 5 | 5 → 5 | 5 → 5 | 579 → 579 | 0 | 4.94 |
| embeddings-unavailable | 4 | 4 → 2 | 1 → 1 | 77 → 77 | 0 | 4.69 |
| **total** | **365** | **365 → 142 (−61.1%)** | **370 → 224** | **7,557 → 6,035** | **85 → 0** | **max 8.97** |

Embedding requests = model inferences + query-memo hits (the harness recycles prompt text; inferences alone
were 44 baseline / 0 gated in one process). 5A reported 340 → 126 (−62.9%) on 340 prompts with a counter that
did not see probe warm-up or memo hits; the 5B figure is the honest one on a larger workload. Hook latency
p95 is in-process on the stub (real-model query embedding adds ~4 ms warm; cold import of `dist/inject-core.js`
measured 0.14 s without loading the model, so the removed 20-character floor does not hurt acknowledgements).

## Recall and scope quality (gated)

- Mandatory memory intents recalled: 20/20 (EN and KR why/history/source questions; residency-aware —
  a subject already injected in the epoch counts as recalled).
- Stale injections 0; wrong-workstream injections 0 (planted EXPERIMENTAL workstream fact never reaches the
  main session across 12 prompts); duplicate injections 0 (same bullet line twice in an epoch; 5A had 33 from
  TRACE repeats); repeated sibling evidence 0.
- Corrections 3/3 (five-attempts change, rollback to three, and a sibling change delivered on a bare "thanks"
  with 0 embeddings); Capsule carry on continuation 4/4; sibling evidence 1/1.
- WATCH 1/1 expected, 0 false positives (single-episode candidate never warns), 1 TTL suppression; assistant
  above current truth 0; max bundle 432 chars (hard 1,000 / 2,000).
- MCP `trace_fact` success and bounded timeline pagination true in all 11 workloads.

## Budgets, correction, WATCH

- Memory Bundle order CORRECTION > WORK NOW > CURRENT TRUTH > WATCH > TRACE > RECENT EVIDENCE > ASSISTANT
  CONTEXT; normal target 700 / hard 1,000 chars, rehydration target 1,500 / hard 2,000; deterministic
  truncation; only emitted revisions become resident (unchanged from 5A, re-verified by tests n/o and the
  harness maximum).
- Corrections are derived from residency (D-028): every resident revision whose fact moved to a new
  generation or was deactivated is corrected on any retrieval, quoting the Chronicle's earlier statement when
  known; a stale project revision forces the pass but never pushes never-resident facts; the revision is
  acknowledged only after all stale resident revisions were emitted (bounded drain).
- WORK NOW whenever the Capsule generation is not resident in the epoch; SessionStart rehydration marks it;
  empty generations are marked resident (D-029).
- WATCH: verified patterns only, bounded to 2, TTL of 5 substantive prompts unless a newer verified episode;
  TRACE: pointer-first text, resident per epoch unless the Chronicle changed (D-032).
- Hot Evidence: sibling sessions only, after the `last_retrieval_at` watermark (D-030).

## MCP compatibility

`trace_fact`, `search_facts`, `readChronicleTimeline`, incident and Hot Evidence surfaces are untouched by
5B. Gate skips leave the deep path intact (test v); explicit why/history/source prompts point at
`trace_fact subject_key=…` instead of injecting history; large timelines page with a cursor (60-event subject,
limit 25). `readHotEvidence` gained two optional filters (`excludeSessionId`, `afterCreatedAt`) that default off,
so MCP and rehydration reads are byte-identical to Phase 4.

## Defects found and fixed by 5B

1. Stale project revision swallowed the prompt's own recall and pushed never-resident facts as corrections
   (`src/inject-core.ts` former early return via `buildRehydrationContext`): an explicit "why …" question during
   a sibling change received only the correction and the next prompt on that topic was skipped as coherent.
   Fixed by residency-derived corrections (`readResidentRevisionCorrections`, `src/continuity-core.ts:996`;
   `src/inject-core.ts:408`), bounded drain (`:647`). Gate test 2.
2. Resident facts that changed without a project-revision bump (workstream-promoted) were corrected only when
   they happened to be in the search results. Same fix; gate test 6 (feature/main two sessions).
3. "계속해줘"/"continue" as the first prompt of a session or after compaction was skipped, so the Capsule arrived
   one prompt late; a memory question as the first prompt consumed the epoch trigger without WORK NOW.
   Fixed in the gate order (`src/recall-gate.ts:244`) and vector-free acknowledgement retrieval
   (`src/inject-core.ts:384`). Gate tests 1 and 8.
4. First prompt after a `SessionStart(compact)` rehydration repeated the Capsule; an empty Capsule generation
   could force retrieval on every prompt. Fixed by generation residency (`src/inject-core.ts:490`). Gate test 5.
5. Hot Evidence re-injected the same two lines (including the session's own last message) on every retrieval
   for the 14-day TTL. Fixed by sibling-only reads with an epoch watermark (`src/continuity-identity.ts:712`,
   `src/continuity-core.ts:930` and `:1718`, `src/inject-core.ts:437`). Gate test 3.
6. WATCH TTL compared against a counter that every retrieval reset, so a signature never re-warned inside an
   epoch; TRACE had no residency (33 duplicate lines in the harness) and its actionable tail was cut by the
   line cap. Fixed by the hint ledger (`src/inject-core.ts:517`) and pointer-first TRACE text (`:553`).
   Gate test 4; harness duplicates 0.
7. `embedding_calls` undercounted real inferences (1 reported for 9 performed on a cold process: query plus
   eight background probes) and `embedding_cache_hits` was never recorded. Fixed with module counters
   (`src/embeddings.ts:128`) and delta sampling (`src/inject-core.ts:303`). Gate test 7; test w updated mock.
8. A stale revision computed an embedding even when the correction path returned early; Korean particles made
   every Korean follow-up look like drift; polite KR/EN acknowledgements went to the ambiguous path (one
   embedding each). Fixed by `needsVector`, the tokenizer suffix rule (`src/recall-gate.ts:137`) and the
   lexicon (`:178`). Harness Korean retrievals 22 → 7; acknowledgement embeddings 0.
9. Harness measurement gaps: no same-workstream sibling case, no Korean workload, no continuation-after-compact
   case, no duplicate-injection metric, mandatory recall not residency-aware, embedding cost not split into
   inferences vs memo hits. All added to `scripts/continuity-recall-benchmark.mjs`.

Tests: new `test/continuity-recall-gate.test.ts` (8 cases on the real stub path); `test/inject-write-ordering.test.ts`
stale-correction case rewritten for the residency mechanism (same write-ordering invariant); the 5A
`test/continuity-recall.test.ts` mock exposes `embeddingCallStats`. No test was weakened or removed.

## Debt

- Production-model calibration rests on a 20-pair offline sample; a replay over real transcripts with the
  model is Final Integration work (D-027).
- `buildRehydrationContext` (SessionStart resume/compact) still emits the Phase 3 scope-wide correction list,
  which can label never-resident facts as corrections on resume after a long gap; the prompt path no longer does.
- `resident_bundle_hash` is a reserved, unused column; the WATCH TTL constant (5) and Hot Evidence limit (2)
  are unmeasured on real sessions.
- Korean fingerprint stripping is a single-suffix rule, not morphology; Korean short follow-ups still tend to
  retrieve on the real model.
- Product A/B (plugin-less / pre-continuity / final) remains a manual protocol (5A handoff); the harness
  supplies the B-vs-C automated subset only.

## Final integration blockers

None for Phase 5. Carry into Final Integration: real-transcript calibration replay, the rehydration
correction-list semantics above, and the release-note wording that cost figures are call and byte counts, never
time or money savings.

## Verification evidence

| Command | Result |
| --- | --- |
| `npm run typecheck` | PASS (tsc, 0 errors) |
| `npm run build` | PASS |
| `npx vitest run` | 79 files passed, 854 tests passed, 0 failed, 0 skipped, 0 todo (17.9 s) |
| `node --test test/*slice.test.mjs` | 94 tests, 94 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo; no `listen EPERM` (no rerun needed) |
| `node scripts/lifecycle-e2e.mjs --tier offline` | 9/9 steps passed |
| `node scripts/install-e2e.mjs` | verdict PASS (dry-run, real install, idempotent rerun, removal, isolation all true) |
| `node scripts/marketplace-e2e.mjs` | status PASS, cleanup PASS |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES (version-bound), 11 checks PASS; artifact rewritten with timestamp/temp-path noise and restored |
| `node scripts/package-runtime-e2e.mjs` | status PASS |
| `node scripts/continuity-recall-benchmark.mjs` | all 9 boolean verdicts true; retrieval reduction 61.1%; artifact `recall-calibration.json` rewritten |
| `git diff --check` | clean |
| disabled-test scan (`grep -rn "\.skip\|\.todo\|xit(" test/`) | 0 disabled tests (matches are `.skipped` result fields and `process.exit` strings) |
| RFC SHA-256 | `146d9a58…163a` unchanged |
| real-model spot check (offline, cached e5) | 20 pairs recorded above; 0 unrelated skips |
