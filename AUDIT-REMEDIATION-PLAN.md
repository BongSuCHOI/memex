# Memex consistency audit remediation plan

## 1. 문서 목적과 판정 범위

이 문서는 2026-08-28 `main`을 기준으로 수행됐다고 보고된 외부 GPT 감사 결과와 후속 질의응답을 하나의 실행 계약으로 정리한다.

- 감사 입력 범위: 루트 `README.md`, `/docs`의 12개 문서, 저장소 tree, `src/`, `scripts/`, `hooks.json`, `ui/`, sync/import/export, extraction/consolidation/ontology/vector 경로, 관련 테스트와 최근 변경
- 감사 방식: `dist/`를 독립 설계 소스로 중복 판독하지 않고 TypeScript source와 runtime script 연결 확인에 사용
- 작성 시 로컬 checkout: `main` / `44718ed`
- 제한: 이 문서는 전달받은 감사 결과를 누락 없이 구조화한 backlog다. 각 finding은 아직 현재 checkout에서 독립 재현하지 않았으므로 구현 착수 전 상태는 `REPORTED`, 실제 동작은 `NOT_PROVEN`이다.
- 이 문서의 완료 범위: 우선순위 1~13, 잔여 정합성 6묶음, 회귀 시나리오 17개, 최종 consistency audit

결론: **우선순위 1~13과 기존 12개 회귀 테스트만으로 이번 감사에서 발견된 전체 문제가 해결되지는 않는다.** 잔여 정합성 6묶음과 추가 회귀 테스트 5개까지 처리한 뒤 full consistency audit을 다시 수행해야 한다.

## 2. 전체 판정

Memex의 상위 아키텍처는 근본적으로 모순되지 않는다.

```text
대화 원본 보존
→ 검색용 전체 대화
→ evidence-filtered fact 추출
→ fact consolidation
→ ontology/graph
→ scoped retrieval
→ bounded injection
→ recall provenance로 self-ingestion 방지
```

강점은 레이어 분리, local-first 방향, extraction claim/watermark, assistant/recall 비학습 경계, 수동 fact mutation transaction, explicit scope, CodexExec 격리다.

주요 결함은 두 종류다.

1. 같은 불변식을 여러 진입점이 따로 구현해 서로 drift한다.
2. fact 의미가 변할 때 파생 상태 전체를 같은 generation으로 교체하거나 invalidate하지 않는다.

감사 요약:

| 영역 | 판정 | 핵심 |
| --- | --- | --- |
| 전체 아키텍처 | 좋음 | 레이어 분리와 local-first 방향 일관 |
| Conversation 저장/색인 | 주의 | user exclusion 정책이 ingestion entrypoint마다 다름 |
| Fact 추출 | 설계 좋음 / 런타임 결함 보고 | SessionEnd worker의 undeclared `db` |
| Evidence trust | 위험 | shell 관측이 cwd 경계를 우회할 수 있음 |
| Consolidation/self-improvement | 구조적 결함 | fact text만 바뀌고 vector/ontology/graph는 이전 generation에 남음 |
| Fact lineage | 부분 단절 | CONTRADICTION에서 current fact와 revision chain ID가 갈라짐 |
| Ontology | 설계 좋음 / generation 결함 | category vector에 embedding version 없음 |
| Retrieval/scope | 대체로 좋음 | MCP global fact 검색 starvation 가능 |
| Injection | 안전 방향 / 복구성 결함 | receipt와 ledger 쓰기 순서가 뒤집힘 |
| Compaction | 일관적 | compacted/replacement history를 knowledge turn으로 재구성하지 않음 |
| User marker | 정책 좋음 / 구현 분산 | `sync`와 `index`의 의미가 다름 |
| Web UI | 설계 좋음 / 초기화 위험 | mutation connection이 sqlite-vec 초기화 계약을 공유하지 않음 |
| Sync/multi-device | 큰 결함 | full semantic round-trip이 아님 |
| Generation transition | 큰 결함 | fact/exchange 외 category vector 등의 generation 관리 누락 |
| Pipeline observability | 부분 불일치 | 같은 세션이 `done`이면서 `pending`일 수 있음 |
| 문서↔코드 | drift | confidence와 rebuild 가능성 등의 설명이 실제 코드와 다름 |

## 3. 보존해야 할 기존 불변식

다음 영역은 감사에서 잘 맞물리는 것으로 평가됐다. 수정 과정에서 약화하지 않는다.

| 영역 | 보존할 계약 |
| --- | --- |
| Extraction claim | owner token, lease renewal, stale claim recovery 분리 |
| Watermark | `last_exchange_rowid` 기반 resume suffix 처리 |
| Atomic extraction | fact 저장과 completion marker를 같은 transaction에 기록 |
| LLM transient failure | 빈 response도 실패로 보고 bounded retry 후 fail-loud |
| Codex model isolation | ephemeral, user config/rules 무시, read-only sandbox, temp workdir, recursion guard |
| Self-ingestion | assistant-generated와 Memex recall은 searchable이지만 fact evidence로 non-learnable |
| Recall provenance | `prepared → stdout → emitted` 상태 모델 |
| Conversation insert | exchange/vector/tool provenance를 한 transaction에 기록 |
| Manual fact edit | semantic mutation의 기준 구현 |
| Ontology prompt safety | taxonomy text sanitize, structured JSON, missing/stale category ID repair |
| Graph scope | traversal 각 hop에서 scope 적용, deterministic relation priority |
| MCP scope | cwd 추측 없이 project/global/all 명시 |
| Version drift | stale detached worker 정리와 live MCP 보존 경계 |
| User marker detection | user-role payload만 검사해 source code 속 marker로 인한 false exclusion 방지 |
| Compaction | compacted summary/replacement history를 원래 human evidence로 세탁하지 않음 |

