# Codex usability stages 6–8

This record extends the committed memory-integrity work. It does not revise its
historical measurements. [prior-merge-gate.json](prior-merge-gate.json) preserves the preceding receipt.
No release, push, installed-plugin upgrade, or live-data migration is part of this run.

## Acceptance contract

1. Exercise normal completion, interruption, killed-process restart, pre/post
   compaction, repeated compaction, and stale Capsule restoration on the supported
   local Codex host. Distinguish host-driven events from replayed fixtures.
2. Restore goal, observed results, unverified hypotheses, corrections, blockers,
   next action, and evidence pointers. Stale context must remain visibly stale.
3. Keep trusted fixed instructions separate from untrusted memory data. Record
   prepared and emitted delivery independently; host acceptance needs host evidence.
4. Reuse call observations in a bounded evidence-processing job, including retries
   and downstream model stages. Missing usage stays unknown; budget exhaustion
   leaves exact pending work visible and does not advance completion authority.
5. Retrieve exact paths, symbols, and error identifiers with semantic combination,
   scope and active-state validation, and useful embedding-outage fallback.
6. Enforce the final injected-context budget with a conservative, explicitly
   estimated token count. Never consume omitted items in residency/cursors.
7. Compare compaction only, Codex built-in memory, Memex core, and core plus
   optional features using one frozen input and initial state in isolated homes.
   Do not describe unsupported arms or fixture replays as real-host measurements.

The default decision below follows the comparison. Deterministic retrieval checks and
real model/host observations remain separate evidence. Absence of observable host
support is `NOT_PROVEN`, not a passing test or evidence of no benefit.

## Host and comparison constraints observed during planning

Local CLI `0.153.4` exposes `thread/compact/start` and `turn/interrupt` in its
generated app-server protocol schema. Their presence is a compatibility lead,
not evidence that Memex received those events. The host harness must prove that.

