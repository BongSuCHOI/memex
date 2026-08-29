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

### Phase 4 — Exchange identity (완료)

리포트 P1-5·P1-6을 재검증했다. P1-5: `parseRolloutStream`의 교환 id가
`md5(archivePath:userLine-assistantLine)`로 만들어졌다 — archivePath는 기기별
local 경로라 같은 rollout을 다른 기기에서 재색인하면 다른 id가 생기고, tool
output이 붙을 때마다 `assistantLine`이 갱신되어 자라는 turn의 id가 바뀌었다.
P1-6: 재색인이 desired set 대조 없이 upsert만 해서 구 scheme의 growing-turn
중복 행과 parse 사이에 사라진 tool_call이 잔존했고, `deleteExchange`는 tool_calls를
지우지 않아 FK가 켜진 연결에서 constraint error(또는 고아)가 예고돼 있었다.
리포트의 사실 관계는 유효했고 방향 충돌은 없었다.

수정(리포트 권장 "stable(session_id + user_turn_key) + content generation 별도" 채택):

- 교환 신원: `md5(session_id:user_line)` — 기기별 archive 경로와 assistant/tool 행
  위치를 신원 재료에서 제거한다. user 행은 append-only rollout에서 불변이므로 turn이
  자라도 같은 교환으로 upsert되고(content generation은 `line_end`/본문/벡터 갱신),
  서로 다른 기기가 같은 rollout을 재색인하면 같은 id가 나온다. session_meta 없는
  파일은 경로 독립 content 폴백 키를 쓴다. `mx` 접두사로 구 scheme과 네임스페이스
  분리. archive 경로는 `archive_path` location metadata로만 남는다.
- 재색인 desired-set reconciliation(`reconcileArchiveExchanges`, sync/index 3경로 +
  verify repair에 연결): 같은 archive의 DB 행 집합과 새 파싱을 한 transaction으로
  대조한다. line이 desired에 없으면 통합 삭제 primitive로 제거, line이 일치하는
  legacy id 행은 canonical id로 rename하고 참조 전부(`tool_calls.exchange_id`,
  `vec_exchanges.id`, `facts.source_exchange_ids`,
  `fact_revisions.source_exchange_id`)를 재작성, 삭제된 교환을 참조하던 provenance
  항목도 정리한다. rename은 `defer_foreign_keys`로 parent/children을 한 트랜잭션에서
  옮긴다. legacy 마이그레이션은 재색인 시점에 lazy로 일어난다(전면 재작성 없이도
  provenance가 끊기지 않는다).
- `deleteExchange`를 통합 primitive로 완성(tool_calls + vec + exchange — FTS는
  trigger). 기존 verify의 orphan 삭제 경로가 FK 켜진 연결에서 깨지던 잠재 결함도
  함께 닫힌다(P2-1 예고분).
- `insertExchange`의 tool_calls를 교환별 desired set으로 대체(delete 후 insert —
  `INSERT OR REPLACE`만으로는 parse 사이에 사라진 call이 남았다).

추가 회귀 테스트(`test/exchange-identity.test.ts` 7건): T08 경로 독립/성장 안정/
session_meta 없는 파일 폴백, T09 legacy rename + 참조 재작성 + 중복 정리, desired 밖
행 삭제, 실제 sync 재색인에서 논리 교환 1개 유지 + provenance 생존 + FTS/vector
집합 동일성, T10 tool_calls 교환별 대체. 구 scheme으로 되돌린 재주입에서 T08 3건이
실패하는 것을 관측했고, vec 재삽입 dtype 버그(int8 재인코딩 누락)는 테스트가 실측으로
잡아 수정했다.

### Phase 5 — Retrieval & DB hardening (완료)

리포트 P1-9·P2-1·P2-2·P2-3을 재검증했다. P1-9는 유효했다: conversation vector 검색은
sqlite-vec `k = caller limit`을 먼저 적용하고 project/date/embedding_version filter를
나중에 적용해(FTS 텍스트 경로는 이미 filter-then-limit) 다른 프로젝트의 가까운 행이
창을 채우면 유효한 대상이 rank limit+1에서 사라졌다. P2-2도 유효했다: `src/index.ts`
barrel의 `export * from './fact-db.js'`가 `insertFact/updateFact/deactivateFact/
deleteFact/insertRevision`을 패키지 public surface로 노출했고, legacy `deleteFact`는
relation 정리가 없었다. P2-3도 유효했다: `restoreFact`는 버전 검사 없이 저장 embedding을
재삽입하고 `embedding_version`을 건드리지 않아, inactive 동안 model upgrade를 겪은 fact는
restore 직후 검색에서 보이지 않았다(단, 현재 restoreFact의 프로덕션 호출 지점은 0개 —
public API/미래 와이어링 관점의 결함).

