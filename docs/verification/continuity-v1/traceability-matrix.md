# Memex Continuity v1 traceability matrix

Statuses describe baseline `c790480b`; later gates must update code, schema, tests, and latest gate with current evidence.

| Invariant | RFC section | Current status | Related code | Related schema | Related tests | Target phase | Verification method | Latest gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CAPTURE | §7, §19 | missing | archive snapshot only: `src/sync.ts`, `src/archive-io.ts` | none for journal/checkpoint hash | none | 2 | rolling append/hash/crash E2E | Phase 0 gap |
| ACCOUNTABILITY | §7.3, §19 | Phase 1 PASS | `src/continuity-store.ts`, `src/fact-extractor.ts`, pipeline status | targets/items/failed ranges/jobs | exact range, retry/dead, lease-expiry recovery | 1 | exact failed-visible range and durable state inventory | Phase 1B PASS |
| MONOTONIC INGESTION | §8.4, §19 | Phase 1 PASS | `ingestPrefixExchanges()`, guarded `insertExchange()`, canonical `ingestArchiveExchanges()` | generation/hash/line/closure guards | CP2-before-CP1 regression test | 1 | older prefix causes zero delete/regression | Phase 1B PASS |
| EXACT EXTRACTION | §8.1, §19 | Phase 1 PASS | immutable target/items and `commitExtractionPage()` | fixed fence, cursor ordinal, exact generation state | concurrent insert/update, legacy watermark holes | 1 | model-time insert leaves suffix; stale update commits zero | Phase 1B PASS |
| NO SAMPLING LOSS | §8.2, §19 | Phase 1 PASS | contiguous window prefix + target page cursor | target item states/cursor | seeded 37-item randomized drain, fact-cap E2E | 1 | ordinal coverage equals `1..N`; capped suffix pending | Phase 1B PASS |
| OPEN TURN | §8.3, §19 | Phase 1 foundation PASS | parser closure, content hash/generation, commit CAS | exchange identity + superseded state | open/interrupted and legacy-watermark fence tests | 1 | stale generation zero commit; first open row fences suffix | Phase 1B PASS; D-006 Phase 2 boundary |
| AUTHORITY | §11.3, §19 | preserved; Phase 1 regression PASS | extractor validator/verifier, generation target, conversation policy | provenance and lineage unchanged | 259-test authority/provenance/privacy/sync regression | 1 regression, 2–5 preserve | fail-closed evidence/verifier and scope regression | Phase 1B PASS |
| CAPSULE TYPING | §4.2, §14, §19 | missing | none | none | none | 2 | typed validation/CAS/authority tests | Phase 0 gap |
| CURRENT VS HISTORY | §4.3–4.4, §15, §19 | missing/partial revision history | `src/fact-management.ts` | facts + minimal `fact_revisions` | semantic/lifecycle tests | 4 | projection/event atomicity + rollback | Phase 0 gap |
| GROUNDED CAUSE | §4.4, §15, §19 | missing | no Chronicle cause API | none | none | 4 | evidence/cause/classifier-note tests | Phase 0 gap |
| TEMPORAL ORDER | §4.4, §16, §19 | missing | sync uses axis timestamps, no event timeline | no effective/recorded event fields | sync ordering tests only | 4 | reversed completion/effective-order tests | Phase 0 gap |
| RESIDENCY | §12.2, §19 | contradicted | `src/inject-ledger.ts` fact-ID-only TTL ledger | filesystem ID list only | ledger tests | 2 | epoch reset/rehydration tests | Phase 0 gap |
| REVISION-AWARE INJECTION | §12.4/12.6, §19 | contradicted | inject filters by fact ID | no resident revision tuple | no correction tests | 2 foundation, 5 complete | generation delta/correction tests | Phase 0 gap |
| SCOPE | §10, §19 | partial | canonical path project, MCP explicit scope | path string in exchanges/facts | scope isolation/same-basename/MCP tests | 3 | multi-worktree/clone/workstream matrix | Phase 0 baseline |
| BRANCH TRUTH | §10.5, §19 | missing | branch recorded but not promotion policy | `git_branch` only | none | 3 | feature/main divergence tests | Phase 0 gap |
| OUTBOX | §9, §19 | Phase 1 foundation PASS | `createCheckpointWithJob()`, job claim/complete/fail | checkpoints + memory_jobs | two half-state crashes, 10 duplicates, semantic collision | 1 | no checkpoint/job half-state | Phase 1B PASS |
| RECOVERY | §9, §20, §19 | Phase 1 extraction foundation PASS | target/job lease generation and reclaim | pending/retry/running/dead/superseded states | expiry reclaim, final-attempt range, stale owner | 1 foundation, 2 capture | restart state inventory | Phase 1B PASS |
| HOOK BOUNDARY | §6, §19 | contradicted | `scripts/session-end-hook.js` waits for stabilization/extraction/export | n/a | current lifecycle tests encode heavy path | 2 | model/embedding=0 and latency fixtures | Phase 0 gap |
| POSTCOMPACT INDEPENDENCE | §6.2, §19 | missing | no compact lifecycle | none | none | 2 | zero-PostCompact end-to-end fixture | Phase 0 gap |
| MCP ACCESS | §13, §19 | partial | search/read/search_facts/trace_fact | current facts/revisions/exchanges | MCP scope/trace tests | 4 | current→event→evidence pagination | Phase 0 baseline |
| PRIVACY | §20, §19 | Phase 1 entities PASS | purge deletes checkpoint/job/target/item/generation before source in one transaction | target cascade + terminal fact tombstone | queued work purge + privacy/sync regressions | every phase | pending worker state removed with source | Phase 1B PASS |
| NO SILENT LOSS | §19–20 | Phase 1 PASS | recursive split, singleton failed-visible, exact pending query | exact range/fingerprint/error + dead target/job | deterministic failure, randomized coverage, legacy markers | 1 | failed range never completed; legacy live-MAX never authoritative | Phase 1B PASS |