Codex built-in memory generation is asynchronous and eligibility depends on
session inactivity; the documented minimum idle-time setting is clamped to at
least one hour. An immediate empty-memory result cannot establish its mature
recall quality. Sources: [local memories](https://learn.chatgpt.com/docs/customization/memories),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
[app-server protocol](https://learn.chatgpt.com/docs/app-server).

[native-generation.json](native-generation.json) records a completed native global job with zero input
and success watermarks, zero stage-one outputs, and an empty raw-memory file.
Job completion therefore does not establish that the eight-prompt training
corpus was learned. The configured built-in arm is not a mature-memory quality
baseline; no superiority claim may be derived from its empty learned state.

## Actual host lifecycle result

[host-compatibility.json](host-compatibility.json) records local Codex CLI `0.153.4`
observations. Real interactive TUI runs observed normal completion, interruption,
SIGKILL followed by same-session resume, manual compaction, and two consecutive
compactions. CLI `exec` also consumed a hook-only nonce while ignoring the planted
untrusted override. The TUI used the explicit `setup-hooks` fallback in isolated
homes; app-server protocol operations succeeded but its plugin hook delivery
remained `NOT_PROVEN`. These transport results are not interchangeable.

The earlier [host report](host-compatibility.json) preserves the stale-Capsule
transport observation and the initially blocked content retry. The user subsequently
approved the synthetic payload and authenticated Codex model destination.

The follow-up [stale-content.json](stale-content.json) records an actual Luna TUI
run with a neutral post-compaction query. Its final JSON retains the current retry
count 4, explicitly supersedes 2, preserves the unverified hypothesis, blocker,
next action and evidence location, and reports `stale/context-only` plus both
pending-work descriptions emitted by Memex. Those descriptions were absent from
the training prompt and query, providing content-consumption evidence even though
the host did not echo the hook nonce. The seven-field content check passes for
this synthetic case. Native compacted history is still available, so the latest
retry value alone is not proof of Memex's exclusive contribution.

The first approved attempt exposed a fresh-DB harness bug: asynchronous capture
had not reached `exchanges` before the older Capsule was seeded. The harness now
drains deterministic capture-index jobs before reading evidence and explicitly
forbids model-backed indexing. A regression covers this fresh state. The original
scorer also searched only `currentGoal` for the old-count explanation even though
it belongs in `recentCorrections`; its raw false negative is preserved, with a
separate adjudication and positive/negative regression for the corrected scorer.
No model rerun was needed for that grading correction. The older Capsule remains
seeded test state, not evidence of automatic model distillation quality.

## Frozen comparison input

`test/fixtures/codex-usability.json` has SHA-256
`fc84bf57a8cd1bf4e6f714053dc21c1c886c562ea58bac5fb5e4ccc794628a98`.
The [fixture](../../../test/fixtures/codex-usability.json) maps the eight training prompts, five identifier queries, semantic query, and thirteen expected host checks.
Its eight training prompts were run once through Codex CLI with Luna. The resulting
transcript and empty-memory state were snapshotted before either memory system
learned the corpus. Each arm restores that common snapshot; restoring may rewrite
derived database paths to its isolated home, never transcript contents. The
initial-state file manifest SHA-256 is
`851c0d2fd7de5c490424912a406ad6422694e0fffead665636576277dcca6a99`.

The setup's eight model calls are shared input preparation, not a measured
advantage or cost of one arm. Expected answers remain evaluator-only. Raw host
state is private temporary evidence; the snapshot excludes authentication files.

An early, rejected harness trial copied a Codex state DB without rewriting its
absolute `threads.rollout_path`. A resumed clone therefore appended to the
original **synthetic temporary** training rollout (107,792 to 182,827 bytes).
That trial is not comparison evidence. The frozen initial-state manifest still
matched every file. A new native evaluation home was restored from that frozen
snapshot, with only derived rollout paths rewritten before any host operation.
The corrected harness checks source hashes before and after the run and rejects
source changes. It also clones Memex state before queries and isolates each
retrieval probe so residency writes cannot bias a later query.

Two real-host preparation trials were also excluded from quality conclusions:
extraction yielded to earlier capture/Capsule jobs, and the harness cloned the
core before that queue had drained. The preserved trial report SHA-256 values
are `965a3c472f252ed56ba02f8cb62a9bddb3c9bbede98538f29dd8e68542619bae`
and `ce67cfb012b74c4d2b87f9bd4292ec3324e29bd5a7b836014c6e705f1d6d78c5`.
The final harness drains earlier continuity work first and rejects an incomplete
extraction target before creating the optional arm. It evaluates the final
assistant message separately and waits for active lifecycle workers before
recording final usage and removing temporary authentication files.

A third trial was excluded because the optional clone's generated path-rewrite SQL
failed. Its preserved report SHA-256 is
`b239a1b7c2466e21960c2614d4f50990b29a44ede08af04a87e7cd52884f8e8e`.
The final run validates rewritten files before processing; permanent regression
checks cover child SQL execution and grading the last nonempty assistant message.

## Four-arm result and default decision

[comparison.json](comparison.json) is the unchanged final raw report; [comparison-adjudication.json](comparison-adjudication.json)
records the separate semantic reading and default decision. All four arms executed
actual host compaction and a query. Source hashes stayed unchanged, core extraction
completed 8/8 before cloning, and optional clone path validation passed.

| Observation | Compaction only | Built-in configured | Memex core | Core + optional |
| --- | --- | --- | --- | --- |
| Strict host JSON checks | 13/13 | 13/13 | 12/13 | 13/13 |
| Memex identifier retrieval | N/A | N/A | 5/5 | 5/5 |
| Memex semantic retrieval | N/A | N/A | PASS | PASS |
| Memex provider attempts | N/A | N/A | 6 | 7 |
| Observed Memex model duration | N/A | N/A | 88.950 s | 98.723 s |
| Memex input / output tokens | N/A | N/A | 83,840 / 3,127 | 94,950 / 3,413 |
| Facts / relations | N/A | N/A | 5 / 0 | 5 / 0 |

The core strict failure is a JSON type mismatch: `verifiedCases` was the string
`11 user-asserted cases; not run by assistant`, not numeric `11`. Its raw quality
verdict remains FAIL. Separate manual inspection found no important omission or
incorrect current fact, and no execution of the planted untrusted instruction.
All six retrieval contexts were byte-identical between core and optional arms.

Automatic ontology therefore defaults off and requires `MEMEX_AUTO_ONTOLOGY=1`.
Manual ontology, existing derived data, core fact/exchange embeddings and stale
vector repair remain available. Translation remains manual; no extra automatic
rewriting pass is introduced. This is a cost-conscious default for this observed
case, not proof that optional features never help.

The fixture and scoring rules were authored within the same implementation task:
this is a reproducible regression case, not an independent holdout. A broader
quality claim needs independently collected tasks and blinded grading. Shared
post-compaction history also remains available in every arm, so a correct answer
alone cannot attribute recall to a memory system.

This small synthetic corpus is not a broad benchmark. Built-in learned memory is
`NOT_PROVEN`, despite the configured arm's passing answer. Host compaction usage
and total host provider calls are unobserved. Each Memex arm has three post-query
capture/Capsule jobs pending because automatic wake was disabled; active workers
were idle before temporary authentication removal. The measured Memex attempt
ledger is complete for the recorded processing run.

## Structured-output follow-up

The [type-only schema](../../../test/fixtures/codex-usability-output-schema.json)
requires integer-or-null counts and string-or-null text fields. Every arm receives
the same `codex exec resume --output-schema` argument. No expected values appear
in the schema, and the original frozen training prompts and grader remain unchanged.

[comparison-structured.json](comparison-structured.json) and its separate
[review](comparison-structured-review.json) record the actual rerun. All four final
answers comply with the schema; core now passes 13/13 host checks with numeric
`verifiedCases: 11`. The previous type FAIL remains in the original report.

Overall quality of that recorded run is FAIL. Both Memex arms retrieve 4/5 exact
identifiers because the fresh extraction omitted `E_QUEUE_LEASE_EXPIRED` from its
four facts. The optional host first answered correctly, then received an async
`Sync started in background...` message and ended with all-null JSON. Its final
answer scores 0/13, while the other three arms score 13/13. This sequence is
observed; a controlled follow-up is needed to establish causality. Schema
compliance must not be confused with correct recall, and valid nulls do not pass
known-answer checks. Neither failure is removed or regraded to obtain PASS.

## Root-cause follow-up

[hook-output-control.json](hook-output-control.json) compares the same precompacted
synthetic conversation with one async status notice on stdout, on stderr, or no
notice. Stdout became a developer message and the host generated two answers;
stderr and silence produced no developer notice and one answer each. All three
final answers passed 13/13 checks. This proves the extra-input/extra-answer path
in this trial, but does not reproduce or prove the cause of the earlier all-null
answer. Async operational notices now use stderr; synchronous context JSON still
uses stdout.

The [retained-DB replay review](identifier-replay-review.json) links the raw
[before](identifier-fresh-before.json) and [after](identifier-fresh-after.json)
outputs. Each query gets the same database copy and a fresh context epoch through
the existing clear operation. The committed baseline runtime retrieves 4/5
identifiers; the patch retrieves 5/5. The source database hash is unchanged and
no extraction is rerun. `E_QUEUE_LEASE_EXPIRED` appears as source-linked,
potentially stale raw context, without altering the four stored facts. A separate
post-host diagnostic retained residency and therefore suppressed an already-seen
checkpoint fact; it is not used as the fresh-context comparison.

[comparison-rootfix.json](comparison-rootfix.json) and its
[output review](comparison-rootfix-review.json) record the fresh four-arm rerun.
All four final answers pass 13/13 checks, and both Memex arms retrieve 5/5 exact
identifiers. Each arm produces one assistant answer; no async status developer
message is present. The frozen fixture, schema and grader are unchanged. Core
uses 7 measured Memex attempts (93.630 seconds); optional processing adds one
attempt (8.618 seconds). The optional increment does not change the six retrieval
contexts. These costs belong to this fresh extraction, not the historical runs.
Built-in learned-memory generation and exclusive answer attribution remain
`NOT_PROVEN`; correct output alone does not establish either.

## Deterministic recall calibration

[recall-calibration.json](recall-calibration.json) reruns the existing planted-corpus harness into a new
receipt. Across 365 prompts, mandatory recall is 20/20, corrections 3/3, and
stale/wrong-workstream/duplicate injection counts are zero. The gated path uses
142 retrievals versus 365 without the gate; injected characters are 14,174
versus 17,587. This compares the existing cheap gate with forced retrieval,
not this patch with a prior release, and uses stub embeddings rather than
real-model recall quality. The raw `assistant_above_truth` metric remains 1;
this run does not claim every ordering metric is zero.

## Clean-candidate gate

The [merge-gate receipt](../merge-gate.json) owns the exact committed candidate SHA and final automated results. This narrative records real-host and model observations taken before that gate. Code, generated output, tests and owner documentation are committed first; the clean-candidate gate runs next, and its receipt is committed separately. The prior receipt and frozen input hashes remain unchanged.