Compaction 관련 결론:

```text
Codex compaction output
≠ 새로운 human evidence
≠ 원 대화의 재구성 source
```

이 정책은 `assistant_generated = searchable but non-learnable`, `memex_recall = searchable but non-learnable` 원칙과 일치한다. 변경 대상이 아니라 보존 대상이다.

## 4. 실행 순서

### Phase 1 — 구조/정확성 수정

아래 우선순위 1~13을 모두 처리한다.

### Phase 2 — 잔여 정합성 수정

Section 6의 6개 cleanup 묶음을 모두 처리한다.

### Phase 3 — 회귀 테스트

Section 7의 기존 제안 12개와 후속 추가 5개, 총 17개 시나리오를 검증한다.

### Phase 4 — full consistency audit

Section 8의 end-to-end 불변식을 기준으로 문서, 코드, 테스트, 저장 상태를 다시 감사한다.

최종 안정 기준:

- 새 P0/P1 없음
- 문서↔코드↔테스트가 같은 invariant를 말함
- 의미가 같은 상태가 여러 저장소에 있을 때 같은 semantic generation임
- 모든 required check와 해당 Manual QA가 관측됨
- 미관측 항목은 `NOT_PROVEN`으로 남고 완료로 표시되지 않음

## 5. 우선순위 1~13

### 1. P0 — SessionEnd fact extraction worker 런타임 회귀

보고된 원인:

```js
try {
  db = initDatabase();
} finally {
  db?.close();
}
```

`scripts/fact-extract-worker.js`에서 `db`가 선언되지 않았다. 패키지는 `"type": "module"`이므로 ESM strict mode에서 `ReferenceError`가 발생한다.

보고된 영향:

```text
SessionEnd
→ transcript 안정화
→ 실제 대화 확인
→ fact-extract-worker
→ ReferenceError: db is not defined
→ ERROR 출력
→ extraction 미완료 판정
→ sync-export 생략
```

필수 수정:

- `let db` 선언 복원
- `SESSION_ID` 없이 조기 종료하는 smoke test가 아니라 실제 indexed exchange를 사용하는 SessionEnd worker E2E 추가
- canonical success line `worker: session=... extracted=N saved=N`과 `ERROR/FATAL/SKIPPED` 부재 확인

완료 증거:

- 실제 SessionEnd 경로에서 worker 성공
- extraction completion과 sync-export 조건 관측

### 2. P0 — `DO NOT INDEX` 의미의 ingestion entrypoint drift

보고된 원인:

- `sync.ts`의 `conversationIsExcluded()`는 raw 파일 전체가 아니라 `role=user` payload 속 marker만 검사한다.
- `indexConversations()`, `indexSession()`, `indexUnprocessed()`는 동일 user marker 정책을 적용하지 않는다.
- marker가 뒤늦게 추가돼도 이미 저장된 exchange/FTS/vector를 제거하지 않는다.

보고된 영향:

```text
memex sync  → DO NOT INDEX 존중
memex index → DO NOT INDEX 무시 가능
```

현재 실질 의미는 “처음 발견했을 때 색인하지 않음”에 가깝다. UX가 “이 대화를 Memex index에서 제외”를 뜻한다면 retroactive 동작과 불일치한다.

필수 결정:

| 정책 | 의미 |
| --- | --- |
| prospective | marker 이후 신규 indexing만 중단 |
| conversation-wide | 기존 exchanges/FTS/vector까지 purge |

감사 권고는 현재 문구에 자연스러운 `conversation-wide`다.

필수 수정:

- `src/conversation-policy.ts` 같은 단일 policy SSOT 도입
- `getConversationEligibility()`, `isUserExcludedConversation()`, `purgeConversationFromIndex()` 같은 공통 primitive 검토
- `sync`, `indexConversations`, `indexSession`, `indexUnprocessed`, `reindex`, summary generation 모두 공통 정책 사용
- purge 정책이면 DB row, FTS, vector, 관련 derived state의 정확한 cleanup 범위 정의

### 3. P1 — consolidation을 semantic fact mutation service로 통합

보고된 원인:

- 수동 `fact-management.editFact()`은 revision, text, embedding, `vec_facts`, embedding version, KR vector invalidation, ontology reset, relation removal을 한 transaction에서 처리한다.
- 자동 `applyConsolidationResult()`의 EVOLUTION/CONTRADICTION은 text와 일부 metadata만 `updateFact()`한다.
- `updateFact()`는 embedding이 전달될 때만 vector를 교체한다.

가능한 불일치:

```text
facts.fact             = PostgreSQL 의미
facts.embedding        = 과거 SQLite 의미
vec_facts              = 과거 SQLite 의미 공간
ontology_category_id   = 과거 분류
ontology_relations     = 과거 문장 기반 edge
embedding_version      = current로 보일 수 있음
```

필수 수정:

```text
mutateFactMeaning({ factId, newText, reason, source, lineageMode })
→ revision
→ embedding
→ primary vector
→ KR invalidation
→ ontology pending
→ relation invalidation
→ single commit
```

이 primitive를 manual edit, EVOLUTION, CONTRADICTION의 공통 SSOT로 사용한다. sync
update는 원격 semantic generation을 그대로 복제하는 별도 reconcile 경로다 —
mutateFactMeaning은 fact_kr을 무효화하고 로컬 시각의 revision을 새로 만들어 원격
generation identity(updated_at)를 훼손하므로, replication은 원격 상태를 기록하고
revision을 data로 수입한다.

