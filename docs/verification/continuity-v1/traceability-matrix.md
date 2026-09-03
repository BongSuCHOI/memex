# Memex Continuity v1 traceability matrix

Statuses describe baseline `c790480b`; later gates must update code, schema, tests, and latest gate with current evidence.

| Invariant | RFC section | Current status | Related code | Related schema | Related tests | Target phase | Verification method | Latest gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CAPTURE | §7, §19 | missing | archive snapshot only: `src/sync.ts`, `src/archive-io.ts` | none for journal/checkpoint hash | none | 2 | rolling append/hash/crash E2E | Phase 0 gap |
| ACCOUNTABILITY | §7.3, §19 | contradicted | `src/fact-extractor.ts` dropped windows/session marker | `extraction_log` only | extraction retry tests cover session state only | 1 | exact range state inventory/property test | Phase 0 gap |
| MONOTONIC INGESTION | §8.4, §19 | partial/contradicted for prefixes | `src/archive-ingestion.ts`, `reconcileArchiveExchanges()` | exchange `line_end`, no generation guard | `exchange-identity.test.ts` covers canonical resume, not old prefix | 1 | CP2-before-CP1 and shorter-line tests | Phase 0 gap |
| EXACT EXTRACTION | §8.1, §19 | contradicted | `extractFactsFromExchanges()`, `writeCompletionMarker()` | live `last_exchange_rowid` | no fixed-target concurrent insert test | 1 | fixed fence + cursor overrun test | Phase 0 gap |
| NO SAMPLING LOSS | §8.2, §19 | contradicted | `selectSpreadWindows()`, `MAX_FACTS_PER_SESSION` | no page cursor | spread selection tests do not prove draining | 1 | multi-run contiguous drain/property test | Phase 0 gap |
| OPEN TURN | §8.3, §19 | missing | parser/upsert has stable ID only | no hash/generation/closure | resume identity tests only | 1 | growing exchange/stale generation/closure tests | Phase 0 gap |
| AUTHORITY | §11.3, §19 | substantially satisfied for current fact extraction | extractor validator/verifier, conversation policy | provenance, recall taint, source lineage/dependencies | authority/provenance/privacy suites | 1 regression, 2–5 preserve | contamination adversarial suite | Phase 0 baseline |
| CAPSULE TYPING | §4.2, §14, §19 | missing | none | none | none | 2 | typed validation/CAS/authority tests | Phase 0 gap |
| CURRENT VS HISTORY | §4.3–4.4, §15, §19 | missing/partial revision history | `src/fact-management.ts` | facts + minimal `fact_revisions` | semantic/lifecycle tests | 4 | projection/event atomicity + rollback | Phase 0 gap |
| GROUNDED CAUSE | §4.4, §15, §19 | missing | no Chronicle cause API | none | none | 4 | evidence/cause/classifier-note tests | Phase 0 gap |
| TEMPORAL ORDER | §4.4, §16, §19 | missing | sync uses axis timestamps, no event timeline | no effective/recorded event fields | sync ordering tests only | 4 | reversed completion/effective-order tests | Phase 0 gap |
| RESIDENCY | §12.2, §19 | contradicted | `src/inject-ledger.ts` fact-ID-only TTL ledger | filesystem ID list only | ledger tests | 2 | epoch reset/rehydration tests | Phase 0 gap |
| REVISION-AWARE INJECTION | §12.4/12.6, §19 | contradicted | inject filters by fact ID | no resident revision tuple | no correction tests | 2 foundation, 5 complete | generation delta/correction tests | Phase 0 gap |
| SCOPE | §10, §19 | partial | canonical path project, MCP explicit scope | path string in exchanges/facts | scope isolation/same-basename/MCP tests | 3 | multi-worktree/clone/workstream matrix | Phase 0 baseline |
| BRANCH TRUTH | §10.5, §19 | missing | branch recorded but not promotion policy | `git_branch` only | none | 3 | feature/main divergence tests | Phase 0 gap |
| OUTBOX | §9, §19 | missing | fact+marker atomic only | no checkpoints/jobs | claim transaction tests | 1 | checkpoint/job crash matrix | Phase 0 gap |
| RECOVERY | §9, §20, §19 | partial | session claim lease/retry exists | `extraction_log` | claim lease tests | 1 foundation, 2 capture | restart/stale lease/gap inventory | Phase 0 baseline |
| HOOK BOUNDARY | §6, §19 | contradicted | `scripts/session-end-hook.js` waits for stabilization/extraction/export | n/a | current lifecycle tests encode heavy path | 2 | model/embedding=0 and latency fixtures | Phase 0 gap |
| POSTCOMPACT INDEPENDENCE | §6.2, §19 | missing | no compact lifecycle | none | none | 2 | zero-PostCompact end-to-end fixture | Phase 0 gap |
| MCP ACCESS | §13, §19 | partial | search/read/search_facts/trace_fact | current facts/revisions/exchanges | MCP scope/trace tests | 4 | current→event→evidence pagination | Phase 0 baseline |
| PRIVACY | §20, §19 | partial | conversation purge/tombstone/sync exclusions | current entities only | purge/exclusion/sync tests | every phase | purge during queued work/resurrection test | Phase 0 baseline |
| NO SILENT LOSS | §19–20 | contradicted | deterministic window drop can complete session | `dropped_batches` diagnostic only | existing tests expect recorded drop, not non-completion | 1 | failed range never completed/property test | Phase 0 gap |
