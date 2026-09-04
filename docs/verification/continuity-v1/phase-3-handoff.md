PHASE 3 GATE: PASS

# Phase 3 — Multi-session & Workspace Identity implementation handoff

Prompt 3B independently traced and corrected the actual migration, resolver, binding, injection, MCP,
sync, purge, package-runtime, and test process boundaries. The covered Phase 3 adversarial matrix has zero
cross-project/wrong-workstream leakage, silent remote merge, ungrounded project-current promotion,
migration loss, stale Capsule overwrite, or privacy resurrection. Phase 3 is closed; Phase 4 is not started.

## Repository and lock

- Branch: `feat/memex-continuity-v1`
- Phase 3A base HEAD: `db548d29235d871f2f719486961480c20d9a07dd`
- Final RFC SHA-256: `146d9a587604590ae261fa0477def934921c8dbf30b82aac1eea798cfc61163a`
- Worker Prompt Pack SHA-256: `6ac7511bea8ddaa29b4bfda63e8702780e83b33d456d4cb5be01f221debbddf3`
- Continuity schema: `4`; sync protocol: `4`; package/plugin: `0.3.0`
- Gate runtime: Codex CLI `0.153.2`, Node `v26.0.0`, macOS arm64.
- Preserved user-owned state: deleted `FACT-EXTRACTION-CONTEXT-GROUNDING-PLAN.md` remains untouched and
  must not be staged, restored, or included in the Phase 3 commit.

## Identity and migration contract

Stable ownership is `project_id → workspace_id → workstream_id → session_id`. Absolute cwd, Git paths,
branch, and inode hints are device-local location provenance. Existing path-scoped rows are migrated
additively and keep their original row identity, source exchange IDs, fact revision/source payload,
recall fact IDs, checkpoint identity, workstream/Capsule identity, and canonical path compatibility key.
Migration stages are one SQLite immediate transaction, are crash-injected at every write stage, and rerun
idempotently.

Resolver precedence:

| Priority | Evidence | Result |
| ---: | --- | --- |
| 1 | explicit existing `project_id` or portable key | explicit link/new workspace |
| 2 | same device and unique Git common-dir/common identity | same project, distinct workspace |
| 3 | user-approved remote fingerprint mapping | mapped project, distinct workspace |
| 4 | canonical cwd fallback | new isolated project/workspace |

A unique local Git-dir inode updates the same workspace after rename. Basename, package name, or matching
remote alone never merges. Ambiguous remote candidates write a suggestion audit. `linkWorkspaceToProject`,
`splitWorkspace`, and session rebind are explicit, transactional, idempotent, and audited; remote approval is
an explicit idempotent mapping rather than an inferred merge.
Legacy path readers remain supported and do not mutate the identity registry during MCP lookup.

## Workstream binding and Capsule isolation

| Priority | Decision | Recorded reason/confidence |
| ---: | --- | --- |
| 1 | existing session resumes exact binding | `resume-exact`, `1.0` |
| 2 | explicit workstream | `explicit`, `1.0` |
| 3 | unique active candidate in same workspace/branch | `unique-workspace-branch`, `0.9` |
| 4 | deterministic token Jaccard >= 0.45 and next-candidate margin >= 0.15 | `strong-topic-margin`, score |
| 5 | ambiguous/no match | deterministic session-local workstream, `1.0` |

Branch is a hint, there is no latest-session fallback, and no LLM is called for binding. Several sessions
may share one workstream Capsule. Capsule generation/lease CAS from Phase 2 remains the serialization
boundary and now preserves source workspace/session. Purging one session rehomes a shared compatibility
owner and preserves the sibling Capsule; an orphan workstream is removed.

## Scope and promotion matrix

| State | Durable placement | Project-current retrieval |
| --- | --- | --- |
| experimental/unmerged implementation | workstream Capsule or `promotion_state=workstream` | excluded |
| verified state specific to checkout | `promotion_state=workspace` + workspace ID | only that workspace/workstream |
| explicit project decision | `promotion_state=decision` | included project-wide |
| merged/validated implementation state | `promotion_state=project-current` | included project-wide |
| released legacy project fact | `promotion_state=legacy-project` | compatibility included |

`subject_key` is a stable slot seed for Phase 4. Active uniqueness is enforced over project, subject,
promotion, and optional workspace/workstream. Both the promotion API and low-level fact insert reject a
decision without explicit-decision evidence, project-current without merged/validated evidence,
workspace/workstream membership mismatch, and project-wide truth carrying a local scope.

## Multi-session freshness and memory lanes