핵심 invariant:

> Fact 의미가 변하면 의미에서 파생된 모든 상태는 같은 generation 안에서 교체되거나 invalidated되어야 한다.

### 4. P1 — shell evidence에 cwd-locality proof 적용

보고된 원인:

- `read`, `read_file`, `grep`, `view_image` 파일 tool은 target path가 canonical project cwd 내부인지 검사한다.
- shell/exec는 command 문자열 앞부분만 보고 `repo_file`, `git_history`, `test_execution` 등 learnable evidence로 분류할 수 있다.

우회 예:

```bash
grep foo /private/other-project/config
jq . /tmp/external.json
find /Users/me/secret-project ...
git -C /some/other/repo log
npm --prefix ../other-project test
```

필수 수정:

- 단순 regex 증설보다 `trusted command → observation target proof` 구조 도입
- target path와 effective cwd를 canonicalize
- project cwd 밖, Memex data root, `$CODEX_HOME/sessions`, model workdir, target 불명확 상태는 fail-closed `learnable=false`
- command wrapper, `-C`, `--prefix`, 상대경로, pipeline/redirect가 실제 관측 경계를 바꾸는 경우 포함

### 5. P1 — sync를 revision/tombstone-aware reconciliation로 변경

보고된 원인:

현재 export 포함:

```text
active facts
ontology domains
ontology categories
ontology relations
```

현재 export 누락:

```text
inactive/superseded facts
fact_revisions
recall_events
extraction_log/watermarks
fact tombstones/deletions
consolidation progress
```

import는 같은 ID가 있으면 `updated_at` 비교 없이 skip한다. active-only export에는 deactivate/tombstone 사건이 없다. relations 전체를 export하면서 facts는 active만 export하면 inactive endpoint relation이 import에서 탈락할 수 있다.

보고된 영향:

- 다른 기기가 같은 fact의 newer edit를 받지 못함
- deactivate/delete가 다른 기기에 전파되지 않음
- current truth, revision lineage, safety provenance가 기기마다 갈라짐
- 현재 sync는 full truth replication이 아니라 신규 active fact append/import에 가까움

필수 수정:

- revision/tombstone-aware reconciliation protocol 정의
- deterministic conflict rule과 `updated_at`/generation 비교 정의
- inactive/superseded fact와 revision history 전파 정책 정의
- recall provenance 등 rollout만으로 재구축 불가한 durable safety state 보존 방식 정의
- relation endpoint와 fact export 범위 일치

### 6. P1 — consolidation cursor를 ingestion/dirty queue로 변경

보고된 원인:

- worker가 `(created_at, id)` keyset cursor를 저장한다.
- sync-import는 원격 fact의 과거 `created_at`을 보존한다.
- cursor보다 오래된 fact가 늦게 import되면 검색 가능하지만 consolidation 대상에서 영구 누락될 수 있다.
- SessionStart의 sync-import와 maintenance/consolidation이 모두 async라 멀티기기에서 자연스럽게 발생할 수 있다.

필수 수정 후보:

```text
facts.ingested_at
facts.needs_consolidation
```

또는:

```text
fact_processing_queue(fact_id, reason, enqueued_at)
```

`created_at`은 지식의 역사 시각이다. 로컬 처리 순서 cursor로 사용하지 않는다.

### 7. P1 — 모든 vector index에 embedding generation/version 도입

보고된 원인:

- facts/exchanges는 embedding version을 가진다.
- `vec_categories`는 `id + embedding`만 있고 model/version metadata가 없다.
- category index self-heal은 live/stale category ID 존재만 확인한다.
- model v1→v2 전환 뒤 category vector가 v1 공간에 남아도 healthy로 보일 수 있다.

필수 수정:

- `ontology_categories.embedding_version` 또는 category vector generation metadata 도입
- model/version 변경 시 category 전체 reembed queue 등록
- 서로 다른 vector space 간 distance 계산 방지
- fact, exchange, category와 향후 vector index의 공통 generation 계약 정의

### 8. P2 — scope-aware fact search SSOT 통합

보고된 원인:

- `ask_avatar(scope:"global")`은 `searchSimilarFactsSameScope()`를 사용한다.
- MCP `search_facts`, `trace_fact`는 전체 KNN top-N 뒤 global filter를 적용한다.
- 가까운 project fact가 top-N을 채우면 존재하는 global fact가 starvation될 수 있다.

필수 수정:

- 모든 caller가 하나의 scope-aware fact search API 사용
- project/global/all semantics와 overfetch/limit 적용 순서 통일

### 9. P1 — current fact에서 predecessor lineage 추적 보장

보고된 원인:

CONTRADICTION에서 old fact A를 deactivate하고 revision을 A에 기록하지만 new/current fact B에는 predecessor 링크가 없다.

```text
A inactive
└─ revision: A → B

B active/current
└─ revision 없음
```

`trace_fact(B)`와 Web UI provenance에서 “무엇을 대체해 현재 truth가 됐는가”를 찾을 수 없다.

필수 설계 선택:

1. CONTRADICTION도 existing fact ID를 current identity로 유지하고 semantic mutation 수행
2. immutable generation 모델이면 `supersedes_fact_id` 또는 `fact_lineage(parent_fact_id, child_fact_id, relation)` 도입

두 모델을 혼합하지 않는다.

### 10. P2 — Web UI DB connection을 shared initialized factory로 변경

보고된 원인:

- 정상 `initDatabase()`는 connection마다 `sqliteVec.load(db)`를 호출한다.
- Web UI는 `new Database(DB_PATH)`로 writable connection을 직접 생성한다.
- `fact-management` mutation은 해당 connection으로 `vec_facts`를 DELETE/INSERT한다.
- sqlite virtual-table module registration은 connection-local이다.

