# Continuity Architecture v1 — as-built

이 문서는 **실제 구현**을 설명합니다. 규범 문서는 `architecture/memex-continuity-v1.md`(Final RFC, `verification/continuity-v1/rfc-lock.json`으로 SHA 고정)이며, RFC 예시와 구현이 다른 지점은 [deviation record](verification/continuity-v1/rfc-deviations.md)에 기록되어 있습니다. RFC는 수정하지 않습니다. 이전 초안과 이전 worker prompt pack은 규범이 아닙니다.

## 1. Lifecycle과 event contract (§6)

| Codex event | matcher | Memex 동작 | 대기하지 않는 것 |
| --- | --- | --- | --- |
| `SessionStart` | `startup\|resume\|clear\|compact` | session/workstream resolve, queue recovery; `clear`/`compact`는 새 `context_epoch`; `resume`/`compact`는 즉시 rehydration(`additionalContext`) | model, embedding, extraction |
| `UserPromptSubmit` | `""` | cheap gate → (필요 시) 1회 embedding → Memory Bundle | LLM (gate에 LLM 없음) |
| `Stop` / `Interrupt` | `""` | rolling journal append + fsync, closed/interrupted fence, checkpoint+outbox 원자 commit, detached worker wake | worker 완료 |
| `PreCompact` | `manual\|auto` | fsync + immutable prefix checkpoint + carry freeze + Capsule job coalesce | — |
| `PostCompact` | `manual\|auto` | telemetry only (D-009) | 어떤 correctness transition도 없음 |
| `SessionEnd` | `""` | final delta + final fence + outbox; foreground extraction/export 없음 (D-011). 0.6.1부터 같은 이벤트에 **별도 async 항목**으로 크로스디바이스 export(`scripts/sync-export-hook.js`)가 붙지만 fence는 그것을 기다리지 않습니다(#35) | — |

현재 검증 환경과 CLI 버전은 [merge-gate receipt](verification/merge-gate.json)의 `environment`를 확인하십시오. hook 실행은 `cli/runtime-exec.js`가 설치된 artifact의 local binary를 고정 실행합니다(D-013). `scripts/validate-plugin.mjs`는 repository 소유 검증 도구이며 Codex 공식 validator가 아닙니다.

## 2. Journal · checkpoint · outbox · worker (§7, §9)

- `journal_streams`/`journal_blocks`: transcript prefix를 byte 단위로 rolling append하고 segment/prefix hash를 기록합니다. inode/size/mtime + 4KiB copied-prefix guard로 rewrite를 감지해 새 stream epoch을 엽니다(D-012).
- `checkpoints` + `memory_jobs`: 한 SQLite immediate transaction에서 checkpoint와 `capture_index`(P0)/`capsule_update`(P1) job을 함께 씁니다. lease/generation CAS, retry/dead-visible, `superseded` 상태(D-008). partition claim은 priority lane을 먼저 적용하며 Capsule job은 삽입 순서, 나머지는 session checkpoint ordinal로 정렬합니다(D-034, D-038).
- `scripts/continuity-worker.js`: P0 hash 검증 + monotonic prefix ingest → P1 typed Capsule patch(strict JSON, generation CAS) → P2 exact extraction. expired lease는 startup/resume에서 회수됩니다.
- `capture_gaps`: capture 실패는 gap row + warning으로 남기고(`MEMEX_STRICT_CAPTURE=1`일 때만 block) 다음 hook이 복구합니다.

## 3. Extraction correctness spine (§8)

`extraction_targets`/`extraction_target_items`/`exchange_extraction_state`: closed generation의 immutable ordered target, contiguous cursor, policy version, exact failed range. legacy `SEED`/`PERMANENT`/watermark는 completion authority가 아닙니다(D-007). 성장한 exchange는 새 content generation으로 재처리됩니다(OPEN TURN).

## 4. Work Capsule과 tail baton (§4.2, §14)

`work_capsules`(workstream-scoped, `authority = context-only`): objective/current_state/verified_progress(evidence 필수)/hypotheses/blockers/open_questions/next_actions. Compact/resume 출력은 현재 목표·확인된 결과·미검증 가설·최근 정정·막힌 지점·다음 행동·근거 위치를 구분합니다. Capsule이 없으면 deterministic tail baton을 사용합니다. 미소비 workstream evidence나 미완료 capture/Capsule 작업이 있으면 `stale/context-only` 표시와 최신 source/pending 상태를 함께 냅니다. 과거 superseded 작업은 현재 상태를 stale로 만들지 않습니다. Work context 예산을 먼저 확보하고 최종 wrapper 크기까지 확인합니다. Sequence coverage와 replay 계약은 [SCHEMA.md](SCHEMA.md#sequence-cursors-schema-v7)에 있습니다. 어느 것도 fact evidence로 재진입하지 않습니다.

P1 생성은 `continuity-core.ts`의 `WORK_CAPSULE_OUTPUT_SCHEMA`를 `codex exec --output-schema`로 전달합니다. `verifiedProgress`와 `hypotheses`는 `{text, sourceExchangeIds}` 객체 배열로 생성하며 문자열 배열을 사후 변환하거나 source ID를 추정하지 않습니다. `currentState`의 schema 설명은 기존 Capsule의 유효한 결정·제약·구체적인 수치를 이어받고 새 evidence가 변경한 부분을 갱신하도록 명시합니다. 이 설명은 요약 지침이며 의미 보존의 자동 검증을 대신하지 않습니다. Schema는 호출별 임시 workdir에만 기록하고 성공·실패 모두 삭제합니다. 공통 model provider의 선택 옵션이며 Capsule 이외 호출에는 자동 적용하지 않습니다.

Capsule 한 세대의 bounded storage size는 기본 **12,000자**이며 `MEMEX_CAPSULE_MAX_CHARS`로 조정합니다(하한 2,000자). 초과한 patch는 버리지 않고 우선순위대로 줄여 저장합니다 — objective·current_state·verified_progress를 마지막까지 보존하고, touched_areas/open_questions/next_actions/hypotheses 항목 수 → carry revision(64→16→8) → blockers → evidence별 source 목록 → 텍스트 길이 → verified 항목 수 → 최상위 source 목록 순으로 줄입니다. 절단이 일어나면 `work_capsules.truncated` / `truncated_fields_json` / `original_chars`에 무엇이 줄었는지 그대로 기록하고 worker 로그에 WARN 1줄을 남깁니다(미수집을 수집으로 위장하지 않습니다). 이 상한은 Capsule projection에만 적용되며, 사용자 프롬프트 원문은 `exchanges`에 그대로 보관되고 추출은 `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS`(120,000자) 창으로 분할됩니다.

Native schema는 출력 구조만 제한합니다. 기존 validator가 길이·list 수·정확한 revision tuple·출처 선언을 검사하고, commit 시 page authority·scope·generation/lease CAS를 다시 확인합니다. Schema 미지원·잘못된 응답은 기존 bounded retry/dead 경로로 남으며 schema 없는 호출로 fallback하지 않습니다. `--json`은 이벤트 전송 형식이므로 final 응답의 구조 제약을 대신하지 않습니다. CLI의 [native schema 계약](https://learn.chatgpt.com/docs/non-interactive-mode#create-structured-outputs-with-a-schema)을 사용합니다.

## 5. Project · workspace · workstream · session (§10)

`projects`/`workspaces`/`minimal_workstreams`/`workstream_sessions`/`session_memory_state`. resolver 우선순위와 binding 규칙은 `verification/continuity-v1/phase-3-handoff.md`, 자세한 계약은 `ARCHITECTURE.md` §5, `CONVERSATION-LIFECYCLE.md`. 새 session은 생성 시점의 `projects.memory_revision`을 seen으로 시작합니다(D-026).

**디렉터리 = 프로젝트, 브랜치 = workstream (0.6.0).** 세션 시작마다 `inspectWorkspaceLocation(cwd)`이
`location_kind`/`git_common_dir`/`remote_fingerprint`/`branch`/`default_branch`(= `origin/HEAD`, 없으면
`init.defaultBranch`, 그것도 없으면 `main`·`master`)를 캡처해 workspace 행에 기록하고, 그 값이 exchange
`git_branch`와 workstream `branch_hint`로 전파됩니다. 세션의 **브랜치 신호**는 셋 중 하나입니다.

| 신호 | 조건 | workstream |
|---|---|---|
| `no-branch-signal` | 비-git 디렉터리이거나 브랜치를 못 읽음 | 프로젝트당 **기본 stream 하나**(`ws-hash(workstream-project-default-v1, project_id)`) |
| `default-branch` | 브랜치 = 저장소 기본 브랜치 | 위와 동일한 기본 stream |
| `branch:<name>` | 그 외 브랜치/워크트리 | `ws-hash(workstream-branch-v1, project_id, branch)` |

브랜치 stream은 `(project_id, branch)`로 결정론적이므로 같은 저장소의 워크트리 두 개가 같은 브랜치를
쓰면 하나의 workstream을 공유하고(워크트리는 git-common-dir 규칙으로 같은 project를 갖습니다), 브랜치가
다르면 서로 희석되지 않습니다. 세션마다 새 stream을 만들던 `ws-hash(project, session)` 폴백은 없어졌습니다.

**전이(일반 → 깃, 또는 그 반대).** 경로가 실제로 존재하면 세션 시작의 재검사가 권위이며 workspace 행의
`location_kind`/`git_common_dir`/`git_common_identity`/`git_dir_identity`/`remote_fingerprint`/`branch`를
그 자리에서 갱신합니다. `workspace_id`·`project_id`는 불변이므로 전이 이전 기억은 데이터 변경 없이
그대로 남고, 전이 이후 세션부터 브랜치 규칙이 적용됩니다. 변경이 있으면 `workspace_location_events`에
`WORKSPACE_LOCATION_CHANGED` 한 건이 남습니다. 새 common dir/remote가 이미 다른 프로젝트에 묶여 있으면
자동 병합하지 않고 `approved_remote_mappings` 명시 승인을 요구합니다(`requires_approval = 1`).
`.git`이 제거되면 행만 `directory`로 되돌리고 브랜치 tier 기억은 삭제도 자동 강등도 하지 않습니다.

## 6. Current facts · subject · Chronicle (§4.3–4.4, §15–17)

- `facts` = current projection; `(project_id, subject_key, promotion_state, workspace_id, workstream_id)` active unique slot. 추출된 fact의 기본 tier는 세션의 **브랜치 신호**가 정합니다(§5): 신호가 없으면(비-git 또는 기본 브랜치) 바로 프로젝트 공용 `project-current`, 그 외 브랜치/워크트리 세션이면 `workstream`. 근거는 `facts.tier_reason`에 남습니다(BRANCH TRUTH). 이후 이동은 사다리 `workstream ⇄ project ⇄ global`을 한 칸씩만 따르며, ① Web UI/CLI 사용자 확언 ② 근거 기반 자동(모델 호출 없이 SQL) ③ 세션 내 명시 범위 지시 세 채널 모두 Chronicle `PROMOTED`/`DEMOTED`를 남깁니다. 전체 표는 `FACT-LIFECYCLE.md` §1.
- `fact_revisions` = Chronicle(단일 append-only history table, D-018): 9 event kind(0.6.0에서 `PROMOTED`/`DEMOTED` 추가), content-hash event id, `effective_at`(source) vs `recorded_at`, grounded cause vs classifier note, `reverts_event_id`, `projection_applied`. 정책은 `FACT-LIFECYCLE.md` §13.
- `incident_occurrences`/`incident_signatures`: coalescing, independent episode, remediation, `matchIncidentPatterns`(WATCH 원천).

## 7. Context epoch · residency · Memory Broker (§11–12)

`session_memory_state`: `context_epoch`, resident/carry `(fact_id, semantic_generation, lifecycle_generation)`, `capsule_generation_seen`, `memory_revision_seen`, Phase 5 gate state(`topic_fingerprint_json`, `topic_embedding`, `informative_prompts_since_retrieval`, `last_retrieval_epoch`, `watch_emitted_json`), v7 `hot_evidence_cursor`. 자동 Hot Evidence는 실제 출력한 적격 prefix만 session/epoch별로 소비하며 예산으로 잘린 suffix는 다음 prompt에서 다시 시도합니다. cheap gate 규칙, Memory Bundle section/budget, correction semantics는 `RETRIEVAL-AND-CONTEXT.md` §4a/4b. 비용 수치는 `verification/continuity-v1/recall-calibration.json`(call/byte count만).

## 8. 자동 injection vs MCP (§13)

자동 injection은 고정 안내와 비신뢰 JSON memory를 포함한 최종 문자열을 제한합니다(normal 1,000자/추정 320 tokens, rehydration 2,000자/추정 640 tokens; 추정에 25% 여유 적용). `trace_fact`/`search_facts`/`explore_graph`는 current → Chronicle → source → other session을 bounded cursor로 탐색하는 deep path이며 gate skip의 영향을 받지 않습니다. `search_facts`는 임베딩이 없어도 scoped lexical 조회를 유지합니다. lane label: `CURRENT FACT`, `CHRONICLE EVENT`, `RAW EVIDENCE`, `ASSISTANT CONTEXT-ONLY`, `HOT EVIDENCE — NOT YET DISTILLED`.

Prompt와 compact/resume 모두 context-only 출력을 포함해 `prepared` receipt를 먼저 기록합니다.
stdout callback 성공 뒤 정확한 receipt ID만 `emitted`로 바꿉니다. Host acceptance는 별도 host 증거가
없으면 `NOT_PROVEN`이며 stdout 기록을 host 수락으로 승격하지 않습니다. 현재 버전별 시나리오 결과는
[Codex usability 검증 기록](verification/codex-usability/README.md)을 확인하십시오.

## 9. Sync · privacy (§9, §20)

protocol v5 다섯 파일에 stable project identity, subject/promotion, Chronicle event row, event tombstone row가 additive로 실립니다(D-015, D-018, D-019). 구 peer는 generation 전체를 visible reject합니다. 0.6.1부터 이 교환에는 **스위치**가 붙습니다: `<data root>/sync/config.json`의 `enabled`가 기본 `false`이고, 켜기 전에는 export/import 훅이 stderr 한 줄로 끝납니다([운영 가이드 §10](GUIDE.md#두-번째-맥-설정-절차-크로스디바이스-동기화)). privacy purge는 journal/checkpoint/job/exchange/fact/event/incident/Capsule(D-035)/vector/Hot Evidence/session state를 한 transaction에서 지우고 tombstone을 남겨 worker/sync/cache 재생성을 막습니다.

## 10. Schema와 flag

Continuity schema `7` (`PRAGMA user_version`, `continuity_schema_meta`): v1 correctness spine → v2/v3 capture guards → v4 identity → v5 Chronicle → v6 recall gate columns → v7 evidence sequence/cursor. Locked RFC의 scalar Capsule frontier에 대한 현행 amendment는 [SCHEMA.md](SCHEMA.md#sequence-cursors-schema-v7)에 있습니다. 모든 migration은 additive·idempotent·crash-injected(`test/continuity-correctness-spine.test.ts`).

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
| `MEMEX_AUTO_ONTOLOGY` | unset (on) | fact 저장 후와 SessionStart의 자동 ontology 분류 스위치. on은 미설정·빈 문자열·`1`뿐이고 그 밖의 값은 모두 off입니다. 수동 실행은 유지. 자동 재개 한도는 [운영 가이드](GUIDE.md#17-모델-작업-예산과-대기-진단) 참고 |
| `MEMEX_MCP_AUTOSTART`, `MEMEX_RUNTIME_FORCE_REMOTE`, `MEMEX_PLUGIN_ROOT` | — | MCP/launcher 진단용. `MEMEX_PLUGIN_ROOT`는 설치본 해석의 첫 단계이기도 합니다(0.6.1 #53) |
| `MEMEX_SYNC_DIR` | `<home>/conversation-index/sync` | 크로스디바이스 공유 폴더. 저장된 `sync/config.json`의 `dir`보다 우선합니다(0.6.1 #35) |
| `MEMEX_CAPSULE_MAX_CHARS` | `12000` (하한 `2000`) | Capsule 한 세대의 bounded storage size(§4). 초과 patch는 죽이지 않고 우선순위대로 절단 |
| `MEMEX_INJECT_BASELINE_MARGIN` | `0.045` (`0`–`1`) | 주입 관련성 게이트의 baseline 대비 마진(§8). 범위 밖 값은 기본값으로 되돌아감 |

사용자 대면 환경 변수의 전체 목록은 [GUIDE §19](GUIDE.md#19-환경-변수)에 있습니다.

PostCompact 등록은 optional telemetry입니다.