Meaningful semantic, lifecycle, project/scope, subject, or promotion changes to project/decision/workspace
truth increment `projects.memory_revision`; derived-only updates and no-op writes do not. Workstream
experimental facts do not create a project revision storm. A sibling update is not pushed into an active
turn: the next prompt/resume/compact boundary detects stale revision and emits correction before ordinary
semantic results. Inactive resident truth is explicitly retracted. When a bounded bundle cannot hold all
corrections, only emitted revisions enter residency and the scalar project revision is not marked seen
until every relevant correction has been drained or the change is proven irrelevant to the local scope.

Memory lanes remain distinct:

- Durable Fact Lane: authoritative active current facts.
- Hot Evidence Lane: recent human and learnable local repo/Git/test observations, TTL/keyset paginated,
  always rendered `RECENT EVIDENCE — NOT YET DISTILLED`.
- Assistant Continuity Lane: assistant output, compact summary, Capsule, and tail baton are context-only
  and cannot re-enter fact evidence authority.

## MCP, sync, and privacy

- Every project-sensitive fact/ontology/avatar/graph MCP surface accepts explicit
  project/workspace/workstream/session stable scope; global/all remain explicit where supported. Raw
  `search` can retrieve exact other-session evidence. Stable-ID combinations are membership checked,
  mixed stable/path project identity is rejected, MCP process cwd is never identity, and unknown legacy
  paths are read-only queries rather than registry writes.
- `search_facts(include_hot_evidence=true)` exposes the separate Hot Evidence lane with timestamp+ID
  keyset pagination.
- Ontology/avatar queries include path-free stable facts. Graph traversal and stats filter the resolved
  stable fact set at every relation endpoint, preventing sibling-workstream expansion. D-016 retains only
  read-only legacy path compatibility; no Phase 3 stable-scope work is deferred to Phase 4.
- Protocol remains the exact five-file v4 generation. Stable project ID/portable key/subject/promotion are
  durable; device paths and workstream experimental facts are not exported. Import accepts released
  path-bearing rows and new path-free rows, maps portable keys to local projects, rejects ambiguous
  ID/key conflicts, and preserves replay/idempotency plus semantic/lifecycle conflict rules.
- Privacy purge removes session bindings/state, session Hot Evidence, jobs/checkpoints/journal state and
  source-linked facts. It preserves a Capsule still owned by a sibling session, removes orphan
  workspace/project registry rows when no durable references remain, and retains the terminal exclusion
  guard so pending capture/index work cannot resurrect data.

## Phase 3A defects fixed before handoff

1. Identity migration initially assumed full released tables and failed skeletal interruption fixtures;
   table/column capability checks now keep additive migration rerunnable.
2. Re-running migration could synthesize a different project for an existing workspace; existing path
   identity is now reused.
3. External-content FTS update triggers fired on identity-only exchange updates; triggers now maintain FTS
   only when conversation text changes.
4. Sibling project revision could be marked seen after an ordinary semantic match without emitting the
   required correction. Correction now precedes normal results.
5. Inactivated resident truth had no explicit retraction. Rehydration now emits `No longer active` with
   the current lifecycle generation.
6. A bounded correction bundle could mark the scalar revision seen after emitting only its first subset.
   Emitted revisions now drain across natural boundaries and completion is explicit.
7. Carry with an old fact generation was temporarily omitted when the scalar project revision was already
   seen; carry-generation mismatch is independently a correction candidate.
8. Stable MCP legacy lookup created identity rows despite read-only annotations. It now performs a
   non-mutating compatibility query and rejects mixed stable-ID membership.
9. New stable MCP error wording broke the released structured error slice. The message now keeps the
   legacy `project is required`/`canonical absolute` contract while documenting `project_id`.

## Phase 3B independent defects fixed

1. Linking or splitting a workspace missed path-owned legacy facts, and moving a last workspace could
   orphan its portable identity and project-only rows. Link/split now transfer the full owned scope,
   portable key and approved mappings atomically, reject conflicting identities, and delete only an empty
   source project.
2. Resolver ambiguity could silently accept mismatched explicit project/key pairs or conflicting approved
   remote mappings. Stable/path identity mixing is rejected and ambiguous remote mappings remain isolated
   with an audit suggestion.
3. Resume binding accepted a session under a mismatched resolved project/workspace, and explicit rebind
   left Hot Evidence on the old workstream. Both boundaries now validate and move the lane atomically.
4. Direct fact insertion could bypass branch-truth promotion evidence and scope membership. The low-level
   boundary now enforces decision/project-current/workspace/workstream policy; identical subject assignment
   is a no-op rather than a revision storm.