감사 판정은 정적 코드 기준의 강한 런타임 위험이며 실제 실패는 아직 `NOT_PROVEN`이다.

필수 수정:

- `openReadDb()`, `openWriteDb()` 등 connection factory 공유
- 모든 CLI/Web UI connection이 `db.ts` 초기화 invariant를 통과
- 실제 vec0 DB에서 Web UI mutation E2E 실행

### 11. P1 — current-version fact의 missing primary vector self-heal

보고된 원인:

- conversation reembed selector는 stale version 또는 current version인데 missing `vec_exchanges` row를 복구한다.
- fact reembed worker는 `embedding_version != current`만 본다.
- maintenance도 stale version 또는 missing KR vector만 spawn 조건에 포함하고 missing primary `vec_facts`는 놓친다.

필수 수정:

- fact selector와 maintenance에 current-version + missing `vec_facts` 복구 조건 추가
- conversation과 fact self-heal 대칭성 확보

### 12. P2 — precise source exchange attribution

보고된 원인:

- extractor는 5개 exchange batch로 LLM에 fact를 요청한다.
- output에는 source exchange index/evidence ID가 없다.
- 저장 단계는 처리 suffix의 모든 exchange ID를 모든 fact에 동일하게 넣는다.

영향:

- learning safety는 유지되지만 provenance가 실제 근거가 아니라 “해당 extraction run이 다룬 conversation suffix”가 됨
- `trace_fact`, CONTRADICTION, EVOLUTION 설명 가능성 저하

필수 수정 후보:

```json
{
  "fact": "...",
  "source_exchange_indices": [1, 3]
}
```

서버에서 index를 실제 exchange UUID로 검증·변환한다.

### 13. P2 — pipeline counters 의미 정리

보고된 원인:

- resume suffix 때문에 pending은 watermark를 비교한다.
- done은 기존 success marker를 그대로 센다.
- 한 세션이 `done=1`, `pending=1`에 동시에 포함될 수 있다.

필수 수정:

- `done`을 `settled AND watermark current`로 재정의하거나
- 이름을 `settled_markers`, `pending_work`처럼 실제 의미로 변경
- Web UI `/pipeline` 운영 판단에서 상호배타성 또는 명확한 중첩 의미 보장

## 6. 우선순위 1~13 뒤 남는 정합성 6묶음

### A. Injection write ordering

현재 보고된 순서:

```text
appendLedger()
→ recordRecallEvent(prepared)
→ context return
```

receipt 저장 실패 시 context는 fail-closed로 미주입되지만 ledger에는 “주입됨”이 남아 다음 prompt dedup으로 복구 기회를 잃을 수 있다.

필수 정리:

```text
durable prepared receipt
→ ledger update
→ context return
→ stdout
→ emitted
```

또는 ledger를 receipt ID와 함께 원자적으로 묶는다.

### B. Fact confidence 문서 정정

보고된 실제 모델:

- `confidence`는 `ExtractedFact`에만 존재
- extractor의 `>=0.7` acceptance gate에서 사용 후 저장하지 않음
- `Fact` 타입과 DB schema에는 confidence 없음

필수 정리:

- FACT lifecycle 문서를 persisted fact attribute가 아닌 `extraction-time candidate confidence`로 수정
- persisted confidence를 새로 도입하려면 장기 truth confidence로 오인될 위험과 사용처를 별도 승인

감사 권고는 schema 확장보다 문서 정정이다.

### C. `parseConversationFile()` project identity

보고된 원인:

```ts
const project = cwd ? path.basename(cwd) : 'unknown';
```

주 ingestion은 canonical absolute cwd를 받지만 public wrapper만 basename을 사용한다. 같은 basename의 서로 다른 프로젝트가 충돌한다.

필수 정리:

- canonical absolute `session_meta.cwd`를 project identity로 사용
- public convenience wrapper도 architecture invariant 준수

### D. `createRelation()` invariant 강화

보고된 원인:

- sync-import는 서로 다른 project↔project endpoint를 거부한다.
- low-level `createRelation()`은 endpoint scope validation 없이 unique triple만 검사한다.

필수 정리:

- 최종 relation write primitive 또는 DB trigger에서 cross-project edge 금지
- 현재 caller의 사전 filtering에만 의존하지 않음

### E. Sync/rebuild 문서·동작 정합성

보고된 충돌:

- sync exporter 주석은 SQLite DB를 archive + sync JSONL로 rebuild 가능하다고 표현
- SCHEMA는 `recall_events/provenance flags`가 rollout만으로 복원되지 않아 보존 필요하다고 설명
- archive가 최신이고 DB만 삭제된 경우 `sync`는 새로 복사된 파일만 `filesToIndex`에 넣어 단독 재색인이 되지 않음

필수 결정과 정리:

- “conversation index와 model-derived knowledge의 상당 부분은 재생성 가능하지만 일부 durable safety state는 DB 또는 별도 durable export 필요”로 정확한 범위 명시
- DB 삭제 + archive 유지 상태에서 `sync` 단독 복구, `index` 별도 실행, 전용 rebuild command 중 공식 정책 선택
- 문서, CLI help, 실제 recovery path 일치

### F. 소규모 drift cleanup

