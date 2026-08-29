**MEMEX**

codex/audit-remediation  
재감사 보고서

기존 감사 항목 재검증 + 신규 구조/동시성/동기화 결함 전수 점검

| 검토 대상      | BongSuCHOI/memex · codex/audit-remediation                                          |
|----------------|-------------------------------------------------------------------------------------|
| 검토 기준 HEAD | 4bc88b478f88bee968322bd61356cbe766af6ab9 (확인 당시)                                |
| 검토 일자      | 2026-08-29                                                                          |
| 검토 범위      | README/docs, src, scripts, CLI, hooks, sync, extraction, ontology, retrieval, tests |
| 목적           | 이전 감사 지적사항의 실질적 해결 여부 확인 및 수정 과정에서 새로 생긴 결함 탐지     |

[https://github.com/BongSuCHOI/memex/tree/codex/audit-remediation](https://github.com/BongSuCHOI/memex/tree/codex/audit-remediation)

# 1. Executive Summary

**최종 판정: 개선 폭은 크지만 아직 merge-ready로 보기 어렵다.**

기존 main 대비 구조적 개선은 분명하다. 특히 conversation exclusion SSOT, semantic fact mutation, dirty consolidation queue, category embedding generation, scope-aware fact search, durable recall receipt ordering은 단순 패치를 넘어 시스템 불변식을 강화하는 방향으로 구현되었다. 그러나 재감사에서 privacy lifecycle, semantic-generation concurrency, multi-device sync conflict clock, exchange identity/provenance 영역의 P1급 문제가 확인되었다.

| **구분**            | **해결** | **부분 해결** | **신규 주요 문제**        |
|---------------------|----------|---------------|---------------------------|
| 기존 13개 감사 항목 | 10개     | 3개 (2·3·5)   | P1 9개 + P2 hardening 7개 |

**핵심 공통 원인** 현재 facts.updated_at 하나가 semantic truth, ontology/metadata mutation, consolidation confirmation, activation state, sync conflict clock, ranking recency까지 동시에 대표한다. 비동기 writer와 multi-device sync가 동일한 의미 세대를 확인할 수 있는 semantic_generation이 필요하다.

**merge 권고** P1 항목을 remediation한 뒤 회귀 테스트를 추가하고, 해당 commit SHA에 build/test 실행 증거를 남긴 후 최종 감사를 다시 수행하는 것이 안전하다.

# 2. 검토 범위와 방법

- 브랜치 자체보고(AUDIT-REMEDIATION-PLAN 완료 체크)를 신뢰하지 않고 현재 코드 경로를 역추적했다.

- 기존 감사 1~13번을 각 entrypoint, DB mutation, sync, worker, 문서 계약과 대조했다.

- 수정 과정에서 새로 생기기 쉬운 race: async LLM/embed, SessionStart/SessionEnd hook, multi-device LWW, snapshot export를 별도 점검했다.

- privacy marker는 단순 인덱싱뿐 아니라 extraction→fact→sync payload까지 lifecycle 전체를 추적했다.

- 정적 코드/문서/테스트 전수 대조 기준이며, 해당 SHA의 npm test를 이 환경에서 독립 실행한 것은 아니다. 현재 GitHub head에도 CI status가 없다.

**근거 파일:** [package.json](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/package.json) — pretest → build, test → vitest run 계약 확인

# 3. 이전 감사 13개 항목 재검증

| **\#** | **항목**                                  | **판정**      | **재검증 메모**                                                                                                          |
|--------|-------------------------------------------|---------------|--------------------------------------------------------------------------------------------------------------------------|
| 1      | fact-extract-worker undeclared db         | **해결**      | let db 선언 확인. SessionEnd의 canonical success-line 검사도 유지.                                                       |
| 2      | DO NOT INDEX policy SSOT                  | **부분 해결** | sync/index/repair는 중앙화됐지만 SessionEnd extraction이 conversation-policy를 우회한다.                                 |
| 3      | semantic fact mutation generation         | **부분 해결** | mutateFactMeaning은 강해졌으나 ontology/reembed 같은 async derived writer가 generation CAS 없이 stale 결과를 쓸 수 있다. |
| 4      | shell evidence cwd locality               | **해결**      | git -C, npm --prefix, 복합 shell, network, denied roots 등 보수적 fail-closed 구현 확인.                                 |
| 5      | sync update/deactivate/revision/tombstone | **부분 해결** | protocol v2로 크게 개선. 하지만 updated_at semantic clock 혼용, TOCTOU, privacy tombstone resurrection이 남음.           |
| 6      | late-import consolidation starvation      | **해결**      | created_at cursor 대신 needs_consolidation dirty queue 사용.                                                             |
| 7      | category embedding generation/version     | **해결**      | ontology_categories.embedding_version + missing/stale repair 구현.                                                       |
| 8      | global fact search starvation             | **해결**      | fact search는 expanding KNN window로 scope filter starvation 제거. conversation vector search에는 동형 버그가 남음.      |
| 9      | contradiction lineage identity            | **해결**      | CONTRADICTION도 기존 fact identity를 보존하며 revision chain에 연결.                                                     |
| 10     | WebUI sqlite-vec connection invariant     | **해결**      | 공유 initialized DB factory 방향으로 정리된 것으로 확인.                                                                 |
| 11     | missing primary fact vector repair        | **해결**      | current-version stamp + missing vec_facts row를 pending으로 선택.                                                        |
| 12     | exact source exchange attribution         | **해결**      | LLM source_exchange_indices를 batch exchange IDs에 검증 매핑.                                                            |
| 13     | pipeline done/pending semantics           | **해결**      | watermark-aware 상태 분리 및 문서 계약 개선.                                                                             |

# 4. P1 — merge 전에 해결 권장

## P1-1. SessionEnd extraction이 DO NOT INDEX를 우회

| **P1 / Privacy** | **기존 ② 미완료** | **판정** |
|------------------|-------------------|----------|

**요약** conversation-policy는 sync/index/repair에 적용되지만 SessionEnd hook과 fact worker는 user-level exclusion을 확인하지 않는다.

**근거 파일:** [src/conversation-policy.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/conversation-policy.ts)

**근거 파일:** [src/sync.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync.ts)

**근거 파일:** [scripts/session-end-hook.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/session-end-hook.js)

**근거 파일:** [scripts/fact-extract-worker.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/fact-extract-worker.js)

**근거 파일:** [test/conversation-exclusion-entrypoints.test.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/test/conversation-exclusion-entrypoints.test.ts)

**실패 시나리오** 이미 일부 turn이 DB에 인덱싱된 장기 세션에서 마지막 user turn이 DO NOT INDEX를 선언하면, SessionEnd가 sync purge보다 먼저 기존 pending exchange에서 fact를 추출하고 sync-export까지 수행할 수 있다.

> indexed old turns  
> → final user turn: DO NOT INDEX  
> → SessionEnd  
> → \[현재\] fact extraction  
> → sync-export  
> → next SessionStart에서야 purge

**영향** 명시적 privacy 의도 이후에도 durable fact 및 cross-device payload가 잠시 생성될 수 있다. 다음 SessionStart에서 purge되더라도 privacy lifecycle 계약 위반이다.

**권장 수정** SessionEnd/worker의 extraction gate에도 getConversationEligibility()를 적용한다. user_excluded이면 extraction 전에 purge하고 extraction을 금지하며 privacy tombstone만 export하도록 순서를 고정한다.

**회귀 테스트** 부분 인덱싱된 세션 마지막 turn에 marker 삽입 → SessionEnd 실행 → fact 0, extraction 0, privacy tombstone 존재, searchable state 0을 검증한다.

## P1-2. 비동기 derived writer에 semantic generation CAS가 없음

| **P1 / Correctness** | **기존 ③ 미완료** | **판정** |
|----------------------|-------------------|----------|

**요약** mutateFactMeaning() 내부 원자성은 개선됐지만 ontology classification, relation generation, re-embed, KR vector 같은 비동기 writer가 “내가 읽은 fact 의미 세대가 아직 현재인가”를 commit 전에 검증하지 않는다.

**근거 파일:** [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

**근거 파일:** [src/ontology-classifier.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/ontology-classifier.ts)

**근거 파일:** [scripts/reembed-worker.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/reembed-worker.js)

**근거 파일:** [src/ontology-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/ontology-db.ts)

**실패 시나리오** worker가 fact A를 읽고 LLM/embedding을 기다리는 동안 edit/consolidation/sync가 같은 ID를 B로 바꾼 뒤, 오래 걸린 A의 결과가 ID만 보고 B 행에 다시 기록될 수 있다.

> read fact A @ generation=17  
> await LLM/embed  
> concurrent mutation: A → B, generation=18  
> commit stale result  
> UPDATE ... WHERE id=? AND semantic_generation=17  
> → 0 rows, discard

**영향** fact text와 vector/category/relation의 의미 세대가 갈라진다. 특히 reembed는 B 문장 + A embedding + embedding_version=current 같은 조합을 만들 수 있다.

**권장 수정** facts.semantic_generation을 도입한다. 모든 의미 변경에서 generation을 증가시키고, async worker는 시작 시 generation을 캡처한 뒤 최종 UPDATE/INSERT를 WHERE semantic_generation=? CAS로 수행한다. 0행이면 stale result를 폐기한다.

**회귀 테스트** ontology stale-result race, EN reembed race, KR vector race, relation writer race 각각에서 concurrent semantic mutation 후 stale commit이 0행인지 검증한다.

## P1-3. sync LWW conflict clock으로 updated_at을 사용

| **P1 / Data loss** | **기존 ⑤ 미완료** | **판정** |
|--------------------|-------------------|----------|

**요약** sync remoteFactWins()는 updated_at을 최신 truth로 판단하지만 ontology 분류, confirmation/provenance merge 등 비의미적 작업도 updated_at을 갱신한다.

**근거 파일:** [src/sync-import.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-import.ts)

**근거 파일:** [src/fact-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-db.ts)

**근거 파일:** [src/ontology-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/ontology-db.ts)

**근거 파일:** [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

**실패 시나리오** Device B가 “Redis 사용”을 “Postgres 사용”으로 실제 편집한 뒤, Device A에서 더 늦게 옛 Redis fact에 ontology category만 붙이면 A의 updated_at이 더 커져 sync에서 옛 문장이 승리할 수 있다.

**영향** 실제 semantic edit가 derived metadata refresh에 의해 유실될 수 있다. getTopFacts recency 또한 ontology 작업 때문에 오래된 fact를 최근 사실처럼 취급할 수 있다.

**권장 수정** semantic_generation/semantic_updated_at을 별도로 두고 sync truth conflict는 semantic clock으로만 판정한다. metadata_updated_at 또는 개별 derived generation을 분리한다. relation endpoint version도 updated_at 대신 semantic generation을 사용한다.

**회귀 테스트** 더 최근의 ontology metadata와 더 오래된 text vs 더 이전 timestamp의 실제 semantic edit를 만들어 semantic edit가 항상 승리하는지 검증한다.

## P1-4. sync import embedding await 사이 TOCTOU lost update

| **P1 / Concurrency** | **신규** | **판정** |
|----------------------|----------|----------|

**요약** remote/local winner를 transaction 밖에서 결정한 뒤 generateEmbedding()을 await하고, 이후 transaction에서 local row를 다시 version-check하지 않고 update한다.

**근거 파일:** [src/sync-import.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-import.ts)

**실패 시나리오** remote 승리 판정 직후 embedding 생성이 지연되는 동안 사용자가 local fact를 새로 편집하면, import transaction이 그 최신 local edit를 remote stale state로 덮어쓸 수 있다.

**영향** 동시 사용자 편집 유실 가능. sync가 background lifecycle에서 실행되므로 실사용 race이다.

**권장 수정** winner 판정 시 expected semantic_generation을 캡처하고 transaction commit 직전에 CAS한다. 또는 transaction 시작 후 local semantic clock을 재검증하고 remote가 여전히 승자인 경우에만 write한다.

**회귀 테스트** generateEmbedding을 인위적으로 지연시킨 동안 local semantic edit를 수행하고 import가 0-row stale conflict로 종료되는지 검증한다.

## P1-5. exchange ID가 local archivePath와 assistantLine에 의존

| **P1 / Identity & Provenance** | **신규** | **판정** |
|--------------------------------|----------|----------|

**요약** parseRolloutStream()은 md5(archivePath:userLine-assistantLine)로 exchange ID를 만든다. archivePath는 기기별 local path이고 assistantLine은 turn이 자라면 변한다.

**근거 파일:** [src/codex-rollout.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/codex-rollout.ts)

**근거 파일:** [src/sync-export.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-export.ts)

**근거 파일:** [src/conversation-policy.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/conversation-policy.ts)

**실패 시나리오** 동일 rollout을 두 기기에서 인덱싱하면 archive root 차이로 다른 exchange ID가 생성된다. 또한 마지막 turn에 tool/assistant output이 추가되면 같은 logical turn의 ID가 바뀐다.

> 현재: md5(localArchivePath + userLine + assistantLine)  
> 권장: stable(session_id + user_turn_key)  
> + content_generation 별도

**영향** cross-device fact source_exchange_ids가 local exchange와 연결되지 않아 source trace와 privacy purge가 실패할 수 있다. resume 중에는 동일 user assertion이 서로 다른 exchange로 중복될 수 있다.

**권장 수정** logical exchange identity를 session_id + stable user-turn identity로 바꾸고 content generation을 분리한다. local archive path는 location metadata일 뿐 identity 재료에서 제거한다.

**회귀 테스트** 서로 다른 archive root에서 동일 rollout parse → 같은 exchange ID. 동일 user turn이 후속 assistant/tool output으로 길어져도 logical identity 유지 또는 deterministic generation reconcile을 검증한다.

## P1-6. 재색인 시 stale exchange/tool state reconcile 누락

| **P1 / Index correctness** | **신규** | **판정** |
|----------------------------|----------|----------|

**요약** sync/index는 최신 parse 결과를 upsert하지만 같은 archive/session에서 더 이상 존재하지 않는 과거 exchange ID를 삭제하지 않는다. tool_calls도 새 set을 INSERT/REPLACE할 뿐 제거된 call을 set-reconcile하지 않는다.

**근거 파일:** [src/indexer.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/indexer.ts)

**근거 파일:** [src/sync.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync.ts)

**근거 파일:** [src/db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/db.ts)

**근거 파일:** [src/codex-rollout.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/codex-rollout.ts)

**실패 시나리오** 부분 turn이 ID A로 인덱싱된 뒤 turn이 완성되어 ID B가 생성되면 A와 B가 동시에 남을 수 있다. 동일 exchange에서 사라진 tool call도 orphan-like stale evidence로 남을 수 있다.

**영향** 검색 중복뿐 아니라 fact extraction이 동일 human assertion을 중복 증거로 보고 과거 tool evidence까지 학습할 수 있다.

**권장 수정** archive/session 단위 desired exchange ID set과 DB set을 transactionally reconcile한다. stale exchange 삭제 시 vec_exchanges, tool_calls, FTS가 함께 제거되도록 삭제 primitive를 통합한다. tool_calls도 per-exchange desired set diff를 수행한다.

**회귀 테스트** growing turn 재색인 후 logical exchange 1개만 존재, 삭제된 tool call 0개, FTS/vector set 동일성을 검증한다.

## P1-7. privacy tombstone이 일반 fact보다 최신이면 부활 가능

| **P1 / Privacy sync** | **신규** | **판정** |
|-----------------------|----------|----------|

**요약** source_conversation_excluded tombstone도 일반 hard-delete와 같은 timestamp LWW 규칙을 적용하며 tombstone보다 strictly newer fact를 restore/edit로 인정한다.

**근거 파일:** [src/conversation-policy.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/conversation-policy.ts)

**근거 파일:** [src/sync-import.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-import.ts)

**근거 파일:** [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

**실패 시나리오** A에서 DO NOT INDEX로 privacy tombstone을 만든 뒤, 삭제 사실을 모르는 offline B가 같은 fact를 더 늦게 편집하고 snapshot을 보내면 A가 privacy tombstone을 지우고 fact를 복원할 수 있다.

**영향** conversation-wide privacy instruction이 stale peer edit에 의해 되돌아간다.

**권장 수정** source_conversation_excluded를 terminal privacy tombstone으로 구분한다. 명시적인 unexclude/re-consent 이벤트 없이는 timestamp와 무관하게 resurrection을 금지한다.

**회귀 테스트** A exclude → B offline newer edit → A import → fact 미복원, tombstone 유지 테스트.

## P1-8. backfill worker claimVariant가 5번째 인자로 버려짐

| **P1 / Runtime bug** | **신규** | **판정** |
|----------------------|----------|----------|

**요약** runFactExtraction()의 options는 4번째 인자인데 backfill 경로가 {claimVariant:"worker"}를 5번째 인자로 전달한다. JS extra argument는 무시되어 기본 hook claim variant가 실행된다.

**근거 파일:** [src/fact-extractor.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-extractor.ts)

**근거 파일:** [scripts/fact-extract-worker.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/fact-extract-worker.js)

**근거 파일:** [test/backfill-worker-execution.test.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/test/backfill-worker-execution.test.ts)

**실패 시나리오** backfill 전용 선점 규칙을 의도했지만 실제 런타임은 hook variant를 사용한다. 관련 테스트가 동일한 잘못된 호출 형태면 결함을 검출하지 못한다.

**영향** backfill/SessionEnd 경쟁에서 의도한 claim/handoff semantics가 보장되지 않는다.

**권장 수정** 호출을 runFactExtraction(db, sid, project, {claimVariant:"worker"})로 수정하고 signature에 맞춘 typed wrapper를 사용해 재발을 막는다.

**회귀 테스트** pending select 후 SessionEnd가 먼저 settle → backfill worker claim_not_acquired, LLM 0회, fact 0건을 검증한다.

## P1-9. conversation vector search에도 scope/date starvation 존재

| **P1 / Retrieval** | **신규** | **판정** |
|--------------------|----------|----------|

**요약** fact search는 expanding KNN window를 도입했지만 conversation search는 sqlite-vec k=caller limit를 먼저 적용한 뒤 project/date JOIN filter를 적용한다.

**근거 파일:** [src/search.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/search.ts)

**근거 파일:** [src/fact-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-db.ts)

**실패 시나리오** limit=10에서 다른 프로젝트의 더 가까운 10개가 KNN window를 채우면 target project의 rank 11 유효 exchange는 반환되지 않는다. date filter도 동일하다.

**영향** project-scoped 검색과 기간 검색이 조용히 0~소수 결과를 반환해 recall을 낮춘다.

**권장 수정** fact search와 동일하게 KNN window를 점진 확장하거나 filter-compatible vector index 전략을 도입한다. scope/date 적용 후 caller limit을 만족하거나 index를 소진할 때까지 탐색한다.

**회귀 테스트** target project 유효 후보가 global rank limit+1에 있는 경우와 date 범위 밖 후보가 top-k를 채우는 경우를 회귀 테스트한다.

# 5. P2 — correctness / hardening

## P2-1. SQLite foreign key enforcement가 실제로 꺼져 있음

| **P2 / Integrity** | **신규** | **판정** |
|--------------------|----------|----------|

**요약** schema에는 FK가 선언되어 있지만 connection initialization에서 PRAGMA foreign_keys=ON을 설정하지 않는다.

**근거 파일:** [src/db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/db.ts)

**실패 시나리오** deleteExchange() 같은 low-level delete가 exchange만 지우면 tool_calls orphan을 남길 수 있다. 반대로 FK를 갑자기 켜면 현재 삭제 순서가 constraint error를 만들 수 있다.

**영향** 문서가 주장하는 DB-level referential integrity와 런타임이 다르며 silent orphan/향후 migration 실패 가능성이 있다.

**권장 수정** 기존 orphan audit/cleanup → FK별 ON DELETE CASCADE 또는 명시 삭제 순서 결정 → foreign_keys=ON → foreign_key_check를 적용한다.

**회귀 테스트** exchange/fact 삭제 후 PRAGMA foreign_key_check가 0행인지 검증하고 legacy DB migration fixture도 추가한다.

## P2-2. Public API가 mutation SSOT를 우회

| **P2 / API boundary** | **신규** | **판정** |
|-----------------------|----------|----------|

**요약** fact-management.ts가 single mutation SSOT를 선언하지만 src/index.ts가 fact-db.ts 전체를 public export하여 updateFact/deactivateFact/deleteFact 같은 raw mutation을 노출한다.

**근거 파일:** [src/index.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/index.ts)

**근거 파일:** [src/fact-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-db.ts)

**근거 파일:** [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

**실패 시나리오** 외부 package consumer나 미래 내부 caller가 semantic mutation 서비스의 revision/vector/ontology/relation invariant를 우회할 수 있다.

**영향** SSOT가 convention에 머물고 API로 강제되지 않는다. legacy deleteFact는 relation 정리를 하지 않아 FK가 꺼진 상태에서는 dangling relation도 가능하다.

**권장 수정** public entrypoint에서는 read/search primitive만 export하고 raw writers는 internal module로 격리한다. 필요하면 explicit unsafe/internal namespace를 둔다.

**회귀 테스트** package API surface snapshot test로 raw mutation symbol이 export되지 않는지 검증한다.

## P2-3. inactive fact restore가 embedding model upgrade와 불일치

| **P2 / Retrieval** | **신규** | **판정** |
|--------------------|----------|----------|

**요약** reembed selector는 active fact만 처리한다. inactive 동안 model version이 바뀐 fact를 restore하면 stored stale embedding을 vec_facts에 재삽입하지만 embedding_version은 stale 상태다.

**근거 파일:** [src/reembed-selector.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/reembed-selector.ts)

**근거 파일:** [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

**근거 파일:** [src/fact-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-db.ts)

**실패 시나리오** restoreFact()는 vectorRestored=true를 반환하지만 searchFactsByScope는 current embedding_version row만 읽으므로 reembed worker 전까지 semantic search에서 보이지 않는다.

**영향** CLI 성공 보고와 실제 검색 가능 상태가 불일치한다.

**권장 수정** restore를 async semantic operation으로 바꾸거나, stored version=current일 때만 embedding 재사용하고 stale이면 current model로 재임베딩한 뒤 vector+stamp를 함께 복원한다.

**회귀 테스트** inactive stale-version fact restore 직후 semantic search에서 조회되는지 검증한다.

## P2-4. SessionStart 문서 순서와 실제 async hook 실행 불일치

| **P2 / Lifecycle** | **신규** | **판정** |
|--------------------|----------|----------|

**요약** 문서는 drift → sync → sync-import → maintenance 순서를 계약으로 기술하지만 hooks.json에서는 네 명령이 모두 독립 async이고, sync --background는 다시 detached child를 만든다.

**근거 파일:** [docs/CONVERSATION-LIFECYCLE.md](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/docs/CONVERSATION-LIFECYCLE.md)

**근거 파일:** [hooks.json](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/hooks.json)

**근거 파일:** [src/lifecycle.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/lifecycle.ts)

**근거 파일:** [src/sync-cli.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-cli.ts)

**실패 시나리오** maintenance가 sync/import보다 먼저 실행될 수 있고 import가 이전 snapshot만 읽는 등 completion order가 비결정적이다.

**영향** 대부분 다음 SessionStart에 eventual recovery되지만 문서상 ordered pipeline invariant는 성립하지 않는다.

**권장 수정** 순서가 필요하면 하나의 async coordinator 안에서 await/barrier를 둔다. 순서가 필요 없으면 문서와 status semantics를 eventual-consistency로 수정한다.

**회귀 테스트** hook coordinator integration test에서 실제 completion order를 기록·검증한다.

## P2-5. sync snapshot export가 파일-set atomic generation이 아님

| **P2 / Sync durability** | **신규** | **판정** |
|--------------------------|----------|----------|

**요약** exportForSync()는 facts/revisions/tombstones/recall/ontology/meta JSONL을 순차적으로 직접 overwrite한다. DB read snapshot transaction과 filesystem generation commit이 없다.

**근거 파일:** [src/sync-export.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-export.ts)

**실패 시나리오** process crash, cloud sync observation, concurrent export가 중간에 끼면 facts=N+1, revisions=N, relations=N+1 같은 혼합 snapshot이 만들어질 수 있다.

**영향** import가 존재하지 않았던 논리 상태를 관측하고 lineage/relation/tombstone 완전성이 깨질 수 있다.

**권장 수정** devices/\<id\>/generations/\<uuid\>.tmp에 한 generation을 작성하고 완료 후 atomic rename, 마지막에 CURRENT manifest를 원자 교체한다. import는 committed generation만 읽는다. DB reads도 read transaction으로 고정한다.

**회귀 테스트** export 중간 강제 종료 fixture에서 incomplete generation이 importer에 의해 무시되는지 검증한다.

## P2-6. SessionEnd sync-export 실패가 사실상 무음

| **P2 / Observability** | **신규** | **판정** |
|------------------------|----------|----------|

**요약** sync-export-hook.js는 오류를 stderr에 쓰고 exit 0으로 끝내며, 부모 session-end-hook.js는 child 반환 code/stdout/stderr를 검사하지 않는다.

**근거 파일:** [scripts/session-end-hook.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/session-end-hook.js)

**근거 파일:** [scripts/sync-export-hook.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/sync-export-hook.js)

**실패 시나리오** extraction은 성공했지만 sync export가 실패해도 SessionEnd lifecycle은 정상 종료로 보인다.

**영향** 즉시 local data corruption은 아니지만 multi-device convergence 실패를 사용자가 알기 어렵다.

**권장 수정** export 실패를 lifecycle을 wedge하지 않는 별도 durable status로 기록하고 stderr/doctor/status에서 노출한다. parent가 child output을 검사하여 EXPORT_FAILED 이벤트를 남긴다.

**회귀 테스트** exportForSync를 강제로 throw시켜 session은 종료되되 status/log에 failure가 남고 다음 lifecycle에서 retry되는지 검증한다.

## P2-7. malformed sync JSONL이 reported되지 않고 조용히 drop

| **P2 / Observability** | **문서-런타임 불일치** | **판정** |
|------------------------|------------------------|----------|

**요약** 문서는 malformed external rows를 uncommitted/reported한다고 기술하지만 readJsonLines()의 JSON.parse catch는 행을 단순 skip한다.

**근거 파일:** [src/sync-import.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-import.ts)

**근거 파일:** [docs/CONVERSATION-LIFECYCLE.md](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/docs/CONVERSATION-LIFECYCLE.md)

**실패 시나리오** 부분 손상된 sync file에서 행이 존재하지 않았던 것처럼 처리된다.

**영향** 데이터 유실/손상 원인을 진단하기 어렵고 외부 데이터 경계의 fail-loud 계약이 약해진다.

**권장 수정** malformedRows, file, lineNumber를 결과/로그에 누적하고 status/doctor에서 노출한다. 유효 행은 계속 import하되 손상을 숨기지 않는다.

**회귀 테스트** 한 줄 malformed + 한 줄 valid JSONL fixture에서 valid는 import되고 malformed count/log가 1인지 확인한다.

# 6. 추가 개선 권장 — freshness와 운영 일관성

- Summary freshness: rollout이 resume되어 길어져도 기존 -summary.txt가 존재하면 재생성되지 않을 수 있다. source fingerprint 또는 archive content hash를 summary metadata와 묶어 stale invalidation을 권장한다.

- sync-export root mirror(v1 compatibility)와 device snapshot(v2)을 동시에 쓰는 동안 protocol transition 정책을 명시해야 한다. v2 importer가 root+device를 모두 읽으므로 중복/오래된 mirror의 우선순위가 장기적으로 복잡해질 수 있다.

- docs에서 “updated_at 최신 event가 fact conflict winner”라고 명시한 부분은 semantic clock 분리 후 문서도 함께 수정해야 한다.

# 7. 공통 구조 원인과 권장 아키텍처

현재 facts 한 row에는 서로 수명이 다른 상태가 함께 존재한다.

| **상태 종류**            | **현재 대표 필드/예시**                                                |
|--------------------------|------------------------------------------------------------------------|
| Primary semantic truth   | fact, scope_type, scope_project, active state                          |
| Evidence / lineage       | source_exchange_ids, consolidated_count, revisions                     |
| Derived state            | embedding, embedding_version, fact_kr, ontology_category_id, relations |
| Operational state        | needs_consolidation, attempts, ontology_last_attempt_at                |
| Conflict / ranking clock | updated_at 하나가 모든 mutation에 의해 변경                            |

> facts  
> ├─ semantic_generation  
> ├─ semantic_updated_at  
> ├─ fact / scope / active  
> ├─ evidence metadata  
> └─ processing metadata  
>   
> derived artifacts  
> ├─ primary vector @ semantic_generation  
> ├─ KR vector @ semantic_generation  
> ├─ ontology @ semantic_generation  
> └─ relation @ source_generation + target_generation

핵심 규칙은 다음 하나로 수렴할 수 있다.

> **“Fact 의미가 바뀌면, 그 의미에서 파생된 모든 representation은 동일 semantic_generation을 가리키거나 invalid 상태여야 한다.”**
>
> async worker 시작  
> expected_generation = fact.semantic_generation  
>   
> ... LLM / embedding / remote IO ...  
>   
> COMMIT:  
> UPDATE facts  
> SET ...  
> WHERE id = :id  
> AND semantic_generation = :expected_generation  
>   
> changes == 0 → stale result 폐기

# 8. 권장 remediation 순서

**Phase 1 — Privacy & correctness gate** — SessionEnd exclusion gate, terminal privacy tombstone, backfill claimVariant를 먼저 닫는다.

**Phase 2 — Semantic generation** — semantic_generation / semantic_updated_at migration 후 ontology/reembed/KR/relation/consolidation/sync writers를 CAS로 전환한다.

**Phase 3 — Sync semantics** — updated_at LWW를 semantic clock으로 교체하고 sync-import TOCTOU를 CAS로 제거한다.

**Phase 4 — Exchange identity** — cross-device canonical exchange identity를 설계하고 재색인 stale-set reconciliation을 구현한다.

**Phase 5 — Retrieval & DB hardening** — conversation vector overfetch, FK enforcement, public mutation API boundary, restore version 처리.

**Phase 6 — Sync durability & observability** — atomic generation snapshot, export retry/status, malformed row reporting, lifecycle ordering/summary freshness.

# 9. 필수 회귀 테스트 매트릭스

| **ID**  | **영역**                  | **시나리오**                                            | **기대 결과**                                                 |
|---------|---------------------------|---------------------------------------------------------|---------------------------------------------------------------|
| **T01** | SessionEnd privacy        | partial indexed session + final DO NOT INDEX            | fact/extraction 0, searchable state 0, privacy tombstone 유지 |
| **T02** | Privacy resurrection      | A exclude, B offline newer edit, A import               | privacy fact 부활 금지                                        |
| **T03** | Ontology generation race  | classification 대기 중 semantic edit                    | stale category write 0                                        |
| **T04** | Primary reembed race      | embed(A) 중 A→B mutation                                | A vector가 B에 기록되지 않음                                  |
| **T05** | KR reembed race           | KR embed 대기 중 semantic edit/translation invalidation | stale KR vector 기록 금지                                     |
| **T06** | Sync TOCTOU               | remote embed 대기 중 local edit                         | remote stale update가 local edit를 덮지 않음                  |
| **T07** | Semantic conflict clock   | metadata가 더 최신, semantic edit가 더 중요             | semantic edit가 winner                                        |
| **T08** | Canonical exchange ID     | same rollout, different archive roots                   | 동일 logical exchange ID                                      |
| **T09** | Growing turn reconcile    | assistant/tool output 추가 후 reindex                   | 최신 logical exchange만 존재                                  |
| **T10** | Tool-call reconcile       | reindex 시 tool call set 감소                           | 삭제된 tool call 잔존 0                                       |
| **T11** | Backfill worker claim     | select 후 SessionEnd settle                             | claim_not_acquired, LLM 0                                     |
| **T12** | Project vector starvation | valid target project hit at global rank limit+1         | target hit 반환                                               |
| **T13** | Date vector starvation    | 범위 밖 hits가 top-k 점유                               | 범위 안 hit 반환                                              |
| **T14** | Restore model upgrade     | inactive stale embedding version restore                | 즉시 current vector/version 검색 가능                         |
| **T15** | FK integrity              | exchange/fact delete                                    | foreign_key_check 0 rows                                      |
| **T16** | Snapshot interruption     | export 중간 crash                                       | incomplete generation import 금지                             |
| **T17** | SessionStart ordering     | async lifecycle invocation                              | 계약된 barrier 순서 검증 또는 eventual 문서 일치              |
| **T18** | Summary freshness         | resume 후 source 변경                                   | old summary stale 판정 및 재생성                              |

# 10. Merge Gate 체크리스트

- [ ] P1-1 SessionEnd privacy exclusion이 extraction보다 먼저 실행된다.

- [ ] source_conversation_excluded tombstone은 명시적 unexclude 없이는 sync에서 부활하지 않는다.

- [ ] semantic_generation/semantic_updated_at이 schema와 migration에 존재한다.

- [ ] ontology, reembed, KR vector, relation, consolidation, sync import의 async write가 generation CAS를 사용한다.

- [ ] sync winner가 generic updated_at이 아니라 semantic clock을 사용한다.

- [ ] sync import가 embedding await 이후 local semantic generation을 다시 검증한다.

- [ ] exchange identity가 local archive path에 의존하지 않는다.

- [ ] rollout 재색인이 exchange/tool desired set을 reconcile한다.

- [ ] backfill claimVariant worker가 실제 4번째 options 인자로 전달된다.

- [ ] conversation vector search가 scope/date filter 전에 caller limit으로 잘리지 않는다.

- [ ] foreign_keys=ON 이후 모든 삭제 경로/CASCADE가 통과하고 foreign_key_check가 0이다.

- [ ] raw fact mutation primitive가 public package API에서 노출되지 않는다.

- [ ] restore된 stale-version fact가 즉시 current embedding generation을 가진다.

- [ ] sync snapshot이 generation 단위 atomic commit을 사용한다.

- [ ] 해당 merge 후보 SHA에서 build + test + package/runtime E2E 결과가 보존된다.

# 11. 재감사에서 유지해도 되는 개선 사항

**Shell evidence trust boundary** project cwd 밖 target, git -C, npm --prefix, 복합 shell, network command, find -exec, rg/grep --pre, denied roots를 보수적으로 non-learnable 처리.

**Fact semantic mutation service** revision → text → embedding/vector → KR/ontology/relation invalidation → dirty queue를 한 transaction 경계로 만든 방향은 적절.

**Scope-aware fact retrieval** sqlite-vec의 metadata filter 한계를 expanding KNN window로 보완하여 global/project starvation 제거.

**Dirty consolidation queue** created_at 기반 cursor를 제거해 late imported fact가 영구 누락되는 문제 해소.

**Category embedding generation** ontology_categories.embedding_version을 두고 missing/stale category vector를 repair.

**Injection receipt ordering** durable prepared recall receipt를 ledger보다 먼저 기록해 fail-closed provenance 계약 강화.

**Canonical project identity** parseConversationFile까지 basename 대신 canonical absolute cwd를 사용.

**Exact source attribution** source_exchange_indices를 검증해 fact별 실제 supporting exchange ID를 저장.

# 12. 주요 소스 파일 인덱스

- [src/conversation-policy.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/conversation-policy.ts)

- [scripts/session-end-hook.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/session-end-hook.js)

- [scripts/fact-extract-worker.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/fact-extract-worker.js)

- [src/fact-extractor.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-extractor.ts)

- [src/fact-management.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-management.ts)

- [src/fact-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/fact-db.ts)

- [src/ontology-classifier.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/ontology-classifier.ts)

- [src/ontology-db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/ontology-db.ts)

- [scripts/reembed-worker.js](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/scripts/reembed-worker.js)

- [src/sync-import.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-import.ts)

- [src/sync-export.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-export.ts)

- [src/sync.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync.ts)

- [src/search.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/search.ts)

- [src/db.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/db.ts)

- [src/codex-rollout.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/codex-rollout.ts)

- [src/indexer.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/indexer.ts)

- [src/index.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/index.ts)

- [src/lifecycle.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/lifecycle.ts)

- [src/sync-cli.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/src/sync-cli.ts)

- [hooks.json](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/hooks.json)

- [docs/CONVERSATION-LIFECYCLE.md](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/docs/CONVERSATION-LIFECYCLE.md)

- [test/conversation-exclusion-entrypoints.test.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/test/conversation-exclusion-entrypoints.test.ts)

- [test/backfill-worker-execution.test.ts](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/test/backfill-worker-execution.test.ts)

- [package.json](https://github.com/BongSuCHOI/memex/blob/codex/audit-remediation/package.json)

# 13. 최종 결론

**이 브랜치는 이전 main보다 구조적으로 확실히 좋아졌다.** 그러나 privacy lifecycle, semantic-generation concurrency, sync conflict semantics, exchange identity/provenance에서 아직 P1급 결함이 남아 있으므로 즉시 merge보다 1회의 추가 remediation이 적절하다.

특히 P1-2·P1-3·P1-4는 각각의 증상을 따로 패치하기보다 semantic_generation이라는 공통 불변식으로 해결하는 편이 장기적으로 단순하고 안전하다. P1-5·P1-6 역시 canonical logical exchange identity와 content generation/reconciliation을 분리하는 하나의 설계 수정으로 묶는 것이 좋다.

**권장 다음 상태: P1 remediation → 회귀 테스트 T01~T18 → exact SHA build/test evidence → 최종 재감사 → main merge**