**P2-1 판정 불성립(사용자 승인 조정 방향)**: 리포트는 "FK enforcement가 실제로 꺼져
있다"고 했지만 실측으로 반증됐다 — better-sqlite3 12.11.1은 모든 연결에서 FK를 기본 ON으로
연다(bare connection과 `initDatabase()` 모두 `PRAGMA foreign_keys = 1`; 존재하지 않는
endpoint로 relation 생성 → `FOREIGN KEY constraint failed`, 관계 있는 fact에 legacy
deleteFact → 동일 실패). Phase 2의 createRelation FK failure 실증과 일치한다. 리포트의
"orphan audit/cleanup → FK ON" 전제는 무의미하고 "FK를 갑자기 켜면 constraint error"
시나리오도 성립하지 않는다(모든 삭제 경로가 이미 FK ON에서 검증됨). 사용자 결정에 따라
리포트가 의도한 경화 가치만 채택했다.

구현:

- P1-9: conversation vector 검색에 fact 검색(`searchFactsByScope`)과 같은 expanding
  KNN window — `max(limit*4, 50)`에서 시작, filter 통과 행이 limit을 채우거나 vec
  index를 모두 고려할 때까지 ×4 확장(cap = vec 행 수 + 1), int8 dtype race 재시도 유지,
  결과를 거리순 caller limit으로 절단(확장 창에서는 k가 출력 상한이 아니므로 명시 절단
  필요 — 테스트가 실측으로 잡았다).
- P2-2: barrel에서 fact-db raw writers 5개를 제외하고 read/search primitive + type만
  explicit re-export. 내부 barrel 소비자는 0개, CLI/MCP는 raw mutation을 쓰지 않아 파급
  없음. legacy `deleteFact`의 relation 정리는 추가하지 않음 — 호출자 0개, hard delete는
  fact-management의 영향 보고 경로가 이미 담당.
- P2-3: `restoreFact`를 async semantic operation으로 전환 — 저장 `embedding_version`이
  현재와 같으면 저장 bytes 재사용(모델 호출 0), stale이면 현재 모델로 재임베딩 후
  vector+stamp를 같은 commit에 복원. 결과에 `reembedded` 플래그 추가. vec_facts 부재
  방어 가드는 유지.
- P2-1(조정): `initializeConnection`에 `PRAGMA foreign_keys = ON` 명시 선언(런타임
  delta 0, 드라이버 기본값 변경 방어), `verifyIndex`가 `PRAGMA foreign_key_check` 위반을
  검출하는 `fkViolations` 필드 추가, `repairForeignKeyViolations`는 parent가 없는 파생
  child 행(tool_calls/fact_revisions/ontology_relations)만 제거하고 그 외 테이블은 수동
  검토 보고, verify/repair CLI 출력과 수리 트리거에 반영.

추가 회귀 테스트 4종 12건: `test/conversation-search-window.test.ts`(target이 global
rank limit+1인 project 검색, date 밖 후보가 top-k를 채우는 date 검색, 초기 창(50)보다
많은 decoy로 확장 루프 자체 관측 — 결정론적 angle-vector embedding mock),
`test/restore-embedding-version.test.ts`(stale restore 직후 검색 가능 + 재임베딩 1회,
버전 일치 시 재사용 + 모델 호출 0, embedding 없는 fact 활성화),
`test/public-api-surface.test.ts`(raw writers 부재 + read primitive 유지),
`test/fk-enforcement.test.ts`(모든 연결 명시 pragma, exchange 삭제/purge 경로 후
foreign_key_check 0행, FK OFF로 조성한 legacy orphan fixture 검출 + 수리). 재주입
관측: k=limit 고정 → window 3건 전부 실패, 버전 검사 제거 → stale 케이스만 실패, `export *`
복원 → raw-writer 노출 실패, repair no-op → legacy fixture 실패.