1. [x] SessionEnd 정상 경로의 `recordHookEvent('SessionEnd', ...)` 중복 호출 제거. event 정확히 1회 기록.
2. [x] 독립 Codex 저장소이므로 historical home migration autodetect와 legacy storage compatibility 경계를 제거. 현재 쓰기 대상과 기본 홈은 `MEMEX_HOME`/`~/.config/memex`로 고정.
3. [x] `event_msg.user_message`는 transport noise로 무시하고 canonical `response_item`만 user turn으로 처리하는 실제 parser dispatch에 설명과 회귀 테스트를 일치시킴.
4. [x] `recall_events.prepared`는 아직 방출 증거가 아니므로 exchange recall 판정에 포함하지 않음. `emitted` receipt만 `has_memex_recall=1`을 적용하며 prepared→emitted 전이를 DB insert와 sync import 양쪽에서 검증.
5. [x] archive 최신 + DB 삭제 상태에서 `sync`가 unchanged archive도 재색인하도록 Section E recovery 계약과 일치시킴.

## 7. 회귀 테스트 계약 — 총 17개

### 기존 감사가 제안한 12개

1. [x] `SESSION_ID`와 실제 indexed exchange가 있는 상태에서 `fact-extract-worker.js`를 직접 실행하고 canonical success line 확인.
2. [x] 같은 rollout을 `sync`, `index`, `indexSession`, `indexUnprocessed` 네 경로로 넣어 user exclusion 결과 동일성 확인.
3. [x] 이미 색인된 session에 `DO NOT INDEX`가 뒤늦게 추가됐을 때 승인된 정책대로 purge 또는 retain되는지 확인.
4. [x] shell `grep /outside`, `git -C /outside`, `npm --prefix /outside test`가 `learnable=false`인지 확인.
5. [x] EVOLUTION 뒤 fact text, stored embedding, `vec_facts`, ontology pending, relations가 한 semantic generation인지 확인.
6. [x] CONTRADICTION 뒤 현재 active fact에서 predecessor revision을 trace할 수 있는지 확인.
7. [x] embedding version 상승 뒤 `vec_categories`까지 reembed되는지 확인.
8. [x] current-version fact에서 `vec_facts` row만 삭제해도 maintenance가 복구하는지 확인.
9. [x] 수백 개의 가까운 project fact 사이에 global fact를 넣고 `search_facts(scope=global)`가 찾는지 확인.
10. [x] 다른 기기에서 과거 `created_at` fact를 import한 뒤 consolidation 대상이 되는지 확인.
11. [x] 같은 ID fact의 newer edit/deactivate가 sync를 통해 다른 DB에 반영되는지 확인.
12. [x] Web UI `/api/facts-mutate`에서 edit/deactivate/restore를 실제 vec0 DB로 E2E 실행.

### 후속 답변이 추가한 5개

13. [x] durable prepared receipt 저장 실패 시 실제 context가 미주입되고 dedup ledger도 오염되지 않는지 확인.
14. [x] `parseConversationFile()`로 basename이 같은 서로 다른 canonical cwd 두 개를 처리해 identity가 충돌하지 않는지 확인.
15. [x] low-level `createRelation()`에 서로 다른 project↔project edge를 직접 넣어도 거부되는지 확인.
16. [x] DB 삭제 + archive 유지 상태가 승인된 recovery 계약대로 복구되는지 확인.
17. [x] 정상 SessionEnd event가 정확히 1회 기록되는지 확인.

테스트 원칙:

- behavior change는 해당 regression을 재현하는 최소 실패 테스트를 먼저 관측
- source inspection만으로 PASS 금지
- async path는 fixed sleep 대신 정확한 event/state를 trigger 전에 subscribe하고 bounded timeout 사용
- multi-device sync는 두 개의 독립 DB fixture로 edit/deactivate/late import를 실제 재현
- vector tests는 text column만 비교하지 않고 stored embedding, virtual table row, version/generation까지 확인
- 필요한 E2E를 실행할 수 없으면 `NOT_PROVEN`과 missing proof 기록

## 8. 최종 full consistency audit 기준

### Conversation

```text
source → archive → exchange → FTS/vector
```

- 모든 ingestion entrypoint가 같은 eligibility/exclusion policy 사용
- project identity는 canonical absolute cwd
- user exclusion의 prospective/conversation-wide 의미와 cleanup 범위 일치
- compaction output을 human evidence로 재구성하지 않음

### Evidence

```text
human/repo/git/test → learnable
assistant/recall/external → non-learnable
```

- 파일 tool과 shell tool 모두 같은 cwd-locality proof 적용
- unknown/ambiguous target은 fail-closed
- 한 recall이 sibling tool evidence를 taint하지 않음

### Fact

```text
extraction → provenance → consolidation
           → semantic mutation
           → vector/ontology/graph generation
```

- 의미 변경은 single semantic mutation primitive 통과
- text, EN embedding, KR translation/vector, ontology category, relations, revision lineage가 같은 generation
- current truth에서 predecessor trace 가능
- precise source exchange provenance 유지

### Sync

```text
create/update/deactivate/revision
→ 다른 기기에서도 같은 current truth
```

- late import도 local processing queue 진입
- tombstone, revisions, durable safety state 보존 범위 명확
- conflict/reconciliation이 deterministic
- rebuild 가능 범위와 recovery command가 문서와 일치

### Injection

```text
retrieve → scope → dedup → durable receipt
         → emit → provenance
```

- durable prepared receipt 실패 시 emit/ledger 오염 없음
- `prepared`, `stdout`, `emitted` 상태와 exchange taint 정책 일치

### Lifecycle

```text
SessionStart / PromptSubmit / SessionEnd
→ 실패·재시도·resume에서도 동일 invariant
```

- SessionEnd extraction과 export 완료 증거 있음
- hook event 중복 없음
- pipeline 상태가 운영자가 오해하지 않는 의미를 가짐
- stale/missing vector self-heal이 모든 index generation에 적용

### Generation audit

