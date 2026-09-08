# Memory integrity repair — 2026-09-08

Scope: baseline/recovery → consolidation isolation → MCP scope propagation → verified wording →
shared contracts → selective existing-data repair. Package version stays 0.4.1; no release is published.
Final committed-SHA checks belong to [merge-gate.json](../merge-gate.json).

## Frozen comparison

[baseline.json](baseline.json) records the unmodified runtime SHA, Codex/model/memory settings, exact
fixture hashes and failing assertions before the patch. [comparison.json](comparison.json) uses the
same 18 assertions and unchanged fixture bytes: **12 pass / 6 fail → 18 pass / 0 fail**.
The six failures were sibling absorption, out-of-scope candidate model calls, workstream-to-project
absorption, unsupported merged wording, related `search_facts` leakage and related `trace_fact` leakage.
Already-passing concurrent-edit, multi-hop, compact/replay and privacy cases stayed green.

The fixture/model/scorer separation is explicit: fixtures encode the requested scope/provenance
invariants, model and embedding responses are deterministic seams, and assertions observe actual
SQLite mutations and returned text. The same author wrote the fixture and implementation. This is
structural regression evidence, not an independent holdout or a real-model quality/cost measurement.

## Implementation map

| Boundary | Owner | Evidence |
| --- | --- | --- |
| Candidate + final consolidation | `src/consolidator.ts`, `src/fact-policy.ts` | frozen cases; source, placement, lifecycle and embedding races |
| Search/graph/trace | `src/read-scope.ts`, `src/fact-db.ts`, `src/ontology-db.ts`, `src/mcp-server.ts` | omitted scope rejects; sibling seed/bridge pruning |
| Meaning mutation | `src/fact-management.ts`, `src/fact-extractor.ts`, `src/sync-import.ts` | required policy, explicit user action, peer distinction, whole-source receipt |
| Resident correction | `src/continuity-core.ts`, `src/inject-core.ts` | scope-revoked text redaction; final emission CAS |
| Legacy reads | `src/legacy-read-scope.ts` | read-only mapping; missing optional scope defaults to global |
| Existing data | `src/fact-integrity.ts`, `scripts/fact-integrity.mjs` | deterministic preview, exact selection, atomic rollback, repeat safety |
| Recovery | `scripts/memory-integrity-snapshot.mjs` | restored hashes, DB/FK, unstable source and read-only CLI tests |

All automatic synthesis was removed from consolidation: only the exact locally verified incoming
meaning may become current after same-scope/subject/conditions/time/authority checks. A new synthesis
verifier was unnecessary because no synthesis path remains. Legacy sourced facts without a local
receipt are preserved, not retrospectively stamped as verified. Raw internal fixture writers remain
internal; exported semantic APIs require a policy or an explicit user correction adapter.

Placement services validate explicit link/split/subject actions inside their transaction. Legacy
schema/export identity backfill is a compatibility migration, not automatic consolidation authority.
Extraction judges the live slot only after embeddings and inside the commit transaction, so it does
not reuse a pre-embedding competing-value verdict. Sync keeps semantic and lifecycle clocks independent.

## Existing data and recovery

[recovery.json](recovery.json) contains privacy-safe aggregate observations and artifact hashes.
The offline restore checked 796 files plus database integrity/FK. Cross-root point-in-time atomicity
remains **NOT_PROVEN** because writers were not jointly paused; byte restoration is a narrower result.

Audit examined 553 facts: 519 legacy identity findings, 3 historical rewrite review candidates and
36 orphan relations. The rewrite findings overlap the legacy set. Original human sources and revision
text were reviewed locally: one unconfirmed exact label, one possible task-to-project scope expansion,
and one supported paraphrase with unresolved identity. All three remain unchanged for explicit review.
The structural audit is not proof that every other fact is semantically correct.

Only the 36 relations attached to inactive facts were selected. The restored clone and then live DB
both reported 36 applied, 0 newly applied on repeat, and 36 already applied. Fact, revision, fact/event
tombstone, exchange and tool row hashes stayed identical within the repair transaction. Follow-up
integrity was `ok`, FK violations 0, repairable findings 0. No full archive reprocessing or automatic
legacy remapping occurred. The local repair ledger records exact targets and reasons.

Private snapshot, restored copy, previews, exact selection, source review and full logs are retained
under ignored `tmp/memory-integrity-20260908/`. They are not package/public evidence. Recovery commands
and output semantics are owned by [GUIDE.md](../../GUIDE.md#16-기억-정합성-감사와-선별-복구).

## Independent cold read and cleanup

A fresh reviewer read only a supplied copy of the new contracts, audit/backup scripts and consolidator.
It did not see the fixture or surrounding session. The review was limited, not a full integration gate.

- Adopted: expose unstable capture as FAIL separately from successful byte restoration; add a regression.
- Adopted: union the incoming participant's live lineage during semantic adoption, including changes
  while embedding waits; add a regression and retain every verification source in the adopted receipt.
- Retained intentionally: inactive context dependencies support history/restore/privacy; only missing
  parents make them orphaned. Search vectors/relations have a different lifetime.
- Retained intentionally: explicit workstream sharing may span workspaces in one project. The initial
  workspace is not an exclusive workstream owner; project membership remains mandatory.

Old positional read APIs are compatibility adapters with global defaults; new production graph callers
use required-scope APIs. Duplicate participant CAS blocks were removed in favor of the common policy. The unused raw delete
writer was removed; older public path readers now use the compatibility adapter.
Current owner docs describe the contracts; the former merge receipt is preserved byte-for-byte as
[merge-gate-2026-09-07-v0.4.1.json](../merge-gate-2026-09-07-v0.4.1.json). Historical values are not rewritten.