`NOT_PROVEN` 잔여: (1) 명시 pragma 제거 재주입은 현재 런타임에서 관측 불가 — 드라이버
기본값이 ON이라 동작이 동일하며, 해당 테스트는 미래 드라이버 기본값 변경을 방어하는
계약 핀일 뿐 오늘의 회귀 신호가 아니다. (2) lazy exchange id 마이그레이션(Phase 4)과
마찬가지로, foreign tooling이 만든 orphan은 verify 실행 전까지 검출되지 않는다.

### Phase 6 — Sync durability & observability (완료)

리포트 P2-4·P2-5·P2-6·P2-7과 §6 freshness를 재검증했다. 네 항목 모두 사실 관계가
유효했고 방향 충돌은 없었다.

- P2-5: `exportForSync`가 facts→revisions→tombstones→recall→ontology→meta를
  `fs.writeFileSync`로 순차 직접 덮어썼다 — read transaction도, 파일 집합 원자성도
  없어 crash/동시 export/cloud-sync 관측이 혼합 snapshot(facts=N+1, revisions=N)을
  만들 수 있었다.
- P2-6: `sync-export-hook.js`는 오류를 stderr에 쓰고 exit 0으로 끝냈고, parent
  `session-end-hook.js`는 child 반환값을 전혀 검사하지 않았다 — export 실패는
  관측 불가능했다.
- P2-7: `readJsonLines`의 JSON.parse catch가 malformed 행을 조용히 skip했고, 문서
  (CONVERSATION-LIFECYCLE §6 sequence diagram)의 "uncommitted/reported" 주장과
  런타임이 어긋났다.
- P2-4: 문서가 drift→sync→sync-import→maintenance 순서를 ordered pipeline으로
  기술했지만 hooks.json의 네 SessionStart 명령은 독립 async다.
- freshness: 요약 생성이 존재 여부만 검사해서 resume으로 길어진 rollout의 잘린
  요약이 영원히 재사용됐다(indexer 3곳).

구현(리포트 권장 채택):

- P2-5: 한 export = 한 generation. 단일 read transaction으로 모든 행을 모으고,
  `sync/devices/<id>/generations/<uuid>.tmp`에 파일 집합 전부를 쓴 뒤 원자적
  directory rename으로 commit하고, 마지막에 `CURRENT` manifest를 tmp+rename으로 원자
  교체한다. importer는 device당 CURRENT가 가리키는 committed generation 하나만
  읽는다(legacy v2 device root는 CURRENT 부재 시 폴백, 깨진 CURRENT는 device
  skip + malformedRows 보고). root JSONL mirror는 v1 호환 surface로서 generation
  commit 후 파일 단위 원자 쓰기로 갱신된다 — 전환 정책을 문서에 명시했다(mirror는
  set-atomic이 아님). generation은 최신 2개만 유지하고 1시간 넘은 `.tmp`를 정리한다.
  per-process tmp 이름으로 동시 export 간 rename 경합도 제거했다.
- P2-6: `sync/export-status.json` durable status — sync-export-hook은 성공/실패
  모두 기록(ok, at, error, counts)하고 exit 0을 유지한다. parent session-end-hook은
  child code와 status를 검사해 `EXPORT_FAILED`를 stderr에 남기고(비정상 종료 시
  parent가 status를 대신 기록), `memex doctor`에 `sync-export` 체크가 추가됐다.
  다음 SessionEnd export가 자연히 재시도하고 status를 덮어쓴다.
- P2-7: `readJsonLines`가 parse 실패 행을 file/line/error와 함께
  `SyncImportResult.malformedRows`로 누적하고, sync-import-hook이 stderr에 행별로
  보고한다. 유효 행은 계속 import된다.
- P2-4: 리포트가 제시한 두 대안 중 "문서와 status semantics를 eventual-consistency로
  수정"을 채택했다. 근거: `memex sync`는 export를 수행하지 않고(sync-cli는
  syncConversations만 호출), import는 peer snapshot을 읽으며, maintenance는 로컬
  상태만 본다 — 실제 순서 의존이 없어 coordinator는 직렬화 비용만 추가한다.
  문서의 SessionStart 섹션을 독립 async 4단계 + eventual recovery 계약으로
  재작성하고, hooks.json 표면(4개 독립 async / SessionEnd 단일 동기 체인)을 계약
  테스트로 고정했다. "import가 이전 snapshot만 읽는" 비결정성의 날카로운 모서리는
  P2-5 generation 원자성이 제거한다(항상 온전한 generation 중 하나를 읽음).