같은 의미를 가진 상태가 여러 저장소에 있을 때 모두 같은 generation인지 검사한다.

```text
Fact semantic generation N
├─ fact text
├─ EN embedding / vec_facts
├─ KR translation / vector
├─ ontology category / vec_categories
├─ ontology relations
├─ revision lineage
└─ sync representation / tombstone
```

## 9. 저장소 required checks와 Manual QA

Runtime 변경의 기본 required checks:

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
node --test test/*slice.test.mjs
```

변경 표면별 추가 증거:

- hook/lifecycle: 실제 SessionStart, PromptSubmit, SessionEnd entrypoint 실행
- CLI: happy path, bad input, `--help`
- Web UI: loopback live process에서 실제 vec0 mutation 호출
- MCP: project/global/all scope별 real request
- sync: 두 독립 DB 간 create/update/deactivate/revision/late import round-trip
- migration/rebuild: 격리된 temporary home에서 source 보존, DB integrity, row-count/parity 확인
- plugin/manifest/hook 변경: nearest isolated E2E와 temporary registration/process/database/socket/cache cleanup

## 10. 완료 체크리스트

### Phase 1

- [x] 1. SessionEnd worker 회귀 수정
- [x] 2. conversation exclusion policy SSOT
- [x] 3. semantic fact mutation service
- [x] 4. shell evidence locality proof
- [x] 5. revision/tombstone-aware sync
- [x] 6. ingestion/dirty consolidation queue
- [x] 7. 모든 vector generation/version
- [x] 8. scope-aware search SSOT
- [x] 9. current fact lineage
- [x] 10. shared initialized Web UI DB factory
- [x] 11. missing primary fact vector self-heal
- [x] 12. precise source exchange attribution
- [x] 13. pipeline counter semantics

### Phase 2

- [x] A. Injection write ordering
- [x] B. Fact confidence 문서 정정
- [x] C. `parseConversationFile()` canonical identity
- [x] D. `createRelation()` final invariant
- [x] E. Sync/rebuild 계약 정합성
- [x] F. 소규모 drift 5건

### Phase 3

- [x] 회귀 시나리오 1~17 전부 관측
- [x] required checks 통과
- [x] 변경 표면별 Manual QA 완료
- [x] temporary state 완전 cleanup

### Phase 4

- [x] full consistency audit 완료
- [x] 새 P0/P1 없음
- [x] 문서↔코드↔테스트 invariant 일치
- [x] 남은 `NOT_PROVEN`과 residual risk 명시

### Phase 4 감사 결과 (2026-08-29)

방법: Section 8의 7개 영역(Conversation/Evidence/Fact/Sync/Injection/Lifecycle/Generation)을
독립 감사로 문서↔코드↔테스트 3계층 대조하고, 실제 저장 상태는 live DB 복사본에 프로덕션
마이그레이션을 적용한 뒤 generation 불변식을 측정했다.

수정된 감사 finding (회귀 테스트 동반):

- P1 — evidence layer의 model workdir denied root가 실제 mkdtemp shape
  (`<tmpdir>/memex-llm-XXXXXX`)을 놓쳐 fail-closed demotion이 그 shape에서 성립하지 않았다.
  denied predicate를 basename family로 확장하고 shell/파일 tool 회귀 테스트를 추가했다.
- P2 — `fact-db.updateFact()`의 dormant text 분기 제거(fail-loud 가드), consolidator
  DUPLICATE 경로를 단일 transaction으로 통합(`deactivateFactTransactional`).
- P2 — `indexUnprocessed`가 archive 사본 재검증 없이 source 판정만 하던 방어선 비대칭 제거,
  exclusion purge의 `source_conversation_excluded` tombstone을 문서(SCHEMA/CONVERSATION-LIFECYCLE)와
  회귀 테스트로 관측, assistant 출력 속 marker 미제외 leg 테스트 추가.
- P2 — GUIDE의 존재하지 않는 `memex.db`/`archives/` 경로명과 저장소 트리
  (`lifecycle-registration.json` 위치, `logs/`·`sync/` 누락) 정정, RETRIEVAL의 inject log
  status 목록에 `no-session-provenance` 추가.
- P2 — `memex status` pending에 워커가 영원히 집지 않는 SEED/PERMANENT 세션이 포함되던
  계약 위반 제거(`deferred` 카운터 분리), seed 마커 watermark를 세션 MAX(rowid)로
  고정해 FACT-LIFECYCLE 문서와 일치, sync exact-time tie-break 4건 회귀 테스트 추가.

저장 상태 측정: orphan/stale/누락 벡터 0, 교차 프로젝트 관계 0, dangling 엔드포인트 0,
settled watermark 전부 현재, recall 전이 준수(5/5 emitted, taint 0). 마이그레이션은
row 손실 없이 additive로 적용됨. 설계된 마이그레이션 후속: legacy fact가 dirty queue에
재진입하고(48건) legacy category가 재임베드 대상이 된다(12건) — 자가 치유 대상.

남은 residual risk와 `NOT_PROVEN`:

- 실제 배포 환경에서 SessionEnd 훅이 발화하는 것은 저장 로그만으로 `NOT_PROVEN` —
  현재 진행 중인 세션은 아직 종료되지 않았고 로그의 SessionEnd 항목은 과거 테스트
  잔여물(s1~s4)뿐이다. 훅 경로 자체는 codex-slice/session-end-worker-p0 테스트로 관측됨.
- 과거 테스트 실행이 사용자 hook-events.jsonl에 fixture 이벤트(s1~s4, 2026-08-28)를
  남겼다. 현재 테스트는 격리된 MEMEX_HOME을 사용하며 Phase 3 이후 재오염 없음을 확인.
- `markRecallEventEmitted` 실패 시 receipt가 `prepared`로 남아 해당 exchange의 taint
  flag가 생기지 않는 경로는 설계된 fail-safe다(의도적으로 수정하지 않음).
- `fact-consolidate-cursor.txt`는 어떤 코드도 참조하지 않는 죽은 잔여 파일이다(파생 데이터,
  무해).

## 재감사 remediation (2026-08-29, `AUDIT_REMEDIATION_REAUDIT_REPORT.md`)

재감사 보고서의 remediation 순서(Section 8)를 따른다. 각 Phase 완료 시 이 절에 기록한다.

### Phase 1 — Privacy & correctness gate (완료)

리포트 P1-1·P1-7·P1-8을 현재 checkout에서 코드로 재검증한 뒤 수정했다. 리포트의
사실 관계 세 건 모두 코드 추적으로 확인됐고, 방향 충돌은 없었다.

**P1-1 SessionEnd 추출이 DO NOT INDEX를 우회** — `scripts/session-end-hook.js`는
`getConversationEligibility()`를 호출하지 않고 곧바로 worker를 spawn 했고,
`scripts/fact-extract-worker.js`도 user-level exclusion을 확인하지 않았다.
수정: worker의 extraction gate에 `getConversationEligibility()`를 적용하고
`user_excluded` 판정 시 **purge 먼저 → 추출 금지**로 순서를 고정했다. worker는
canonical success line(`extracted=0 saved=0`)을 유지해 훅의 sync-export가 계속
실행되고, 내보내는 payload는 privacy tombstone만 남는다. subagent는 훅 parse 가드가,
excluded project는 `runFactExtraction`의 제외 마커 경로가 각자 소유한다.
T01 회귀 테스트가 실제 worker+SessionEnd 훅 프로세스를 실행해 관측한다.

**P1-7 privacy tombstone 부활** — `sync-import.ts`의 `importFacts`는 tombstone 사유를
구분하지 않아 strictly newer fact가 `source_conversation_excluded` tombstone 위에서
부활하고 tombstone을 지웠다. 수정: 해당 사유를 terminal privacy state로 구분한다.
import는 이 tombstone으로 fact를 복원하지 않고(무시간), 더 새로운 peer edit을 지우며
삭제를 대화 전반으로 전파하고(terminal propagation), 더 새로운 non-privacy tombstone으로
사유가 강등되지 않으며(사유는 payload fold에서도 dominant), `deleted_at`은 monotone
max로 기록된다. 상수 `PRIVACY_TOMBSTONE_REASON`을 `conversation-policy.ts`가 소유한다.

**P1-8 backfill claimVariant 5번째 인자 손실** — `runFactExtraction`의 options는
4번째 인자인데 `backfill-extract-worker.js`가 `{claimVariant:"worker"}`를 5번째로
넘겨 JS가 무시했고, 런타임은 훅 변형으로 선점했다. `extraction-claim-e2e.test.ts`의
동시성 테스트도 동일한 5-인자 형태라 결함을 검출하지 못했다. 수정: 4번째 options
인자로 전달하고, 인자 위치를 캡처하는 실행 테스트와 worker 변형 선점 의미론(T11)을
테스트로 고정했다.

검증 시 확인한 근거 보충: 현재 `runFactExtraction`의 no-op 게이트(settled 마커 + 현재
워터마크)와 pending 선정 조건이 대부분의 실무 노출을 흡수하므로, P1-8의 관측 가능한
차이는 좁다(중복 fact가 아니라 계약 위반 수준). 리포트의 사실 관계와 수정 권고는
그대로 유효하며, 이 기록은 영향 범위를 정직하게 좁혀 둔다.

추가 회귀 테스트: `test/session-end-exclusion-gate.test.ts`(T01, 실제 프로세스 E2E),
`test/sync-export-import.test.ts` terminal privacy tombstone 6건(T02),
`test/extraction-claim-e2e.test.ts` T11 + 5-인자 계약 수정,
`test/backfill-worker-execution.test.ts` 인자 위치 계약,
`test/worker-dist-contract.test.ts` gate 심볼 계약. 세 결함 모두 결함 재주입 시
해당 테스트가 실패하는 것을 관측했다.

필수 체크: `npm run typecheck`, `npm run build`, `npm test`(53 files / 496 tests),
`node --test test/codex-slice.test.mjs`(23), `node --test test/*slice.test.mjs`(91) 통과.
Manual QA: T01 테스트가 실제 `scripts/fact-extract-worker.js`와
`scripts/session-end-hook.js`를 자식 프로세스로 실행해 purge/추출 금지/export를 관측했다.

### Phase 2 — Semantic generation (완료)

리포트 P1-2를 코드로 재검증한 결과, ontology 분류(`applyClassification`/`classifyFact`),
relation 생성(`detectRelations`→`createRelation`), fact/KR 재임베딩
(`scripts/reembed-worker.js`), sync fact import(`importFacts`의 embedding await 후
무재검증 commit) 모두 세대 확인 없이 최종 쓰기를 했다. consolidation만
`expectedPreviousFact`(text-identity CAS)과 dirty 큐의 세대 확인을 부분적으로 갖고
있었다. 리포트의 사실 관계는 유효했고 방향 충돌은 없었다.

수정(리포트 Section 7 아키텍처의 핵심 규칙 구현):

- 스키마: `facts.semantic_generation INTEGER NOT NULL DEFAULT 1`과
  `facts.semantic_updated_at TEXT NOT NULL DEFAULT ''` 추가(additive migration,
  legacy 행은 세대 1 / `semantic_updated_at = updated_at` 백필).
- 의미 변경 경로만 세대를 올린다: `mutateFactMeaning`(manual edit, consolidation
  EVOLUTION/CONTRADICTION)과 sync fact import. activate/deactivate/restore, 분류,
  DUPLICATE 확인 같은 비의미 쓰기는 세대를 올리지 않는다.
- CAS 전환: `classifyFact`와 `createRelation`(양 endpoint 세대, 원자적 검증+삽입),
  reembed worker의 EN/KR 경로(UPDATE-first CAS → 0행이면 vec 스왑 전체 폐기),
  consolidation dirty 큐 확인/clear/attempts ledger를 `updated_at`에서
  `semantic_generation`으로 전환, DUPLICATE 양 endpoint commit 시점 재검증,
  sync import는 embedding await 후 commit 직전에 로컬 세대+tombstone을 재검증해
  동시 편집 덮어쓰기를 막는다(T06의 CAS 절반 — 충돌 시계 교체는 Phase 3).
- stale 결과 폐기는 실패가 아니다: `StaleFactMutationError` 타입 도입, 분류 batch에
  `stale` 버킷 추가 — stale은 시도 ledger를 태우지 않고 폴백 parking도 하지 않는다.

추가 회귀 테스트: `test/semantic-generation.test.ts`(세대 lifecycle, legacy migration,
T03 분류 race, relation race 양 방향, sync import commit 직전 재검증 2건),
`test/reembed-generation-cas.test.ts`(T04/T05 — worker를 자식 프로세스로 실행하고
임베딩 게이트 스텁으로 대기 중 변이 재현). T03/T04는 CAS 제거 재주입 시 실패를
관측했다. 테스트용 수동 스키마(`ontology-classifier.test.ts`)에도 새 컬럼을 반영했다.

필수 체크: 이 문서 하단의 실행 기록 참조. 범위 결정: relation 행에 endpoint 세대를
저장하는 확장은 이번 Phase에서 하지 않았다(리포트 merge gate는 CAS를 요구하고
쓰기 시 원자적 재검증이 이를 충족한다) — relation 대상 세대 저장은 필요 시 별도
스키마 확장으로 다룬다.

### Phase 3 — Sync semantics (완료)

리포트 P1-3·P1-4를 재검증했다. P1-3: `remoteFactWins`가 `updated_at`을 충돌 시계로
쓰는데 분류(`classifyFact`), confirmation/provenance merge(`updateFact`),
deactivate/restore 같은 비의미 쓰기도 `updated_at`을 갱신하므로, metadata refresh가
실제 semantic edit를 이길 수 있었다. P1-4의 CAS 절반(commit 직전 로컬 세대 재검증)은
Phase 2에서 이미 닫혔다. 리포트의 사실 관계는 유효했고 방향 충돌은 없었다.

수정(충돌 판정의 기준 시계를 `semantic_updated_at`으로 교체):

- export: `facts.jsonl`에 `semantic_updated_at`을, `ontology-relations.jsonl`에 양
  endpoint의 `source/target_fact_semantic_updated_at`을 추가한다(구버전 reader를 위한
  기존 `updated_at` stamp 유지 — additive, protocol version 유지).
- `remoteFactWins`: `updated_at` → semantic clock 비교. 동일 시각은 기존 canonical
  fact key로 결정한다. `semantic_updated_at`이 없는 구버전 payload는 `updated_at`
  폴백(구버전 peer와의 transition 동작 유지).
- import: 가져온 fact는 원격의 semantic clock을 채택하고 로컬 세대를 올린다.
  tombstone-vs-fact 판정(importTombstones의 restore 가드, importFacts의 복원 가드와
  commit 직전 재검증)도 semantic clock으로 판정한다 — 삭제 이후의 metadata touch는
  삭제를 되돌리지 못한다.
- relation import: endpoint version 검증을 semantic stamp(있으면 semantic clock과
  비교) → legacy updated_at stamp(없으면 기존 동작) → created_at 폴백 순으로 전환.
- `getTopFacts` recency 점수를 semantic clock으로 전환 — 분류 같은 비의미 쓰기가
  오래된 fact를 최근 사실처럼 보이지 않게 한다(P1-3 영향 항목).

추가 회귀 테스트(`test/sync-export-import.test.ts` semantic conflict clock describe +
`test/semantic-generation.test.ts` recency): T07 양방향(로컬 의미 편집 vs 새로운 원격
metadata touch, 원격 의미 편집 vs 새로운 로컬 metadata touch), 원격 semantic clock 채택,
구버전 payload 폴백, relation endpoint semantic 검증 거부/승인, 구버전 relation 폴백,
getTopFacts semantic recency. `remoteFactWins`를 `updated_at` 시계로 되돌린 재주입에서
T07 양방향 테스트가 실패하는 것을 관측했다.

`NOT_PROVEN` 잔여: semantic stamp가 없는 아주 오래된 peer의 `updated_at`은 여전히
오염된 시계다(폴백이 구버전 동작을 유지하는 한 해소되지 않음) — protocol 전환 완료
후 폴백 제거는 별도 결정 사항으로 남긴다.


## 11. 최종 목표

이번 작업은 개별 patch 모음이 아니라 다음 SSOT를 세우는 작업이다.

> **Semantic mutation은 모든 derived state의 generation transition이다.**

안정된 기준선으로 인정할 시점:

```text
우선순위 1~13 수정
→ 잔여 정합성 6묶음 수정
→ 회귀 테스트 17개 추가·통과
→ full consistency audit
→ 새 P0/P1 없음
→ 문서↔코드↔테스트가 같은 invariant를 설명
```