5. Direct deactivation did not advance lifecycle generation, so resident stale truth could survive. It now
   writes an independent lifecycle revision and the next boundary emits the correction.
6. Rehydration read facts and then recorded the live revision, allowing a concurrent sibling update to be
   marked seen without emission. Projection reads use one SQLite snapshot and the handler atomically commits
   exact revision/epoch residency plus Capsule seen state, rolling back on a race.
7. Stable workstream fact search was followed by legacy path-only graph expansion. Relation traversal now
   filters both endpoints by the exact stable scope, and every ontology/avatar/graph MCP surface publishes
   and enforces the same stable identity contract.
8. Hot Evidence was appended only when a distilled fact matched, so the freshness lane vanished when it was
   needed most. Hot-only retrieval now emits its required label, and MCP output exposes usable timestamp/ID
   keyset cursors.
9. Sync recall rows preserved a remote numeric project ID but not the portable key, creating a second local
   project on import. Recall export/import now maps through the portable identity, and a generation-wide
   identity/subject-slot preflight rejects conflicts before any DB mutation.
10. Privacy purge derived registry cleanup candidates only from session state; missing legacy state could
    leave path metadata after deleting exchanges. It now inventories both state and evidence before purge.
11. The released Phase 2-shaped migration, concurrent update, stale mark-seen, rollback, relation isolation,
    path-free ontology/avatar, sync conflict, and orphan-purge cases lacked direct adversarial coverage. The
    focused Phase 3 matrix now contains 85 passing tests.
12. Package E2E repeatedly invoked `npm exec --package=file:` and could wait indefinitely without stage
    evidence. It now installs the exact tarball once, exercises installed bins, reads a real MCP tools/list
    response with a bounded lifecycle, and verifies the final package in about two minutes.
13. A raw-search test matched a random temp path substring, and the re-embed CAS fixture shared a
    process-global DB path under parallel Vitest. Assertions now inspect structured results and DB
    initialization accepts an explicit test path, eliminating both false failure modes.

## Prompt 3B verification evidence

| Command / workload | Independent gate result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm run build` | PASS; generated `dist` refreshed |
| Phase 3 identity/MCP/injection/sync focused suites | PASS — 4 files / 85 tests |
| `npm test` final | PASS; independent JSON rerun: 74 files / 791 tests, failed 0, pending 0, todo 0 |
| `node --test test/codex-slice.test.mjs` | PASS — 24/24; skipped 0, todo 0 |
| `node --test test/*slice.test.mjs` managed sandbox final | 93/94; sole failure is Unix socket `listen EPERM`; skipped 0, todo 0 |
| exact `node --test test/inject-daemon-slice.test.mjs` outside sandbox | PASS — 1/1; skipped 0, todo 0 |
| `node scripts/lifecycle-e2e.mjs --tier offline` | PASS — 9/9; cleanup 7/7 |
| `node scripts/package-runtime-e2e.mjs` outside sandbox | PASS — exact tarball, 212 files, 9 MCP tools, onboarding, hooks, deferred worker |
| `node scripts/install-e2e.mjs` | PASS — dry-run/install/rerun/remove/isolation |
| `node scripts/marketplace-e2e.mjs` | PASS — seven lifecycle surfaces and cleanup |
| `node scripts/validate-plugin.mjs` | PASS-WITH-NOTES — CLI 0.153.2 has no formal validator; all authorized installed-artifact checks PASS |
| disabled-test scan and `git diff --check` | PASS |

Expected stderr from negative retry, stale-CAS, privacy-race, and irreducible-failure tests was observed.
The managed aggregate slice failure and exact outside-sandbox PASS are preserved separately. The first
package attempt was interrupted after the unbounded repeated-`npm exec` harness stalled; registry access,
tarball creation, and one-prefix install were isolated before the bounded harness passed. No product failure,
skip, or unverified mandatory Phase 3 path is hidden.

## Debt and Phase 4 boundary

- Legacy canonical path readers remain a documented read-only compatibility surface; stable identity is the
  preferred public scope and no cwd inference is allowed.
- Protocol v4 additive stable rows can be visibly rejected by older peers that do not understand the
  path-free shape; complete-generation validation prevents partial import.
- `graph_stats` materializes the resolved stable fact set for exact counts. Large-corpus performance is a
  non-blocking calibration concern, not a Phase 3 isolation gap.
- Chronicle events, grounded cause/effective-time history, incident patterns, and adaptive recall remain
  intentionally absent. They belong to later phases and were not implemented by this gate.
- Phase 4 blockers from Phase 3: none. Per the current task boundary, Phase 4 must not start in this run.