- freshness: `summaryNeedsRefresh(archive, summary)` — 요약 부재 또는 아카이브
  mtime > 요약 mtime이면 재생성. 아카이브는 Memex 소유 append-only 사본이므로 별도
  fingerprint 상태 없이 mtime이 신뢰 가능한 변경 신호다. indexer의 요약 결정 3곳에
  적용했다.

추가 회귀 테스트 4종 15건: `test/sync-generation.test.ts`(generation layout/CURRENT
명명, crash `.tmp`+미지정 generation 무시, CURRENT flip이 commit point임을 관측 —
flip 전에는 완전히 쓰인 gen-2도 보이지 않음, malformed 행 file/line 보고, 깨진
CURRENT 보고), `test/export-status.test.ts`(실제 자식 프로세스: 성공/실패 status
기록, 실패 후 exit 0, 다음 lifecycle retry가 status를 덮어씀, parent 체인의
EXPORT_FAILED stderr + 정상 종료 — sandbox에서 stub worker/파서/실패 export로 전체
SessionEnd 체인을 구동), `test/summary-freshness.test.ts`(helper 3 케이스 +
indexSession resume 재생성/무변경 미재생성 통합), `test/lifecycle-contract.test.ts`
(hooks.json 독립 async 표면 고정). 재주입 관측: import가 CURRENT를 무시 → 3건 실패,
malformed 무시 복원 → 보고 테스트 실패, 훅 status 기록 제거 → 2건 실패, exists-only
요약 검사 복원 → 2건 실패, hooks.json async 제거 → 계약 테스트 실패. 테스트가 잡은
구현 버그는 없었으나 테스트 자체의 async/await 누락과 snapshot no-op(자기 export
재import는 reconcile에서 no-op)을 수정하며 배웠다.

`NOT_PROVEN` 잔여: (1) root mirror는 v1 호환 surface로 파일 단위 원자성만 제공한다 —
v1 reader의 파일 집합 동시성은 계약 밖이다(문서 명시). (2) generation prune(최신 2개
유지) 동안 CURRENT를 읽고 느리게 읽는 importer가 2세대 이전을 참조하면 ENOENT가
가능하다 — import는 CURRENT를 먼저 해석해 위험을 최소화하지만, 매우 긴 import 도중의
동시 export 2회 경합은 관측하지 않았다. (3) `memex doctor`의 sync-export 체크는
상태 파일만 읽는 단순 노출이며, CLI 전체 실행은 수동 QA로 관측했다.

### 필수 회귀 테스트 매트릭스 T01–T18 (검증 완료)

리포트 §9 매트릭스를 항목별로 Phase 1–6에서 만든 테스트와 대조했다. **18개 전 항목이
이미 커버되며 커버리지 gap은 없었다** — 신규 테스트 없이 매핑 감사와 증거 실행으로
완료된다. 매트릭스 시나리오 ↔ 테스트 매핑:

| 항목 | 시나리오 → 검증 테스트 |
| --- | --- |
| T01 | 부분 인덱싱 세션 + 마지막 DO NOT INDEX → `session-end-exclusion-gate.test.ts` "purges before extraction, saves no fact, and exports only the privacy tombstone" — 추출 0(LLM canary 포함), exchanges/vec/FTS/facts/vec_facts 0, extraction_log 0, privacy tombstone 유지, export payload tombstone-only |
| T02 | A exclude + B offline newer edit + A import → `sync-export-import.test.ts` "strictly newer offline peer edit은 privacy tombstone을 부활시키지 않는다 (T02)" (+ 강등 금지/전파/hard-delete 경계 6건) |
| T03 | 분류 대기 중 semantic edit → `semantic-generation.test.ts` T03 "discards the classification when the meaning changes during the LLM call" — stale category write 0 |
| T04 | embed(A) 중 A→B mutation → `reembed-generation-cas.test.ts` T04 — A의 stale EN vector가 B에 기록되지 않음(전체 vec swap 폐기) |
| T05 | KR embed 대기 중 semantic edit + translation invalidation(fact_kr NULL화) → `reembed-generation-cas.test.ts` T05 — stale KR vector 기록 금지 |
| T06 | remote embed 대기 중 local edit/tombstone → `semantic-generation.test.ts` T06 describe 2건 — remote stale update가 local edit을 덮지 않음 |
| T07 | semantic clock vs metadata touch 양방향 → `sync-export-import.test.ts` T07 describe — semantic edit가 winner, clock 채택, 구버전 폴백, relation 검증 |
| T08 | 같은 rollout, 다른 archive root → `exchange-identity.test.ts` T08 describe 3건 — 동일 logical exchange id |
| T09 | assistant/tool 추가 후 reindex → `exchange-identity.test.ts` T09 describe 3건 — 최신 logical exchange만 존재 |
| T10 | reindex 시 tool call 감소 → `exchange-identity.test.ts` T10 — 삭제된 tool call 잔존 0 |
| T11 | select 후 SessionEnd settle → `extraction-claim-e2e.test.ts` "재감사 P1-8/T11" — claim_not_acquired, LLM 0, fact 0 (+ `backfill-worker-execution.test.ts` claimVariant 인자 계약/R18) |
| T12 | target project hit at global rank limit+1 → `conversation-search-window.test.ts` "project-scoped search rescues..." |
| T13 | 범위 밖 hits가 top-k 점유 → `conversation-search-window.test.ts` "date-filtered search rescues..." |
| T14 | inactive stale version restore → `restore-embedding-version.test.ts` — 즉시 current vector/version으로 검색 가능 |
| T15 | exchange/fact delete → `fk-enforcement.test.ts` — foreign_key_check 0 rows + legacy orphan 검출/수리 |
| T16 | export 중간 crash → `sync-generation.test.ts` — incomplete/un-named generation import 금지, CURRENT flip이 commit point |
| T17 | async lifecycle invocation → `lifecycle-contract.test.ts` — eventual-consistency 계약과 hooks.json 표면 일치(매트릭스가 허용한 문서 일치 트랙) |
| T18 | resume 후 source 변경 → `summary-freshness.test.ts` — stale 판정 + 재생성 + 무변경 미재생성 |

증거 실행(HEAD `9e27593b9c116fb3aa335fa230b8229427e01c5b`, 2026-08-30): 매핑 대상 13개
테스트 파일 전수 실행 — 13 files / 94 tests 전부 통과. 동일 트리에서 필수 게이트도
모두 green: `npm run typecheck`, `npm run build`, `npm test`(64 files / 547 tests),
`node --test test/codex-slice.test.mjs`(23), `node --test test/*slice.test.mjs`(91).
리포트 §8 순서의 남은 단계는 merge gate 체크리스트의 최종 항목(package/runtime E2E
증거 보존 + 최종 재감사 → main merge)뿐이다.

### Merge Gate 체크리스트 (§10, 완료)

리포트 §10의 15개 항목을 merge 후보 코드 트리(SHA
`6a0f324184ec636f5411f63d61acfe650f3290b1`, 이후 커밋은 문서/수신뿐)에서
항목별로 재검증했다. 충돌·실패 없이 **15/15 체크 표시**.

- 항목 1–14는 각 remediation phase의 구현 + 회귀 테스트로 증명된다(T01–T18 매핑
  테이블 참조): exclusion gate 순서(T01), terminal tombstone(T02),
  schema/migration(db.ts:425-426, 454+), generation CAS 6곳(reembed worker,
  ontology classify/relation, consolidator, sync import commit-time
  sync-import.ts:584), semantic clock winner(remoteFactWins), exchange identity
  (codex-rollout.ts:230 `mx:`), desired-set reconcile(sync/indexer/verify 3경로),
  claimVariant 4번째 인자, expanding KNN window(search.ts:190-191), FK pragma +
  foreign_key_check(db.ts:124, verify.ts:52), public barrel 정화(index.ts),
  restore stamp 일치(fact-management.ts:321), generational
  snapshot(sync-export.ts CURRENT flip).
- 항목 15(merge 후보 SHA의 build/test/package/runtime E2E 증거 보존)는 이번에
  실행해 `docs/verification/merge-gate.json` 수신으로 보존했다: typecheck/build,
  vitest 64 files / 547 tests, codex-slice 23, slices 91, install-e2e PASS,
  marketplace-e2e PASS(cleanup PASS), package-runtime-e2e PASS(memex-0.1.0.tgz,
  9 MCP tools, onboarding 계약), lifecycle-e2e 9/9 + 7-surface cleanup 전부 true.
- 재감사 보고서 §10 체크박스 15개를 모두 `[x]`로 표시하고 이 수신을 커밋에 포함했다.
  리포트 §8의 마지막 단계인 "최종 재감사 → main merge"는 사람이 수행하는 리뷰/머지
  행위로, 본 자동화 범위 밖이다(NOT_PROVEN 아님 — 위임된 결정).


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
