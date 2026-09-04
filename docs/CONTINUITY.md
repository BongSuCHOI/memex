# Continuity Architecture v1 — as-built

이 문서는 **실제 구현**을 설명합니다. 규범 문서는 `architecture/memex-continuity-v1.md`(Final RFC, `verification/continuity-v1/rfc-lock.json`으로 SHA 고정)이며, RFC 예시와 구현이 다른 지점은 `verification/continuity-v1/rfc-deviations.md`(D-000~D-036)에 기록되어 있습니다. RFC는 수정하지 않습니다. 이전 초안과 이전 worker prompt pack은 규범이 아닙니다.

## 1. Lifecycle과 event contract (§6)

| Codex event | matcher | Memex 동작 | 대기하지 않는 것 |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|resume\|clear\|compact` | session/workstream resolve, queue recovery; `clear`/`compact`는 새 `context_epoch`; `resume`/`compact`는 즉시 rehydration(`additionalContext`) | model, embedding, extraction |
| `UserPromptSubmit` | `""` | cheap gate → (필요 시) 1회 embedding → Memory Bundle | LLM (gate에 LLM 없음) |
| `Stop` / `Interrupt` | `""` | rolling journal append + fsync, closed/interrupted fence, checkpoint+outbox 원자 commit, detached worker wake | worker 완료 |
| `PreCompact` | `manual\|auto` | fsync + immutable prefix checkpoint + carry freeze + Capsule job coalesce | — |
| `PostCompact` | `manual\|auto` | telemetry only (D-009) | 어떤 correctness transition도 없음 |
| `SessionEnd` | `""` | final delta + final fence + outbox; foreground extraction/export 없음 (D-011) | — |

검증된 runtime: Codex CLI `0.150.1`(Phase 0 계약) ~ `0.153.2`(Phase 2~F1 검증), Node `v26.0.0`, macOS arm64. hook 실행은 `cli/runtime-exec.js`가 설치된 artifact의 local binary를 고정 실행합니다(D-013). 공식 `codex plugin validate`는 `0.153.2`에 없어 `scripts/validate-plugin.mjs`가 substitute 검사를 수행합니다.

## 2. Journal · checkpoint · outbox · worker (§7, §9)

- `journal_streams`/`journal_blocks`: transcript prefix를 byte 단위로 rolling append하고 segment/prefix hash를 기록합니다. inode/size/mtime + 4KiB copied-prefix guard로 rewrite를 감지해 새 stream epoch을 엽니다(D-012).
- `checkpoints` + `memory_jobs`: 한 SQLite immediate transaction에서 checkpoint와 `capture_index`(P0)/`capsule_update`(P1) job을 함께 씁니다. lease/generation CAS, retry/dead-visible, `superseded` 상태(D-008). partition claim은 priority lane → ordinal 순서입니다(D-034).
- `scripts/continuity-worker.js`: P0 hash 검증 + monotonic prefix ingest → P1 typed Capsule patch(strict JSON, generation CAS) → P2 exact extraction. expired lease는 startup/resume에서 회수됩니다.
- `capture_gaps`: capture 실패는 gap row + warning으로 남기고(`MEMEX_STRICT_CAPTURE=1`일 때만 block) 다음 hook이 복구합니다.

## 3. Extraction correctness spine (§8)

`extraction_targets`/`extraction_target_items`/`exchange_extraction_state`: closed generation의 immutable ordered target, contiguous cursor, policy version, exact failed range. legacy `SEED`/`PERMANENT`/watermark는 completion authority가 아닙니다(D-007). 성장한 exchange는 새 content generation으로 재처리됩니다(OPEN TURN).

## 4. Work Capsule과 tail baton (§4.2, §14)

`work_capsules`(workstream-scoped, `authority = context-only`): objective/current_state/verified_progress(evidence 필수)/hypotheses/blockers/open_questions/next_actions. Capsule이 없거나 latest checkpoint보다 오래되면 deterministic tail baton(마지막 요청, plan line, touched files, trusted test, unresolved error)이 대신합니다. 어느 것도 fact evidence로 재진입하지 않습니다.

## 5. Project · workspace · workstream · session (§10)

`projects`/`workspaces`/`minimal_workstreams`/`workstream_sessions`/`session_memory_state`. resolver 우선순위와 binding 규칙은 `verification/continuity-v1/phase-3-handoff.md`, 자세한 계약은 `ARCHITECTURE.md` §5, `CONVERSATION-LIFECYCLE.md`. 새 session은 생성 시점의 `projects.memory_revision`을 seen으로 시작합니다(D-026).

## 6. Current facts · subject · Chronicle (§4.3–4.4, §15–17)

- `facts` = current projection; `(project_id, subject_key, promotion_state, workspace_id, workstream_id)` active unique slot. 추출된 fact는 기본 `workstream` scope이며 `decision`/`project-current`는 explicit evidence를 가진 promotion(`assignFactSubject`)으로만 승격됩니다(BRANCH TRUTH).
- `fact_revisions` = Chronicle(단일 append-only history table, D-018): 7 event kind, content-hash event id, `effective_at`(source) vs `recorded_at`, grounded cause vs classifier note, `reverts_event_id`, `projection_applied`. 정책은 `FACT-LIFECYCLE.md` §13.
- `incident_occurrences`/`incident_signatures`: coalescing, independent episode, remediation, `matchIncidentPatterns`(WATCH 원천).

## 7. Context epoch · residency · Memory Broker (§11–12)

`session_memory_state`: `context_epoch`, resident/carry `(fact_id, semantic_generation, lifecycle_generation)`, `capsule_generation_seen`, `memory_revision_seen`, Phase 5 gate state(`topic_fingerprint_json`, `topic_embedding`, `informative_prompts_since_retrieval`, `last_retrieval_epoch`, `watch_emitted_json`). cheap gate 규칙, Memory Bundle section/budget, correction semantics는 `RETRIEVAL-AND-CONTEXT.md` §4a/4b. 비용 수치는 `verification/continuity-v1/recall-calibration.json`(call/byte count만).

## 8. 자동 injection vs MCP (§13)

자동 injection = 작은 working-memory fast path(hard 1,000자 / rehydration 2,000자). `trace_fact`/`search_facts`/`explore_graph`는 current → Chronicle → source → other session을 bounded cursor로 탐색하는 deep path이며 gate skip의 영향을 받지 않습니다. lane label: `CURRENT FACT`, `CHRONICLE EVENT`, `RAW EVIDENCE`, `ASSISTANT CONTEXT-ONLY`, `HOT EVIDENCE — NOT YET DISTILLED`.

## 9. Sync · privacy (§9, §20)

protocol v4 다섯 파일에 stable project identity, subject/promotion, Chronicle event row, event tombstone row가 additive로 실립니다(D-015, D-018, D-019). 구 peer는 generation 전체를 visible reject합니다. privacy purge는 journal/checkpoint/job/exchange/fact/event/incident/Capsule(D-035)/vector/Hot Evidence/session state를 한 transaction에서 지우고 tombstone을 남겨 worker/sync/cache 재생성을 막습니다.

## 10. Schema와 flag

Continuity schema `6` (`PRAGMA user_version`, `continuity_schema_meta`): v1 correctness spine → v2/v3 capture guards → v4 identity → v5 Chronicle → v6 recall gate columns. 모든 migration은 additive·idempotent·crash-injected(`test/continuity-correctness-spine.test.ts`).

| 환경 변수 | 기본 | 의미 |
| --- | --- | --- |
| `MEMEX_HOME`, `MEMEX_DB_PATH` | XDG/`~/.config/memex` | data root / DB path |
| `MEMEX_STRICT_CAPTURE` | unset | `1`이면 capture 실패가 hook을 실패시킴(기본은 gap + warning) |
| `MEMEX_CONTINUITY_NO_WAKE` | unset | detached worker wake 비활성(테스트/진단) |
| `MEMEX_ALLOWED_TRANSCRIPT_ROOTS` | Codex sessions root | hook이 읽을 수 있는 transcript root |
| `MEMEX_MAX_EXTRACT_WINDOWS`, `MEMEX_MAX_EXTRACT_CALLS` | policy default | run당 extraction budget(미처리 suffix는 pending) |
| `MEMEX_CODEX_BIN`, `MEMEX_CODEX_MODEL`, `MEMEX_CODEX_EXEC_TIMEOUT_MS`, `MEMEX_LLM_RETRIES`, `MEMEX_LLM_RETRY_BASE_MS` | 설치 기본 | worker model 호출 |
| `MEMEX_EMBEDDING_MODEL` | e5 | embedding model |
| `MEMEX_EMBEDDING_STUB` | unset | `1` deterministic stub, `fail` 모델 부재 시뮬레이션 — harness/test 전용(D-025) |
| `MEMEX_MCP_AUTOSTART`, `MEMEX_RUNTIME_FORCE_REMOTE`, `MEMEX_PLUGIN_ROOT` | — | MCP/launcher 진단용 |

Feature flag는 없습니다. PostCompact 등록은 optional telemetry입니다.
