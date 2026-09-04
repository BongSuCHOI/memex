# Memex Continuity Architecture v1 — Final Worker 실행 프롬프트 팩

> **기준 문서:** `Memex Continuity Architecture v1 — Final RFC`  
> **용도:** 현재 repository 감사부터 구현·독립 게이트·최종 릴리스 인수인계까지  
> **주의:** 이전 Architecture 초안과 이전 Worker 프롬프트 팩은 이 문서로 대체한다.

---

# 사용 순서

```text
Prompt 0
→ Prompt 1A → Prompt 1B
→ Prompt 2A → Prompt 2B
→ Prompt 3A → Prompt 3B
→ Prompt 4A → Prompt 4B
→ Prompt 5A → Prompt 5B
→ Prompt F1 → Prompt F2
```

- `A`는 해당 Phase 구현 프롬프트다.
- `B`는 실제 코드와 테스트를 독립적으로 다시 감사하고, 발견한 문제를 직접 수정한 뒤 Phase를 닫는 게이트다.
- 가능하면 `A`와 `B`를 다른 worker에게 맡긴다.
- 같은 worker를 사용해도 되지만 `B`에서는 자신의 이전 보고를 증거로 인정하지 않고 실제 code path와 재현 테스트로 다시 검증한다.
- 새 worker/chat마다 반드시 다음을 함께 제공한다.

```text
1. Memex Continuity Architecture v1 — Final RFC
2. 이번 단계의 Prompt
3. 가장 최근 PASS handoff
4. traceability matrix와 RFC deviation record
```

- 다음 Phase에는 직전 `B` 게이트가 `PASS`일 때만 진입한다.
- `CONDITIONAL` 또는 `BLOCKED`이면 다음 Phase로 넘어가지 않는다.
- Phase는 목표가 변하는 버전이 아니라 **하나의 고정된 최종 목표에 도달하는 의존 순서**다.

## 누적 산출물

기본 경로:

```text
docs/architecture/memex-continuity-v1.md

docs/verification/continuity-v1/
├── rfc-lock.json
├── rfc-deviations.md
├── phase-0-baseline.md
├── traceability-matrix.md
├── phase-1-handoff.md
├── phase-2-handoff.md
├── phase-3-handoff.md
├── phase-4-handoff.md
├── phase-5-handoff.md
├── final-integration-gate.md
└── final-handoff.md
```

Repository 문서 관례상 더 자연스러운 경로가 있으면 조정할 수 있다. 다만 각 문서의 역할과 지속성은 유지하고, 변경 경로를 handoff에 명시한다.

---

# Prompt 0 — 최종 RFC 고정 및 Repository/Runtime 베이스라인 감사

```text
현재 Memex repository를 대상으로 Phase 0 — Baseline & RFC Lock을 수행하라.

첨부된 “Memex Continuity Architecture v1 — Final RFC”를 이 작업의 최종 목표이자 규범 문서로 사용하라.
이 문서는 아이디어 모음이나 1차안이 아니다. 이후 모든 Phase가 도달해야 하는 고정된 목적지다.
이전 Architecture 초안이나 이전 prompt pack이 함께 보이더라도 Final RFC만 규범으로 사용하라.

규범 우선순위:

1. Final RFC의 MUST/invariant/안전 경계
2. 실제 설치된 Codex runtime에서 재현한 lifecycle contract
3. 현재 repository의 실제 구현과 migration 상태
4. Final RFC의 예시 파일명·테이블명·수치·내부 API

파일명, 함수명, 테이블명, threshold는 repository 구조에 맞게 조정할 수 있다.
그러나 invariant를 축소하거나 다른 architecture로 교체하지 말라.
조정은 반드시 RFC deviation record에 다음과 같이 남겨라.

- 관련 RFC section/invariant
- 실제 구현 선택
- 조정 이유
- 검토한 대안
- invariant가 유지되는 근거
- 이후 되돌릴 조건 또는 운영상 trade-off

중요한 작업 안전:

- 현재 branch, HEAD, working tree, untracked file을 먼저 기록한다.
- 사용자 또는 다른 작업자의 관련 없는 변경을 reset, checkout, clean, overwrite하지 않는다.
- push, tag, release, publish는 수행하지 않는다.
- 이번 Phase에서는 제품 기능을 구현하지 않는다.
- 테스트·감사 문서 생성을 위한 최소 변경만 허용한다.
- 현재 repository가 Final RFC의 참조 분석보다 진전돼 있으면 실제 상태를 기록하되, 완료 판정을 추측하지 않는다.

수행 작업:

1. Final RFC를 repository 내부의 지속 경로에 원문 그대로 복사한다.
   권장: `docs/architecture/memex-continuity-v1.md`

2. RFC lock을 만든다.
   권장: `docs/verification/continuity-v1/rfc-lock.json`
   최소 필드:
   - rfc_title
   - rfc_version
   - source_filename
   - repository_copy_path
   - sha256
   - locked_at
   - locked_by_phase
   - supersedes

3. 이후 단계가 Final RFC 원문을 조용히 수정하지 못하도록 한다.
   - 각 handoff에서 RFC SHA-256을 다시 확인하도록 문서화한다.
   - 실제 구현 문서는 별도로 작성한다.
   - RFC 자체 변경이 필요하면 사용자 승인과 명시적인 amendment가 없이는 수정하지 않는다.

4. 현재 repository와 runtime을 감사한다.
   최소 대상:
   - package/plugin manifests
   - hooks.json/config registration/setup/uninstall
   - lifecycle matcher, timeout, sync/async, stdout/JSON contract
   - hook input normalization과 runtime allowlist
   - transcript path/format/parser
   - archive ingestion/reconciliation
   - exchange schema, row identity, generation/closure 여부
   - fact extraction window/cap/watermark/completion transaction
   - pending extraction/claim/lease/retry/dead-letter
   - consolidation/ontology/vector/derived state
   - injection core, embedding timing, ledger/dedup
   - session continuity/current latest-session behavior
   - project/path scope와 sync protocol
   - fact revision/generation/CAS/provenance/authority
   - MCP search/read/fact/trace tools와 pagination
   - privacy purge/tombstone/cache/index/sync cleanup
   - migrations, fixtures, backward compatibility
   - existing tests, benchmarks, release verification artifacts

5. Codex hook contract를 실제 사용 버전 기준으로 확인한다.
   - Codex version과 plugin/runtime version 기록
   - `SessionStart` source values와 compact immediate continuation
   - `UserPromptSubmit`, `Stop`, `Interrupt`, `PreCompact`, `PostCompact`, `SessionEnd`
   - event별 matcher 대상
   - input field shape
   - plain stdout/JSON output 허용 여부
   - `additionalContext`와 limit
   - default/max timeout
   - background hook ordering/cancellation
   - SessionEnd 동기 실행
   - transcript format 안정성 경고
   공식 문서와 실제 runtime이 다르면 둘을 모두 기록하고 compatibility risk로 분류한다.

6. Final RFC의 각 invariant를 다음 중 하나로 분류한다.
   - already satisfied
   - partially satisfied
   - missing
   - contradicted by current implementation
   - unverifiable without runtime/integration test

7. 현재 extraction 흐름을 실제 함수와 DB statement까지 추적한다.
   - target range는 언제 고정되는가
   - upper fence가 존재하는가
   - query가 실제로 어떤 rows/exchanges를 읽는가
   - window/fact cap과 spread selection 이후 cursor가 어디까지 이동하는가
   - completion 시 live MAX를 다시 읽는가
   - concurrent insert/update가 unseen skip을 만들 수 있는가
   - 동일 exchange가 성장할 때 재처리되는가
   - deterministic/transient failure가 cursor와 완료 상태에 어떤 영향을 주는가

8. 현재 lifecycle data flow를 sequence로 정리한다.
   - startup/resume/clear/compact
   - prompt injection
   - Stop/Interrupt/Pre/PostCompact 지원 여부
   - SessionEnd foreground 작업
   - async writer 간 ordering assumption

9. 현재 continuity와 project scope를 분석한다.
   - latest session 복원 여부
   - branch/worktree/clone/device 처리
   - path가 identity인지 location인지
   - 다중 session에서 context contamination 가능성
   - assistant summary가 continuity/authority에 들어가는 경로

10. 기존 전체 test suite와 가능한 benchmark를 실행한다.
    실행 불가능한 항목은 숨기지 말고 다음을 남긴다.
    - 정확한 명령
    - 실패 환경/의존성
    - 재현 조건
    - 정적 검증으로 확인한 범위

11. Phase 1 dependency-ordered implementation map을 작성한다.
    Phase 1에서는 project ID migration, lifecycle hook 확장, Capsule, Chronicle, adaptive recall을 구현하지 않는다.

반드시 생성/갱신할 산출물:

- Final RFC repository copy
- `rfc-lock.json`
- `rfc-deviations.md`
- `phase-0-baseline.md`
- `traceability-matrix.md`

`phase-0-baseline.md` 필수 내용:

- repository revision/branch/working tree
- OS, Node, Codex, plugin/runtime, SQLite 관련 환경
- RFC SHA-256
- 현재 lifecycle sequence
- 현재 capture/index/extraction/injection/sync/MCP flow
- schema 및 migration version
- invariant gap table
- 가장 위험한 silent-loss/race/scope/authority 문제
- safety/provenance/privacy 회귀 위험
- Phase 1 구현 순서와 파일/API/schema 후보
- Phase 2~5를 막는 임시 설계 금지 목록
- baseline tests/benchmarks와 결과
- blockers/uncertainties

`traceability-matrix.md` 열:

- invariant
- RFC section
- current status
- related code
- related schema
- related tests
- target phase
- verification method
- latest gate

완료 응답 형식:

첫 줄:
`PHASE 0 AUDIT: COMPLETE`

그 뒤:
1. Baseline 요약
2. 가장 위험한 correctness gap
3. 현재 runtime contract의 핵심 차이
4. Phase 1 구현 순서
5. 생성한 문서와 RFC SHA-256
6. 실행한 테스트/benchmark와 결과
7. Blocker와 불확실성

이번 Phase에서는 구현을 시작하지 말라.
```

---

# Prompt 1A — Phase 1 구현: Correctness Spine

```text
현재 Memex repository에 Final RFC의 Phase 1 — Correctness Spine을 구현하라.

착수 전 조건:

- Phase 0 audit가 완료되어야 한다.
- repository의 Final RFC SHA-256이 `rfc-lock.json`과 일치해야 한다.
- `phase-0-baseline.md`와 `traceability-matrix.md`를 읽어야 한다.
- 불일치하면 구현을 계속하지 말고 원인을 복구하거나 BLOCKED로 보고한다.

입력 기준:

- Memex Continuity Architecture v1 — Final RFC
- phase-0-baseline.md
- traceability-matrix.md
- rfc-deviations.md
- 현재 repository의 실제 코드/schema/migration

이번 Phase의 목적:

- extractor가 실제로 보지 않은 범위를 완료 처리하지 않는다.
- cap/sampling 때문에 중간 range가 영구 누락되지 않는다.
- 같은 exchange가 성장해도 row identity 때문에 놓치지 않는다.
- 오래된 prefix가 최신 상태를 삭제하거나 되돌리지 않는다.
- 모든 처리 target과 실패 range가 durable하게 accounted된다.
- 이후 lifecycle hook이 재사용할 checkpoint/job primitive를 만든다.

이번 Phase에서 구현하지 않을 것:

- stable logical project ID/workspace migration
- Stop/Interrupt/PreCompact/PostCompact 등록
- rolling journal
- compact rehydration
- Work Capsule
- Chronicle
- adaptive recall

단, 이후 Phase가 같은 API/schema를 재사용할 수 있게 설계해야 한다.

필수 구현 범위:

1. Fixed extraction target

   - extraction claim 시 `(from, through]` closed interval을 고정한다.
   - transitional rowid를 사용하더라도 through는 시작 전에 고정해야 한다.
   - extractor query와 completion commit은 같은 target을 사용한다.
   - completion 시점의 live MAX를 다시 읽어 watermark로 쓰는 모든 경로를 제거한다.
   - concurrent insert가 target 뒤에 생겨도 unseen row를 건너뛰지 않는다.

2. Contiguous durable pagination

   - 기존 spread sampling/window cap/fact cap을 scheduling budget으로 재정의한다.
   - 한 invocation에서 일부 page/window만 처리할 수 있다.
   - 처리 순서는 target 범위 안에서 contiguous해야 한다.
   - 남은 suffix는 durable pending cursor로 남긴다.
   - rate limit, timeout, provider failure, budget exhaustion은 completed가 아니다.
   - session-level cap 때문에 나머지 범위를 영구 skip하지 않는다.
   - `MAX_FACTS_PER_SESSION`과 유사한 개념이 있다면 per-run/page budget으로 바꾸거나 완료 의미에서 분리한다.

3. Exact failure accounting

   - transient failure: retry/pending, cursor 미전진
   - oversized input: 더 작은 contiguous page로 분할
   - irreducible deterministic failure: exact range + fingerprint + error를 dead-letter/failed-visible로 기록
   - dead-letter는 completed로 합산하지 않는다.
   - 오류를 로그만 남기고 target 끝까지 완료 처리하는 경로를 제거한다.

4. Exchange content generation과 closure

   - `content_hash`, `content_generation`, `line_end` 또는 동등한 변경 감지를 추가한다.
   - `open | interrupted | closed | final` 또는 동등한 closure 상태를 표현한다.
   - 동일 exchange가 assistant/trusted-tool suffix로 성장하면 새 generation이 pending이 된다.
   - extraction identity는 최소 `(exchange_id, content_generation, policy_version)`을 구분한다.
   - stale generation의 결과가 최신 generation/current projection을 overwrite하지 못한다.
   - assistant/recall/compaction summary authority 차단은 유지한다.

5. Monotonic prefix/checkpoint ingestion primitive

   - checkpoint/prefix ingestion과 canonical full reconciliation을 분리한다.
   - prefix 경로는 monotonic partial upsert만 수행한다.
   - older prefix는 newer exchange를 delete하지 못한다.
   - lower generation/shorter line_end는 DB/API guard에 의해 update되지 않는다.
   - full desired-set reconciliation은 명시적인 canonical archive/sync 경로에만 남긴다.

6. Durable checkpoint/job schema 골격

   - Phase 2 hook이 사용할 수 있는 checkpoint target/state를 표현한다.
   - 아직 rolling journal을 구현하지 않더라도 source range, target, kind, idempotency를 담을 수 있어야 한다.
   - checkpoint와 processing job 생성 API는 같은 SQLite transaction을 지원한다.
   - schema migration은 기존 DB에 additive/staged 방식으로 적용한다.

7. SQLite transactional outbox / job queue

   최소 필드 또는 동등 정보:
   - job_id
   - kind
   - partition_key
   - checkpoint/target range
   - policy_version
   - priority
   - state: pending/running/retry/completed/dead
   - available_at
   - attempts
   - lease_owner/lease_until
   - last_error
   - unique idempotency_key

   요구:
   - atomic checkpoint + job insert
   - duplicate delivery idempotency
   - lease expiry reclaim
   - stale owner completion 거부
   - retry/backoff/dead-letter 전이
   - 동일 session partition의 ordered processing을 지원할 수 있는 구조
   - 이후 workstream/project partition을 추가할 수 있는 구조
   - 외부 broker를 추가하지 않는다.

8. Cursor/marker transaction

   - fact/current mutation과 해당 page completion marker의 정합성을 보장한다.
   - claim을 잃으면 fact insert와 cursor advance가 함께 rollback돼야 한다.
   - page에 저장할 fact가 0개여도 실제로 page가 성공 처리된 경우와 provider/validation failure를 구분한다.
   - “0 facts”가 자동으로 “성공”을 뜻하지 않게 한다.

9. Migration/compatibility

   - 기존 exchanges/facts/revisions/recall/sync/privacy data를 보존한다.
   - migration 중 process kill 후 재실행 가능해야 한다.
   - schema version을 명시한다.
   - destructive rewrite가 필요하면 copy/verify/swap 또는 staged backfill을 사용한다.
   - backfill 도중 old/new reader가 혼재할 수 있는 범위를 문서화한다.

10. Tests

   최소 자동화:

   a. extraction 시작 후 new exchange insert → fixed through만 commit
   b. completion 직전 live MAX 증가 → cursor overrun 0
   c. cap/window budget을 여러 invocation에서 소진 → target 전체 drain
   d. budget 소진 직후 crash → 동일 cursor 재개
   e. transient provider failure → completed 아님
   f. oversized page recursive split
   g. irreducible page → exact failed-visible range, completed 아님
   h. 동일 exchange growth → generation 증가 및 재처리
   i. stale generation worker completion 차단
   j. open/interrupted exchange premature completion 차단
   k. CP2 처리 후 CP1 ingest → delete/regression 0
   l. checkpoint/job atomic crash injection
   m. duplicate job delivery
   n. lease expiry와 stale owner
   o. migration fixture upgrade/re-run
   p. provenance/authority/privacy/sync regression
   q. randomized/property-style cursor coverage
   r. 기존 전체 test suite

   실제 sleep보다 fake clock/controllable scheduler를 우선한다.
   property library가 없으면 deterministic seed randomized loop를 사용한다.

구현 제약:

- 관련 없는 대규모 리팩터링 금지
- test 삭제, assertion 약화, `.only`, 영구 skip, 무의미한 sleep 금지
- 오류를 catch 후 success로 반환 금지
- 사용자 미커밋 변경 보존
- Final RFC 원문 수정 금지
- 새로운 architecture invention 금지

문서 갱신:

- traceability-matrix.md의 Phase 1 code/schema/test 위치
- rfc-deviations.md
- migration notes
- job/checkpoint/cursor state machine
- 아직 `phase-1-handoff.md`에 PASS를 선언하지 않는다. Prompt 1B가 게이트를 담당한다.

완료 응답:

1. 구현 요약
2. 변경 파일/API/schema/migration
3. fixed target과 pagination 동작
4. generation/closure와 stale worker 방어
5. outbox/lease/recovery
6. invariant별 코드 위치
7. 실행한 테스트와 결과
8. 실패/미검증 항목
9. Prompt 1B가 집중할 위험
```

---

# Prompt 1B — Phase 1 독립 검증·수정·완료 게이트

```text
Phase 1 — Correctness Spine의 독립 완료 게이트를 수행하라.

참조:

- Final RFC와 rfc-lock.json
- phase-0-baseline.md
- traceability-matrix.md
- 현재 repository의 Phase 1 구현
- 구현 worker 보고서는 참고만 하고 증거로 신뢰하지 않는다.

이번 작업은 의견 제시나 읽기 전용 review가 아니다.
발견한 race, silent loss, migration 문제, 누락된 test를 직접 수정하고 재검증하라.
Phase 2 기능은 구현하지 말라.

시작 전:

- RFC SHA-256 확인
- current HEAD/working tree 기록
- 사용자 관련 없는 변경 보존
- schema/migration 상태 확인

필수 감사:

1. Fixed target
   - target이 model call 전에 고정되는가
   - query와 commit이 동일 target인가
   - completion live MAX 우회 경로가 없는가
   - concurrent insert/update에서 unseen range skip이 없는가

2. Pagination completeness
   - 각 page가 contiguous인가
   - cap 이후 remaining cursor가 durable한가
   - target drain 전 completed가 가능한가
   - dead-letter가 completed에 섞이지 않는가
   - zero-fact success와 failed extraction이 구분되는가

3. Failure accounting
   - transient/deterministic/budget/rate-limit 분기가 cursor 의미와 일치하는가
   - oversized page가 분할되는가
   - irreducible failed range가 정확히 식별되는가
   - 실패를 로그만 남기고 넘어가는 경로가 없는가

4. Exchange generation/closure
   - content growth가 generation을 올리는가
   - trusted tool tail이 rowid 유지 때문에 누락되지 않는가
   - open/interrupted/closed/final이 실제 parser와 worker에서 일치하는가
   - stale generation result가 commit되지 않는가
   - authority lane이 회귀하지 않는가

5. Monotonic prefix ingest
   - newer 후 older ingest에서 delete/regression 0인가
   - prefix와 canonical reconcile code path가 실제로 분리됐는가
   - generation/line guard가 DB/API에서 강제되는가

6. Outbox/job/lease
   - checkpoint와 job이 같은 transaction인가
   - idempotency key가 semantic target을 정확히 표현하는가
   - duplicate delivery가 중복 effect를 만들지 않는가
   - lease expiry reclaim과 stale owner 차단이 가능한가
   - restart 후 pending/retry/dead range를 모두 발견하는가

7. Migration
   - released/current DB fixture upgrade
   - 중단 후 재실행
   - repeated invocation
   - 기존 data count/provenance/revision 유지

8. Regression
   - sync/privacy/MCP/current fact/ontology paths
   - 기존 test 삭제/약화 여부
   - Phase 2가 재사용할 API가 과도한 임시 구현이 아닌가

필수 실행:

- 전체 test suite
- deterministic-seed randomized cursor test
- concurrent insert/update test
- crash injection matrix
- out-of-order prefix test
- duplicate delivery test
- stale lease owner test
- migration fixture tests
- authority/provenance/privacy/sync regression

PASS 조건:

- mandatory test 모두 통과
- skipped/disabled/placeholder test 없음
- cursor overrun 0
- silent skipped range 0
- failed range가 completed로 계산되는 경로 0
- stale generation overwrite 0
- prefix regression/delete 0
- outbox half-state 0
- migration 재실행 가능
- Phase 2가 사용할 stable checkpoint/job/exchange APIs 문서화

환경 때문에 mandatory test를 실행하지 못하면 자동 PASS하지 않는다.
정확한 재현 명령과 정적 검증 범위를 남기고 CONDITIONAL 또는 BLOCKED로 판정한다.

생성/갱신:

- phase-1-handoff.md
- traceability-matrix.md
- rfc-deviations.md

phase-1-handoff.md 필수:

- gate status
- repository revision/working tree
- RFC SHA-256
- schema/migration version
- public/internal APIs
- invariant→code/test mapping
- 실행한 모든 test와 결과
- 직접 수정한 결함
- non-blocking debt
- Phase 2 blocker
- deviation 목록

응답 첫 줄은 반드시 다음 중 하나:

`PHASE 1 GATE: PASS`
`PHASE 1 GATE: CONDITIONAL`
`PHASE 1 GATE: BLOCKED`

PASS가 아니면 Phase 2 진입을 권하지 말라.
```

---

# Prompt 2A — Phase 2 구현: Continuity Core

```text
현재 Memex repository에 Final RFC의 Phase 2 — Continuity Core를 구현하라.

착수 전 조건:

- phase-1-handoff.md가 `PHASE 1 GATE: PASS`여야 한다.
- Final RFC SHA-256이 rfc-lock.json과 일치해야 한다.
- PASS가 아니면 Phase 1 blocker를 먼저 복구한다.

목표:

- 장기 session의 transcript를 incremental durable journal로 포착한다.
- Stop/Interrupt/PreCompact/SessionEnd를 빠른 capture boundary로 만든다.
- compaction 직후 같은 turn continuation부터 작업 상태를 복원한다.
- Work Capsule을 fact보다 우선하는 continuity projection으로 도입한다.
- PostCompact 없이도 correctness가 성립한다.

이번 Phase에서는 기존 path-based project scope를 compatibility identity로 유지할 수 있다.
Stable logical project/workspace migration과 cross-device link는 Phase 3에서 구현한다.
Chronicle은 Phase 4, adaptive recall 최적화는 Phase 5다.

필수 구현 범위:

1. Append-only rolling journal

   - Memex-owned journal을 도입한다.
   - 매 hook에서 transcript 전체를 반복 복사하지 않는다.
   - 이전 copied boundary 이후의 새 complete bytes/lines만 append한다.
   - trailing partial line은 다음 capture로 보류한다.
   - source identity, size, mtime 또는 동등 guard를 둔다.
   - block hash chain/prefix hash를 기록한다.
   - source truncate/replace/rewind 시 기존 journal을 되감지 않고 new stream_epoch을 만든다.
   - parser_version과 source format version/compatibility를 추적한다.
   - transcript path traversal/symlink/unexpected file 검증을 한다.

2. Checkpoint finalization

   checkpoint identity는 최소 다음 prefix identity를 포함한다.
   - session_id
   - stream_epoch
   - through byte/line
   - prefix/segment hash
   - kind

   turn_id 단독 ID를 금지한다.
   동일 event 재전달은 same effect여야 한다.
   같은 turn에서 prefix가 성장한 뒤 다시 compact되면 새 checkpoint여야 한다.

3. Unified hook gateway

   - event별 script 폭증보다 공통 normalize/dispatch gateway를 우선한다.
   - package bin, plugin manifest, runtime allowlist, install/setup/uninstall과 정합성을 유지한다.
   - payload 필드 손실 없이 normalize:
     session_id, transcript_path, cwd, hook_event_name, turn_id,
     source, trigger, reason, permission_mode, stop_hook_active, last_assistant_message
   - event별 valid stdout/JSON contract를 구현한다.
   - plain text가 invalid인 Stop/Interrupt 등에서 invalid output을 내지 않는다.

4. Lifecycle registration

   최종 역할:

   a. SessionStart(startup)
      - path-scoped project/session resolve
      - queue recovery signal
      - context epoch/session state ensure
      - 보통 context 없음 또는 pinned invariants만

   b. SessionStart(resume)
      - 기존 session→minimal workstream exact restore
      - Capsule freshness 확인
      - Capsule + bounded current bundle

   c. SessionStart(clear)
      - new context_epoch
      - old resident/carry 폐기
      - pinned constraints만 최소 context

   d. UserPromptSubmit
      - 기존 retrieval path를 correctness 우선으로 유지
      - Phase 5 cheap gate를 미리 완성하지 않는다.
      - 단, context_epoch/revision-aware residency와 충돌하지 않게 연결한다.

   e. Stop
      - journal delta append
      - completed turn/closed fence
      - checkpoint + coalesced job atomic commit
      - extraction/embedding 호출 없음

   f. Interrupt
      - journal delta append
      - interrupted/open fence
      - premature closed 처리 금지
      - 짧은 runtime timeout 내 bounded local I/O

   g. PreCompact
      - remaining complete delta append + fsync
      - immutable prefix checkpoint
      - carry candidate freeze
      - outbox atomic commit
      - model/embedding 호출 없음

   h. PostCompact
      - correctness dependency로 구현하지 않는다.
      - runtime에서 가치가 확인되면 optional telemetry/diagnostics만 허용한다.
      - PostCompact가 전혀 호출되지 않는 fixture에서도 전체 flow가 통과해야 한다.

   i. SessionStart(compact)
      - latest captured checkpoint/epoch transition idempotent ensure
      - 다음 model request에 immediate additionalContext
      - 새 semantic query/full retrieval 없이 local projection read

   j. SessionEnd
      - final delta + final fence + durable job
      - transcript stabilization, extraction, embedding, consolidation, export 완료를 foreground에서 기다리지 않는다.
      - supported timeout 안에 반환한다.

5. Context epoch와 residency

   - session state를 `(session_id, context_epoch)` 의미로 관리한다.
   - compaction/clear에서 old residency 가정을 무효화한다.
   - resident fact identity는 최소 `(fact_id, semantic_generation, lifecycle_generation)`이다.
   - old epoch에서 한 번 주입됐다는 이유로 새 epoch에서 suppress하지 않는다.
   - inactive/superseded revision은 carry하지 않는다.
   - same fact new generation은 같은 epoch에서도 correction/update가 가능해야 한다.

6. Minimal workstream state

   Phase 3 전의 안전한 최소 binding:

   - resumed session은 기존 workstream 유지
   - explicit workstream/branch hint가 있으면 사용 가능
   - 확실하지 않으면 session-local workstream 생성
   - “가장 최근 session”을 무조건 연결하지 않는다.
   - cross-workspace/project inference는 아직 구현하지 않는다.

7. Work Capsule

   최소 typed fields:
   - objective
   - current_state
   - verified_progress with sources
   - hypotheses with sources
   - blockers
   - open_questions
   - next_actions
   - touched_areas
   - carry_fact_revisions
   - generation
   - through_checkpoint_id

   규칙:
   - context-only projection
   - fact evidence로 재학습 금지
   - verified/hypothesis 타입 분리
   - source checkpoint/exchange 추적
   - bounded 800~1,500자 target
   - same workstream generation CAS
   - 매 turn LLM summary 금지

8. Capsule worker 우선순위

   Worker scheduling:

   P0 capture recovery
   P1 Capsule update
   P2 fact extraction
   P3 이후 단계 예약

   Segment는 contiguous하게 처리한다.
   초기 coalescing 후보:
   - substantive exchange 6~8개
   - 또는 8~16KB
   - 또는 PreCompact
   - 또는 SessionEnd

   threshold는 config 폭발 없이 소수로 유지하고 실측 근거를 문서화한다.

9. Capsule과 Fact extraction 분리

   - 초기 구현에서는 별도 typed pipeline/prompt로 둔다.
   - fact authority precision을 Capsule summary와 섞지 않는다.
   - 미래에 합칠 수 있는 benchmark seam은 둘 수 있지만 현재 합치지 않는다.

10. Deterministic tail baton

    Capsule worker가 지연되거나 실패해도 다음 local evidence로 fallback context를 만든다.
    - latest substantive user request
    - last completed plan item
    - recent touched files
    - last trusted test status
    - latest unresolved error

    tail baton은 context-only이며 fact/Chronicle source가 아니다.

11. Compact rehydration

    다음 순서로 bounded bundle을 만든다.
    - latest current Capsule
    - stale/missing이면 tail baton
    - pinned constraints
    - previous epoch carry candidates의 latest active revisions
    - recently changed correction facts

    모든 project fact를 주입하지 않는다.
    compact 출력은 new epoch residency에 기록한다.
    다음 UserPromptSubmit에서 즉시 같은 revision이 반복되지 않게 한다.

12. Capture gap/recovery

    - capture 실패를 silent success로 위장하지 않는다.
    - durable capture_gap record
    - 기본 fail-open + visible warning where contract permits
    - single strict_capture switch MAY
    - startup/resume/compact recovery가 orphan checkpoint/job/gap을 찾는다.
    - PostCompact 누락 recovery도 이 경로에 포함한다.

13. Tests

    최소 자동화:

    a. 100~200 turn incremental append에서 full transcript 반복 read/copy 없음
    b. trailing partial line
    c. source truncate/replace → stream epoch
    d. duplicate Stop/PreCompact idempotency
    e. same-turn double compact → distinct prefix checkpoint
    f. PostCompact event 0회에서도 epoch/rehydration 정상
    g. PreCompact 후 process crash, compact SessionStart recovery
    h. journal fsync 후 DB commit 전 crash
    i. checkpoint/outbox commit 후 wake 전 crash
    j. compact 직후 immediate additionalContext fixture
    k. old epoch fact rehydrate
    l. inactive revision carry 차단
    m. same fact new generation correction 가능
    n. Stop closed vs Interrupt open
    o. clear old carry 폐기
    p. Capsule authority typing
    q. Capsule CAS/stale worker
    r. tail baton fallback
    s. hook path에서 model/embedding call 0
    t. SessionEnd final fence와 timeout
    u. hook setup/install/upgrade/uninstall idempotency
    v. malformed payload/path security
    w. 기존 전체 test suite

구현 제약:

- stable project/workspace migration 금지
- cross-device linking 금지
- Chronicle 금지
- adaptive retrieval 전체 금지
- external broker/vector DB 금지
- compaction summary authority 금지
- Final RFC 원문 수정 금지

문서 갱신:

- actual lifecycle sequence
- event payload/output/timeout matrix와 검증 runtime version
- journal/checkpoint state machine
- context epoch/residency contract
- Work Capsule schema/authority/lifecycle
- tail baton behavior
- recovery/capture gap matrix
- traceability/rfc deviations

완료 응답:

1. 구현 요약
2. lifecycle별 실제 동작
3. journal/checkpoint identity
4. Capsule/tail baton/worker priority
5. context epoch와 compact rehydration 예
6. PostCompact 비의존성 근거
7. crash/recovery 처리
8. tests/benchmark 결과
9. Prompt 2B 집중 위험
```

---

# Prompt 2B — Phase 2 독립 검증·수정·완료 게이트

```text
Phase 2 — Continuity Core의 독립 완료 게이트를 수행하라.

Final RFC, phase-1-handoff.md, rfc-lock, 현재 repository를 기준으로 검증한다.
구현 보고서를 신뢰하지 말고 실제 hook registration, process boundary, DB state와 runtime fixture를 추적한다.
발견한 문제는 직접 수정하고 전체 test를 다시 실행한다.
Phase 3 기능은 구현하지 않는다.

필수 질문:

1. 모든 captured prefix가 durable journal boundary와 hash로 검증 가능한가
2. long session에서 full-copy 제곱 I/O가 없는가
3. source truncate/replace가 silent rewind가 아니라 stream epoch인가
4. duplicate/out-of-order capture가 same effect로 수렴하는가
5. Stop은 closed, Interrupt는 open으로 남는가
6. PreCompact가 model/embedding 없이 빠르게 끝나는가
7. PostCompact가 한 번도 오지 않아도 correctness가 성립하는가
8. SessionStart(compact)가 same-turn continuation에 실제 additionalContext를 주는가
9. old epoch ledger가 필요한 fact를 suppress하지 않는가
10. same fact new generation이 correction 대상이 되는가
11. Capsule verified/hypothesis authority가 섞이지 않는가
12. Capsule 지연 시 tail baton이 존재하는가
13. SessionEnd가 heavy foreground work를 제거했는가
14. hook output shape가 event별 contract에 맞는가
15. capture gap이 durable하고 진단 가능한가

필수 adversarial matrix:

- 200 turns
- 6 auto + 2 manual compactions
- same-turn double compact
- multiple Interrupt
- duplicate Stop/PreCompact
- no PostCompact fixture
- crash before/after journal fsync
- crash before/after checkpoint+outbox commit
- transcript truncation/replacement
- old checkpoint late arrival
- compact immediate rehydrate
- clear semantics
- stale/inactive revision carry attempt
- Capsule stale CAS completion
- Capsule worker failure + tail baton
- SessionEnd final fence
- setup reinstall/upgrade/uninstall
- malformed payload/path

Runtime contract 검증:

- 실제 Codex version
- source/trigger/reason matcher
- input fields
- plain stdout vs JSON
- timeout/default/max
- additionalContext limit/spill behavior
- background concurrency/cancellation
- transcript format caveat

성능 검증:

- capture hook model calls = 0
- hook path embedding calls = 0
- incremental append bytes vs transcript total size
- journal/fence latency distribution
- DB contention under duplicate hooks
- compact rehydrate가 new extraction을 기다리지 않음

PASS 조건:

- capture/hash/accountability invariant 충족
- unaccounted closed exchange 0
- prefix hash mismatch 0
- wrong closure 0
- PostCompact absence failure 0
- compact rehydration miss 0
- old epoch suppress/carry error 0
- Capsule authority contamination 0
- heavy foreground hook work 0
- mandatory migration/test 통과
- Phase 3가 재사용할 journal/checkpoint/Capsule/session state APIs 문서화

생성/갱신:

- phase-2-handoff.md
- traceability-matrix.md
- rfc-deviations.md

phase-2-handoff 필수:

- gate status
- revision/working tree/RFC SHA
- lifecycle registration table
- verified runtime contract
- journal/checkpoint state machine
- context epoch/residency
- Capsule/tail baton contract
- recovery matrix
- performance/test results
- 직접 수정한 결함
- debt와 Phase 3 blockers

응답 첫 줄:

`PHASE 2 GATE: PASS`
`PHASE 2 GATE: CONDITIONAL`
`PHASE 2 GATE: BLOCKED`

PASS가 아니면 Phase 3에 진입하지 말라.
```

---

# Prompt 3A — Phase 3 구현: Multi-session & Workspace Identity

```text
현재 Memex repository에 Final RFC의 Phase 3 — Multi-session & Workspace Identity를 구현하라.

착수 전 조건:

- phase-2-handoff.md가 `PHASE 2 GATE: PASS`
- RFC SHA-256 일치
- journal/checkpoint/Capsule APIs가 handoff와 일치

목표:

- path를 논리 project identity에서 분리한다.
- 같은 project의 여러 workspace/worktree/session/workstream을 안전하게 다룬다.
- latest session 무조건 복원으로 인한 context contamination을 제거한다.
- feature/workstream 상태와 project-wide current truth를 구분한다.
- sibling session 변경을 generation/revision invalidation으로 전달한다.

이번 Phase에서는 Chronicle causal history 전체를 구현하지 않는다.
단, Phase 4가 사용할 stable `subject_key`와 source/scope 기초를 추가할 수 있다.
Adaptive recall은 Phase 5다.

필수 구현 범위:

1. Stable logical project registry

   - `project_id`를 장기 logical identity로 도입한다.
   - 기존 path-scoped data를 손실 없이 migration한다.
   - absolute path는 workspace/location provenance가 된다.
   - project record에 memory_revision을 둔다.
   - portable project key 또는 explicit link identity를 지원한다.

2. Workspace entity

   최소 정보:
   - workspace_id
   - project_id
   - device_id
   - canonical_path
   - git_common_dir
   - approved remote fingerprint
   - location_kind: worktree/clone/directory
   - branch
   - last_seen_at

   device-local paths는 sync durable identity가 아니다.

3. Resolver policy

   우선순위:
   a. explicit portable project UUID/approved link
   b. same local git common-dir
   c. already approved remote mapping
   d. canonical cwd fallback → new project/workspace

   금지:
   - basename만으로 merge
   - remote URL만으로 silent merge
   - package name만으로 merge

   ambiguous candidate는 suggestion/pending mapping으로 남긴다.
   explicit link/split command/API를 제공한다.
   link/split은 idempotent하고 audit 가능해야 한다.

4. Existing data migration

   - 각 기존 canonical path를 우선 1:1 project/workspace에 연결한다.
   - 자동 합치기는 safe local common-dir 등 검증된 경우만 staged하게 한다.
   - facts, exchanges, revisions, recall, sync metadata, checkpoint, Capsule provenance를 보존한다.
   - migration interrupt/re-run fixture를 둔다.
   - old path query compatibility 기간과 deprecation을 문서화한다.

5. Workstream binding 완성

   우선순위:
   1. resume session_id → exact workstream
   2. explicit workstream/task/branch binding
   3. same workspace/branch + unique active workstream
   4. prompt↔Capsule strong topic match with margin
   5. ambiguity → new session-local workstream

   규칙:
   - branch는 hint이지 identity가 아니다.
   - latest session 자동 선택 금지
   - 매 prompt LLM classifier 금지
   - topic match는 cheap/deterministic first
   - 자동 연결 결정과 confidence/reason을 기록
   - 사용자가 rebind/split 가능

6. Work Capsule sharing/concurrency

   - Capsule은 workstream scope다.
   - same workstream multiple sessions는 verified progress를 공유할 수 있다.
   - unrelated workstream blocker/next action은 공유하지 않는다.
   - workstream partition serialization + generation CAS
   - source workspace/session을 보존
   - stale session patch가 최신 Capsule을 overwrite하지 못한다.

7. Project current truth와 workspace/workstream state 분리

   정책:

   - unmerged/experimental implementation → Capsule
   - project-level explicit decision → decision fact 가능
   - merged/validated implementation → current state fact

   최소 stable slot `subject_key` 또는 동등 모델을 도입한다.

   예:
   - `decision.runtime.session_store.target = Redis`
   - `state.main.runtime.session_store = MySQL`
   - Redis workstream implementation state는 Capsule

   branch-specific full fact graph는 구현하지 않는다.

8. Multi-session freshness

   - semantic/lifecycle current state의 meaningful mutation 시 project.memory_revision 증가
   - no-op/derived-only update는 revision storm을 만들지 않는다.
   - session은 memory_revision_seen과 capsule_generation_seen을 가진다.
   - sibling session 변경을 active turn에 push하지 않는다.
   - 다음 UserPromptSubmit/resume/compact 경계에서 stale 감지
   - old resident revision과 충돌하면 correction candidate 생성

9. Memory lanes

   A. Durable Fact Lane
      - current authoritative facts

   B. Hot Evidence Lane
      - Stop/checkpoint에서 index된 recent human/trusted-tool evidence
      - 아직 distilled fact가 아님을 명시
      - sibling freshness 보완
      - TTL/bounded result/pagination

   C. Assistant Continuity Lane
      - assistant/Capsule/compact summary는 context-only
      - fact authority로 재진입 금지

   lane은 schema, query, formatting에서 구분한다.

10. Injection/rehydration scope

    - project current facts는 project scope
    - Capsule/blocker/next action은 workstream scope
    - workspace current state가 검증된 경우에만 해당 workspace context
    - unrelated workstream 자동 injection 0
    - ambiguous binding에서는 project invariants만 최소 주입하고 wrong Capsule을 넣지 않는다.

11. MCP scope

    기존 MCP 도구가 다음 scope를 명시적으로 다룰 수 있게 한다.
    - project
    - workspace
    - workstream
    - session
    - all/global where already allowed

    MCP server process cwd로 project identity를 추정하지 않는다.
    자동 주입에 없는 다른 session evidence를 MCP로 검색 가능하게 유지한다.

12. Sync protocol identity migration

    - stable project ID/portable key를 durable sync identity로 사용
    - device-local path는 local metadata
    - workspace mapping의 portable 부분과 local 부분 분리
    - replay idempotency
    - ambiguous merge 금지
    - concurrent semantic/lifecycle mutation은 generation/CAS/conflict preservation
    - full CRDT 도입 금지
    - 구 protocol peer compatibility/upgrade 문서화

13. Privacy purge

    - project/workspace/workstream/session mapping
    - Capsule
    - journal/checkpoint provenance
    - Hot Evidence
    - sync payload/cache/index
    을 기존 purge/tombstone semantics에 포함한다.
    Pending worker가 purged data를 재생성하지 못하게 tombstone/version guard를 둔다.

14. Tests

    최소 시나리오:

    a. same repo different cwd
    b. same repo multiple worktrees
    c. same remote different device/path explicit link
    d. no-remote directory
    e. same remote intentional split
    f. ambiguous remote auto-merge 차단
    g. link/split idempotency와 audit
    h. migration interrupt/re-run/data preservation
    i. session A/C same workstream
    j. session B different workstream
    k. A verified progress가 C에 공유
    l. A blocker가 B에 injection되지 않음
    m. latest unrelated session 선택 차단
    n. ambiguous binding → new workstream
    o. same branch multiple tasks contamination 차단
    p. feature Redis/main MySQL truth separation
    q. project memory revision update/no-op behavior
    r. sibling fact evolution → stale session correction candidate
    s. stale Capsule CAS completion 차단
    t. Hot Evidence label/TTL/authority
    u. assistant/Capsule authority 재진입 차단
    v. MCP scope/query
    w. sync replay/conflict/legacy peer
    x. privacy purge during pending job
    y. 기존 전체 test suite

구현하지 말 것:

- Chronicle event/timeline 전체
- incident pattern/grounded rationale history 전체
- adaptive prompt gate 전체
- branch-scoped knowledge graph
- automatic global promotion
- every-prompt LLM workstream classifier
- external broker/CRDT
- Final RFC 수정

문서 갱신:

- project/workspace/workstream/session model
- resolver/link/split rules
- migration and compatibility
- binding decision table
- branch/workspace promotion policy
- memory lanes/authority
- memory_revision/Capsule generation contract
- MCP scope
- sync/privacy matrix
- traceability/deviations

완료 응답:

1. 구현 요약
2. identity/migration/resolver
3. workstream binding/Capsule isolation
4. branch/current truth policy
5. multi-session freshness/Hot Evidence
6. MCP/sync/privacy
7. tests와 결과
8. Prompt 3B 집중 위험
```

---

# Prompt 3B — Phase 3 독립 검증·수정·완료 게이트

```text
Phase 3 — Multi-session & Workspace Identity의 독립 완료 게이트를 수행하라.

Final RFC, phase-2-handoff, rfc-lock, current repository를 기준으로 검증한다.
구현 보고서를 신뢰하지 말고 실제 migration/resolver/binding/query/injection/sync/purge path를 추적한다.
발견한 문제는 직접 수정한다.
Phase 4 Chronicle 기능은 구현하지 않는다.

필수 감사:

1. Project/workspace identity
   - path move 후 same project resolve
   - worktree same project + distinct workspace
   - same remote clone silent merge 차단
   - explicit link/split idempotency
   - portable ID와 local path 분리

2. Migration
   - existing path-scoped data count/provenance 보존
   - checkpoint/Capsule/fact/recall/sync references 보존
   - interrupt/re-run
   - legacy query compatibility

3. Workstream binding
   - resume exact
   - explicit binding
   - unique active branch case
   - strong topic margin
   - ambiguity→new
   - latest session fallback 금지
   - hidden LLM classifier 없음

4. Isolation
   - project facts vs workstream Capsule 실제 query/injection 분리
   - same workstream shared progress
   - unrelated blocker/next action leakage 0
   - stale Capsule overwrite 0

5. Branch/workspace truth
   - unmerged state가 project-wide current state로 승격되지 않는가
   - decision target과 deployed/current state가 구분되는가
   - subject_key/slot 충돌이 감지되는가

6. Multi-session freshness
   - meaningful mutation만 memory_revision 증가
   - no-op/derived update storm 없음
   - stale seen revision이 correction을 막지 않음
   - next natural boundary에서 sibling update 감지

7. Lanes/authority
   - Hot Evidence는 NOT YET DISTILLED 표시
   - assistant/Capsule/compact summary가 fact evidence로 들어가지 않음
   - current fact와 context-only lane 충돌 시 current 우선

8. MCP/sync/privacy
   - scope가 명시적
   - MCP process cwd inference 없음
   - stable ID sync, path leakage 최소화
   - replay idempotency/conflict preservation
   - purge cascade와 pending job resurrection 차단

필수 adversarial matrix:

- multiple worktrees
- cross-device explicit link
- ambiguous same remote clones
- same branch multiple workstreams
- same/different workstream concurrent sessions
- project move/rename
- feature Redis vs main MySQL
- concurrent current state updates
- stale Capsule worker
- duplicate/out-of-order sync
- purge during queued work
- legacy DB/protocol upgrade

PASS 조건:

- cross-project leakage 0
- wrong-workstream continuity injection 0
- ambiguous auto-merge 0
- path identity split in covered linked scenario 0
- unmerged state project-current promotion 0
- stale Capsule overwrite 0
- Hot Evidence authority confusion 0
- migration loss 0
- sync replay/purge safety
- mandatory tests 전체 통과
- Phase 4가 사용할 project/workspace/workstream/subject/source APIs 문서화

생성/갱신:

- phase-3-handoff.md
- traceability-matrix.md
- rfc-deviations.md

응답 첫 줄:

`PHASE 3 GATE: PASS`
`PHASE 3 GATE: CONDITIONAL`
`PHASE 3 GATE: BLOCKED`

phase-3-handoff 필수:

- gate/revision/RFC SHA
- schema/protocol versions
- resolver contract
- binding decision table
- scope/promotion matrix
- memory revision contract
- lanes/MCP/sync/privacy contract
- tests/defects/debt
- Phase 4 blockers
```

---

# Prompt 4A — Phase 4 구현: Chronicle & Deep Memory Exploration

```text
현재 Memex repository에 Final RFC의 Phase 4 — Chronicle & Deep Memory Exploration을 구현하라.

착수 전 조건:

- phase-3-handoff.md가 `PHASE 3 GATE: PASS`
- RFC SHA 일치
- stable project/workspace/workstream/subject/source 모델이 문서화되어 있음

목표:

- Current Fact와 그 Fact가 형성된 인과 계보를 분리한다.
- 중요한 변화·rollback·validation·incident만 sparse Chronicle로 보존한다.
- 원인과 모델 추정을 구분한다.
- 자동 injection에 없는 history/source/other session memory를 MCP로 깊게 탐색할 수 있게 한다.

이번 Phase에서는 UserPromptSubmit adaptive gate와 최종 WATCH/TRACE injection routing을 완성하지 않는다.
Phase 5가 Memory Broker 최적화를 담당한다.
단, Phase 5가 사용할 Chronicle query와 incident match API를 제공한다.

필수 구현 범위:

1. Current projection vs Chronicle

   - facts table/current projection은 빠른 현재 진실을 유지한다.
   - Chronicle은 append-only semantic events다.
   - 매 query마다 event replay로 current fact를 계산하지 않는다.
   - 기존 fact_revisions를 확장하는 것이 자연스러우면 재사용한다.
   - parallel duplicate history system을 만들지 않는다.

2. Subject key

   - stable semantic slot을 완성한다.
   - 예:
     state.runtime.session_store
     decision.runtime.session_store.target
     state.prod.primary_database
     constraint.session.ttl
   - 같은 단어라도 subject가 다르면 별도 current slot이다.
   - subject migration/backfill은 deterministic하고 재실행 가능해야 한다.
   - ambiguous subject는 강제 current overwrite보다 unresolved candidate로 남긴다.

3. Minimal event kinds

   최소:
   - ASSERTED
   - CHANGED
   - RETIRED
   - RESTORED
   - VALIDATED
   - INCIDENT
   - CONTRADICTED

   rollback은 CHANGED + `reverts_event_id`로 표현 가능하다.
   기존 DUPLICATE/EVOLUTION/CONTRADICTION relation과 mapping을 문서화한다.

4. Event schema

   최소 정보 또는 동등 구조:
   - event_id
   - project_id
   - subject_key
   - fact_id nullable
   - event_kind
   - from/to semantic generation
   - previous/new value
   - problem
   - grounded_cause
   - rationale
   - classifier_note
   - outcome_json
   - source exchange/evidence IDs
   - reverts/related event IDs
   - actor
   - policy_version
   - effective_at
   - recorded_at

   event ID는 duplicate retry/sync replay에 idempotent해야 한다.

5. Temporal semantics

   - effective_at = 실제 사건/결정/변경 시점
   - recorded_at = worker 처리 시점
   - worker completion order를 history order로 사용하지 않는다.
   - source timestamp가 불확실하면 uncertainty를 표현한다.
   - concurrent/out-of-order events에서 CAS와 contradiction handling을 사용한다.

6. Grounded cause vs classifier note

   - source에 이유가 명시된 경우에만 grounded_cause/rationale authoritative
   - model/consolidator 추정은 classifier_note
   - evidence 없으면 cause null/unknown
   - API/MCP/CLI formatting에서도 둘을 구분
   - source purge 시 provenance/cause linkage 안전 처리

7. Event creation policy

   event 생성:
   - durable current fact 의미 변화
   - rationale 포함 explicit decision
   - trusted validation/incident evidence
   - rollback/restore
   - independent repeated failure episode

   event 미생성:
   - rephrasing
   - formatting
   - 단순 file edit/open
   - assistant 추측
   - 동일 오류 연속 출력
   - classifier 단독 의견

8. Projection/event transaction

   - current mutation과 required Chronicle event의 정합성
   - stale worker가 current/event를 overwrite 또는 중복 생성하지 못함
   - current update가 실패하면 event만 남는 half-state 방지
   - event-only INCIDENT/VALIDATED처럼 current mutation이 없는 경우 명확히 구분
   - duplicate delivery idempotency

9. Rollback/restore

   - 이전 event를 삭제하지 않는다.
   - current projection은 새 상태로 갱신
   - reverts_event_id/source/effective_at 연결
   - Redis→MySQL rollback 뒤에도 MySQL→Redis 시도와 outcome 보존

10. Incident pattern

    - incident episodes를 source-linked occurrence로 표현
    - stable failure signature 또는 canonical key
    - 같은 turn/session/root-cause retry coalesce
    - independent authoritative episodes 2개 이상 또는 user explicit repeat에서 pattern candidate
    - validated remediation evidence
    - 단순 absence of recurrence로 resolved 추정 금지
    - Phase 5 WATCH에서 사용할 bounded match API

11. MCP deep exploration

    기존 도구를 우선 확장한다.
    `trace_fact` 또는 가장 자연스러운 tool이 다음을 연결한다.
    - current fact
    - Chronicle timeline
    - previous values
    - rollback/restore
    - grounded cause vs classifier note
    - validation/outcome
    - source exchange/evidence
    - contradiction
    - incident occurrences

    요구:
    - source/history/other session memory 탐색
    - bounded pagination/cursor
    - project/workspace/workstream/session filter
    - authority lane 표시
    - missing/deleted/purged source 처리
    - tool proliferation 최소화

12. Search/CLI explain path

    기존 CLI/skill 구조에 자연스럽다면 `memex explain <subject>` 또는 동등 UX를 제공할 수 있다.
    새 command가 불필요하면 기존 fact history/trace에 통합한다.
    핵심은 API capability이지 command 수가 아니다.

13. Sync

    - stable event ID/project ID
    - duplicate replay idempotency
    - out-of-order effective/recorded handling
    - semantic/lifecycle CAS와 conflict preservation
    - silent last-write-wins 금지
    - local derived classifier/embedding은 필요에 따라 rebuildable
    - protocol migration/legacy peer behavior 문서화

14. Privacy purge

    - fact event
    - incident occurrence/signature
    - source linkage
    - MCP indexes/cache
    - sync export/import artifacts
    - pending Chronicle jobs
    을 purge/tombstone에 포함한다.
    purged evidence를 event formatter가 노출하지 않는다.

15. Outcome telemetry

    저장 가능한 measured values:
    - semantic retrieval calls
    - injected chars/tokens
    - repeated context turns
    - duplicate tool calls
    - time to first correct action
    - incident recurrence
    - warning precision

    측정되지 않은 개발 시간/비용 절감을 Chronicle fact로 만들지 않는다.
    telemetry derived report와 authoritative project fact를 분리한다.

16. Tests

    최소:

    a. ASSERTED current+event
    b. MySQL→Redis CHANGED
    c. Redis→MySQL rollback with reverts_event_id
    d. RETIRED/RESTORED
    e. VALIDATED/INCIDENT without invalid current mutation
    f. contradiction candidate
    g. duplicate event retry
    h. stale worker current/event overwrite 차단
    i. effective_at 순서와 recorded_at 역순
    j. missing cause → null
    k. model inferred reason → classifier_note only
    l. source purge behavior
    m. subject key collision/ambiguity
    n. same retry occurrence coalescing
    o. independent episodes pattern candidate
    p. remediation/resolution evidence
    q. MCP current→timeline→evidence
    r. MCP large pagination
    s. other session/workstream filtering
    t. sync duplicate/out-of-order/conflict
    u. privacy purge during pending Chronicle job
    v. assistant/Capsule contamination attempt
    w. existing entire test suite

구현하지 말 것:

- every fact rewording event
- all conversation narrative
- every-prompt WATCH/TRACE injection optimization
- adaptive embedding gate
- full event-sourced DB
- complex CRDT
- unverifiable ROI fact
- assistant answer as Chronicle source
- Final RFC modification

문서 갱신:

- subject key policy
- event kinds/schema/transaction
- effective_at vs recorded_at
- grounded cause policy
- rollback/contradiction
- incident pattern and match API
- MCP trace/pagination examples
- sync/privacy
- telemetry semantics
- traceability/deviations

완료 응답:

1. 구현 요약
2. Current Facts vs Chronicle
3. event/temporal/grounding contract
4. rollback/incident behavior
5. MCP exploration examples
6. sync/privacy/telemetry
7. tests와 결과
8. Prompt 4B 집중 위험
```

---

# Prompt 4B — Phase 4 독립 검증·수정·완료 게이트

```text
Phase 4 — Chronicle & Deep Memory Exploration의 독립 완료 게이트를 수행하라.

Final RFC와 current repository가 기준이다.
이전 보고를 신뢰하지 말고 schema, transaction, consolidation, MCP, sync, purge code path를 추적한다.
발견한 결함은 직접 수정한다.
Phase 5 adaptive recall은 구현하지 않는다.

필수 감사:

1. Current projection과 event history가 분리되고 정합적인가
2. current mutation과 required event가 half-state 없이 commit되는가
3. duplicate/stale worker가 history를 중복/overwrite하지 않는가
4. subject key가 의미 슬롯을 안정적으로 구분하는가
5. effective_at과 recorded_at이 worker order를 분리하는가
6. rollback이 과거 event를 삭제하지 않는가
7. evidence 없는 cause가 grounded field로 들어가는 경로가 없는가
8. classifier note가 API/MCP에서 authoritative cause처럼 보이지 않는가
9. incident retry coalescing과 independent episode 기준이 맞는가
10. no-recurrence만으로 resolved를 추정하지 않는가
11. MCP가 current/history/source/other session을 실제로 탐색하는가
12. history query가 bounded/paginated되는가
13. sync replay/out-of-order/conflict가 안전한가
14. purge 후 event/source/cache가 부활하지 않는가
15. measured telemetry와 unverified ROI가 구분되는가

필수 matrix:

- assert/change/retire/restore/validate/incident/contradict
- evolution then rollback
- recorded order opposite effective order
- duplicate event delivery
- stale fact generation after new generation
- missing cause evidence
- model hallucinated rationale attempt
- source deletion/purge
- same retry vs independent incidents
- concurrent sessions same subject
- MCP pagination and filters
- sync duplicate/out-of-order
- purge while queued

PASS 조건:

- duplicate authoritative event 0
- history deletion on rollback 0
- ungrounded cause authoritative 0
- temporal order corruption 0
- incident count inflation 0
- MCP current→event→source trace success
- history pagination bounded
- sync/purge safe
- mandatory tests 전체 통과
- Phase 5가 사용할 Chronicle query/incident match/current revision APIs 문서화

생성/갱신:

- phase-4-handoff.md
- traceability-matrix.md
- rfc-deviations.md

응답 첫 줄:

`PHASE 4 GATE: PASS`
`PHASE 4 GATE: CONDITIONAL`
`PHASE 4 GATE: BLOCKED`

handoff 필수:

- gate/revision/RFC SHA
- schema/protocol versions
- subject/event contract
- temporal/grounding contract
- incident match API
- MCP contract
- sync/privacy/telemetry tests
- defects/debt
- Phase 5 blockers
```

---

# Prompt 5A — Phase 5 구현: Adaptive Recall & Product Calibration

```text
현재 Memex repository에 Final RFC의 Phase 5 — Adaptive Recall & Product Calibration을 구현하라.

착수 전 조건:

- phase-4-handoff.md가 `PHASE 4 GATE: PASS`
- RFC SHA 일치
- context epoch/Capsule/project revision/Chronicle/MCP APIs가 문서화됨

목표:

- UserPromptSubmit hook은 유지하되 expensive embedding/retrieval을 매번 실행하지 않는다.
- 자동 injection을 작은 working-memory fast path로 만든다.
- compaction/multi-session continuity와 correction correctness를 유지한다.
- MCP는 source/history/other memory deep path로 그대로 유지한다.
- 비용 감소와 recall 품질을 함께 측정한다.

필수 구현 범위:

1. Pre-retrieval cheap gate

   - embedding/vector search/relation expansion보다 먼저 실행한다.
   - skip path에서 expensive call 0회를 계측하고 테스트한다.
   - local state와 cheap lexical fingerprint를 사용한다.
   - gate 자체에서 LLM을 호출하지 않는다.

2. Recall triggers

   최소:
   - first substantive prompt in context epoch
   - context_epoch changed
   - Capsule generation changed
   - project memory_revision > session seen
   - explicit memory/history/source/why/when/repeated intent
   - significant topic drift
   - resident lexical coverage 부족
   - known incident/failure signature match
   - high-impact decision/change prompt
   - safety refresh after bounded substantive prompts
   - compact 이후 first real prompt

   skip 후보:
   - 감사/ack
   - “계속해”
   - 의미 없는 짧은 확인
   - 직전 turn을 명확히 잇는 minor correction

   짧다는 이유만으로 explicit memory 질문을 skip하지 않는다.

3. Topic/coherency signal

   - normalized token/Jaccard/SimHash 등 cheap signal first
   - threshold는 deterministic/configurable but few defaults
   - ambiguous path에서만 embedding 한 번
   - 그 embedding은 retrieval에 재사용
   - embeddings unavailable 시 lexical/fallback behavior 명확화

4. Revision-aware residency/delta

   - resident identity: `(fact_id, semantic_generation, lifecycle_generation)`
   - candidates를 latest active revision으로 normalize
   - project/workspace/workstream scope filter
   - same revision duplicate suppression
   - same fact new generation은 correction/delta
   - inactive/superseded exclusion
   - old epoch residency 재사용 금지

5. Memory Bundle

   section:
   - WORK NOW
   - CURRENT TRUTH
   - WATCH
   - TRACE

   정책:
   - WORK NOW: resume/compact/substantive task
   - CURRENT TRUTH: relevant 2~4 facts
   - WATCH: current signature와 verified incident match일 때
   - TRACE: explicit why/history/source intent일 때
   - Hot Evidence는 NOT YET DISTILLED label
   - assistant context-only lane은 current truth보다 아래

6. Context budget/ranking

   기본:
   - normal target 300~700 chars, soft 1,000
   - resume/compact target 1,000~1,500, hard 2,000

   요구:
   - deterministic ranking/truncation
   - section priority
   - source duplication 제거
   - excessive relation expansion 제거
   - hard cap 초과 금지
   - runtime additionalContext spill/limit contract와 정합성

7. Correction semantics

   - old statement가 더 이상 valid하지 않음을 명시
   - current fact와 scope/workspace 상태를 구분
   - 필요한 grounded reason만 포함
   - entire Chronicle 매번 주입 금지
   - new generation은 same epoch에도 correction 가능
   - next compact carry에서 stale revision 제거

8. Intent-gated graph/Chronicle expansion

   relation/graph/Chronicle expansion은 다음에서만 기본 활성:
   - why/rationale
   - related decision
   - dependency
   - contradiction
   - source/history

   routine continuation에서 기본 1-hop expansion을 하지 않는다.

9. WATCH

   - Phase 4의 verified incident match API 사용
   - source-linked independent episodes만
   - current error/prompt signature와 match할 때만
   - warning fatigue를 줄이기 위한 bounded ranking/TTL
   - warning precision metric
   - assistant similarity만으로 WATCH 생성 금지

10. Assistant repeat behavior

    - 과거 assistant answer 무조건 자동 주입 제거/강등
    - current facts/Chronicle/Hot Evidence보다 우선 금지
    - 필요하면 source-linked context-only hint 또는 MCP 안내
    - stale answer와 current fact 충돌 test

11. MCP deep path 회귀 방지

    자동 injection에 없는 다음을 MCP로 계속 탐색:
    - fact
    - raw evidence
    - source
    - full Chronicle
    - prior session/workstream
    - contradiction
    - incident pattern

    explicit source/history 질문에서 current fact만 반환하고 끝내지 않는다.
    자동 gate skip이 MCP completeness에 영향을 주지 않는다.

12. Metrics

    최소:
    - retrieval_gate_skip_count/reason
    - retrieval_execute_count/trigger
    - embedding call/cache hit
    - candidate/current/delta/injected fact counts
    - section별 injected chars/tokens
    - compact/resume bundle size
    - correction count/delay
    - WATCH emission/precision
    - project revision invalidation
    - repeated context turns
    - duplicate tool calls
    - time to first correct action
    - MCP trace success
    - worker/extraction token/latency/retry/dead

    실제 실행과 metric count가 일치해야 한다.
    unverified ROI를 fact로 저장하지 않는다.

13. Calibration workloads

    최소 workload:
    - follow-up-heavy
    - ack-heavy
    - frequent topic shift
    - explicit history/source questions
    - same fact multiple changes
    - compaction-heavy 200 turns
    - same project same/different workstreams
    - workspace state divergence
    - incident recurrence
    - retrieval/embedding/cache failure
    - no embeddings fallback
    - large MCP history

14. Product A/B

    비교 가능하면:
    A. plugin 없음
    B. pre-continuity Memex
    C. current final system

    측정:
    - background re-explanation turns
    - first correct tool action turns
    - duplicate file/tool/test work
    - stale/wrong-scope injection
    - retrieval calls per 100 prompts
    - injected chars/tokens per 100 prompts
    - known incident warning precision
    - MCP source/history success

    환경상 A/B를 자동화할 수 없으면 reproducible harness와 manual protocol을 남긴다.

15. Tests

    최소:

    a. ack/continue → embedding/retrieval 0
    b. short explicit memory question → retrieval
    c. first prompt in epoch
    d. Capsule generation change
    e. project memory revision stale
    f. topic drift
    g. low resident coverage
    h. safety refresh
    i. compact first prompt
    j. same revision duplicate block
    k. same fact new generation correction
    l. inactive fact exclusion
    m. workspace/workstream scope
    n. normal/compact hard budget
    o. deterministic ranking/truncation
    p. graph expansion intent gate
    q. WATCH verified match
    r. false WATCH from assistant similarity 차단
    s. stale assistant answer current fact 우선
    t. embeddings unavailable fallback
    u. retrieval service/cache failure
    v. MCP source/history unaffected
    w. metrics exactness
    x. synthetic 100~200 turn workload
    y. existing entire test suite

구현하지 말 것:

- per-prompt LLM gate/classifier
- every prompt embedding
- all facts rehydrate
- all Chronicle history inject
- personalized ranking mega-system
- external vector DB
- MCP replacement
- unverified ROI
- Final RFC modification

문서 갱신:

- gate decision table
- topic/coherency algorithm
- residency/delta/correction contract
- Memory Bundle section policy
- budgets/ranking/truncation
- WATCH/TRACE/graph intent rules
- assistant fallback policy
- MCP vs automatic injection
- metrics and benchmark baseline/after
- traceability/deviations

완료 응답:

1. 구현 요약
2. cheap gate flow와 실제 skip behavior
3. delta/correction/Memory Bundle
4. WATCH/TRACE/assistant/MCP 역할
5. metrics와 calibration 결과
6. tests 결과
7. known false-positive/false-negative risks
8. Prompt 5B 집중 위험
```

---

# Prompt 5B — Phase 5 독립 검증·수정·완료 게이트

```text
Phase 5 — Adaptive Recall & Product Calibration의 독립 완료 게이트를 수행하라.

Final RFC와 current repository가 기준이다.
이전 worker의 benchmark 수치와 주장을 그대로 믿지 말고 instrumentation과 reproducible workload로 재측정한다.
발견한 miss, stale injection, unnecessary retrieval, authority/scope contamination을 직접 수정한다.

핵심 검증:

1. cheap gate가 모든 expensive retrieval보다 먼저인가
2. skip path embedding/vector/graph/model call이 0인가
3. important short prompt false negative가 없는가
4. first epoch/Capsule/project revision/topic drift/safety refresh trigger가 동작하는가
5. resident identity가 revision-aware한가
6. same fact new generation correction이 정확한가
7. inactive/stale/wrong-workspace revision이 제외되는가
8. Memory Bundle section과 hard budget이 deterministic한가
9. WATCH가 verified incident match에만 근거하는가
10. graph/Chronicle expansion이 intent-gated인가
11. stale assistant answer가 current truth를 덮지 않는가
12. MCP source/history/other session path가 유지되는가
13. metrics가 실제 calls/bytes와 일치하는가
14. 비용 감소가 recall/scope correctness 저하를 가리지 않는가

필수 workload:

- ack-heavy
- follow-up-heavy
- topic-shift-heavy
- explicit why/source/history
- same fact evolution/rollback/correction
- 200-turn compaction-heavy
- same project same/different workstreams
- feature/main divergent truth
- incident recurrence/no recurrence
- embeddings unavailable
- retrieval/cache failure
- large MCP timeline

평가 지표:

- heavy retrieval rate
- gate false-negative/false-positive
- relevant current fact recall
- stale fact injection
- wrong-workstream/workspace injection
- duplicate injection
- correction delay
- injected chars/tokens
- compact bundle size
- hook latency
- WATCH precision
- MCP trace success

초기 target은 절대 PASS 조건이 아니다.
실측상 threshold를 조정하면 recall과 비용을 함께 근거로 deviation을 기록한다.
Retrieval rate를 낮추려고 중요한 memory를 누락하는 변경은 금지한다.

PASS 조건:

- no-op path expensive calls 0
- mandatory memory intents recall
- compaction/multi-session continuity 유지
- stale/wrong-scope injection 0 in covered matrix
- correction correct
- hard budget 준수
- WATCH authority safe
- MCP deep path 유지
- metrics verified
- reproducible workload와 전체 test 통과
- skipped/placeholder test 없음

생성/갱신:

- phase-5-handoff.md
- traceability-matrix.md
- rfc-deviations.md
- reproducible benchmark/result artifact

응답 첫 줄:

`PHASE 5 GATE: PASS`
`PHASE 5 GATE: CONDITIONAL`
`PHASE 5 GATE: BLOCKED`

handoff 필수:

- gate/revision/RFC SHA
- gate rules/thresholds/config
- baseline/after metrics
- recall/scope quality
- budgets/correction/WATCH
- MCP compatibility
- defects/debt
- final integration blockers
```

---

# Prompt F1 — 최종 통합·적대적 검증·수정 게이트

```text
Memex Continuity Architecture v1 Final RFC의 모든 Phase를 하나의 시스템으로 최종 통합 검증하라.

착수 전 조건:

- Phase 1~5 gate가 모두 PASS
- RFC SHA 일치
- 최신 handoff와 traceability matrix 존재

하나라도 PASS가 아니면 해당 Phase blocker를 먼저 복구하고 handoff를 갱신한다.
이번 작업은 새 기능을 추가하는 단계가 아니다.
Phase 사이 경계에서 생기는 race, data loss, stale state, scope contamination, authority confusion, migration/sync/privacy 회귀를 찾아 직접 수정해 release candidate를 만든다.

이전 PASS도 맹신하지 말고 end-to-end로 재검증한다.

최종 invariant:

CAPTURE
- checkpoint journal prefix durable/hash verifiable

ACCOUNTABILITY
- every captured authoritative range has durable state

MONOTONIC INGESTION
- older prefix cannot delete/regress newer exchange

EXACT EXTRACTION
- cursor passed only input actually seen

NO SAMPLING LOSS
- unprocessed budget suffix remains pending/retry/dead-visible

OPEN TURN
- growing exchange not prematurely complete; generation reprocess

AUTHORITY
- assistant/recall/compact summary/Capsule are non-authoritative

CAPSULE TYPING
- verified progress vs hypothesis/blocker separated

CURRENT VS HISTORY
- current fact and Chronicle remain distinct/consistent

GROUNDED CAUSE
- no evidence-free authoritative cause

TEMPORAL ORDER
- effective order independent of worker recorded order

RESIDENCY
- old epoch injection does not imply current residency

REVISION-AWARE INJECTION
- new semantic/lifecycle generation becomes delta/correction

SCOPE
- project/workspace/workstream/session isolation

BRANCH TRUTH
- unmerged state not promoted to project-wide current state

OUTBOX
- checkpoint and job atomic

RECOVERY
- pending/retry/dead/stale lease recoverable

HOOK BOUNDARY
- capture hooks wait for no model/embedding/consolidation/full sync

POSTCOMPACT INDEPENDENCE
- zero PostCompact events still correct

MCP ACCESS
- source/history/other session memory discoverable

PRIVACY
- purged memory cannot resurrect

NO SILENT LOSS
- failed/skipped range never disguised as complete

필수 end-to-end 시나리오:

1. Long session
   - 200 turns
   - 6 auto, 2 manual compactions
   - same-turn double compaction
   - multiple Interrupt
   - topic changes
   - SessionEnd

2. Crash injection
   - journal append 전/후
   - fsync 후 DB transaction 전
   - checkpoint+outbox commit 후 wake 전
   - index 중
   - Capsule model 중/commit 전후
   - fact extraction model 중/commit 전후
   - Chronicle transaction 전후
   - consolidation 중
   - sync export/import 중
   - privacy purge 중

3. Duplicate/out-of-order
   - CP2 before CP1
   - duplicate Stop/PreCompact/SessionEnd
   - no PostCompact
   - stale lease completion
   - duplicate sync/event
   - old fact/Capsule generation after new

4. Multi-session/workspace
   - same project same workstream A/C
   - same project different workstream B
   - multiple worktrees
   - cross-device explicit links
   - ambiguous same-remote clones
   - project link/split
   - latest unrelated session

5. Branch truth
   - feature Redis/main MySQL
   - decision target vs actual state
   - merge/validation promotion
   - rollback

6. Chronicle
   - assert/change/validate/incident/contradict
   - evolution then rollback
   - missing cause
   - effective vs recorded order
   - repeated incidents/remediation

7. Context/retrieval
   - pre-compact injection
   - compact summary loses fact
   - immediate rehydrate
   - same fact new generation correction
   - ack gate skip
   - topic shift
   - explicit source/history
   - WATCH match
   - MCP deep trace

8. Privacy/security
   - purge raw journal/checkpoint/exchange/fact/Capsule/event/vector/cache/sync
   - pending worker resurrection attempt
   - malformed payload/path
   - transcript replacement
   - path/source leakage

9. Migration/upgrade
   - released DB fixture → latest
   - interrupted/repeated migration
   - path→project/workspace migration
   - older sync peer
   - hook install/setup/upgrade/uninstall idempotency

필수 결과:

- unaccounted closed exchanges = 0
- checkpoint prefix hash mismatch = 0
- cursor overrun = 0
- silent skipped pages = 0
- duplicate authoritative Chronicle event = 0
- cross-project injection = 0
- wrong-workstream injection = 0
- unmerged project-current promotion = 0
- purged memory resurrection = 0
- compact rehydration miss = 0
- stale fact correction failure = 0
- ungrounded cause authoritative = 0
- PostCompact dependency failure = 0

성능/운영:

- hook latency distribution
- journal growth/retention
- DB size/index health
- worker backlog/retry/dead-letter
- Capsule/fact/Chronicle priority behavior
- retrieval/injection baseline
- MCP pagination/latency
- 200-turn total processing behavior

문제 발견 시:

- 보고만 하지 말고 수정한다.
- contract가 바뀌면 관련 phase handoff, as-built docs, traceability, deviation을 갱신한다.
- 새 architecture를 발명하지 않는다.
- Final RFC invariant 안에서 가장 단순한 수정으로 해결한다.
- 관련 없는 feature를 추가하지 않는다.

생성:

- final-integration-gate.md
- updated traceability-matrix.md
- updated rfc-deviations.md
- reproducible test/benchmark artifacts

최종 status:

`FINAL INTEGRATION GATE: PASS`
`FINAL INTEGRATION GATE: CONDITIONAL`
`FINAL INTEGRATION GATE: BLOCKED`

PASS는 모든 mandatory invariant와 end-to-end test가 충족될 때만 선언한다.
환경 때문에 검증하지 못한 mandatory 항목이 있으면 CONDITIONAL/BLOCKED다.
```

---

# Prompt F2 — 최종 문서화·운영 준비·릴리스 인수인계

```text
`FINAL INTEGRATION GATE: PASS`인 Memex Continuity Architecture v1 구현을 release closure 상태로 정리하라.

이번 작업은 기능 추가가 아니다.
새 requirement/architecture를 도입하지 말고, 실제 구현이 설치·upgrade·운영·진단·purge·rollback 가능한지 마무리한다.
Final RFC는 수정하지 않는다. 실제 구현 설명은 as-built 문서와 deviation record에 남긴다.

필수 작업:

1. Final RFC lock 확인
   - repository copy와 rfc-lock SHA 일치
   - 이전 초안이 current 규범처럼 링크되지 않게 정리
   - Final RFC와 as-built docs 구분

2. As-built architecture
   - actual lifecycle/event contract
   - journal/checkpoint/outbox/worker
   - extraction cursor/generation/closure
   - Work Capsule/tail baton
   - project/workspace/workstream/session
   - current facts/subject/Chronicle
   - context epoch/residency/Memory Broker
   - automatic injection vs MCP
   - sync/privacy

3. Operations
   - clean install/hook trust/registration
   - existing install upgrade
   - worker start/recovery
   - backlog/retry/dead-letter 확인
   - journal/checkpoint integrity 확인
   - capture gap 진단
   - project/workspace link/split
   - workstream rebind
   - Capsule/current fact/Chronicle 진단
   - MCP source/history 조회
   - privacy purge
   - rollback

4. Compatibility
   - supported Codex/runtime/plugin versions
   - verified hook contract
   - OS/path/worktree constraints
   - DB/schema migrations
   - sync protocol/legacy peer
   - feature flags/defaults
   - optional PostCompact status

5. Code cleanup
   - obsolete lifecycle paths
   - duplicate hook scripts
   - dead migration helper/temp compatibility shim
   - TODO/FIXME/disabled tests
   - old assistant repeat injection conflict
   - error/diagnostics consistency
   - no secrets/path leaks in hook output

6. Release artifacts
   - changelog/release notes
   - migration notes
   - rollback notes
   - final test matrix
   - benchmark summary
   - known limitations
   - RFC deviations/decisions

7. Final smoke
   - clean install
   - upgrade install
   - hook setup idempotency
   - normal session
   - compact session without PostCompact
   - multi-session/worktree
   - branch truth
   - Chronicle/MCP trace
   - adaptive gate
   - privacy purge
   - entire test suite

8. Change management
   - 관련 없는 사용자 변경 제외
   - logical commits로 정리 가능
   - push/tag/publish/release는 사용자 승인 없이 수행하지 않는다.
   - 대신 권장 commit sequence, version bump, tag/release commands를 보고한다.

최종 생성/갱신:

- final-handoff.md
- as-built architecture docs
- operations/install/upgrade/rollback docs
- changelog/release notes
- final traceability-matrix.md
- final rfc-deviations.md

final-handoff 필수:

- final status
- repository revision/working tree
- RFC SHA
- schema/protocol/plugin versions
- invariant PASS table
- all tests/benchmarks
- install/upgrade/rollback
- runtime contract
- diagnostics/operations
- known limitations
- non-blocking future ideas와 명확한 비범위
- final deviation list
- publish 전 사용자 checklist

최종 응답 첫 줄:

`MEMEX CONTINUITY ARCHITECTURE V1: IMPLEMENTATION COMPLETE`

위 문구는 모든 mandatory gate가 PASS일 때만 사용한다.
그렇지 않으면 COMPLETE를 선언하지 말고 정확한 blocker를 남긴다.
```

---

# 작업 중단·새 Worker 인수인계용 재개 프롬프트

```text
Memex Continuity Architecture v1 Final RFC 작업을 현재 repository 상태에서 재개하라.

첨부/참조:

- Final RFC
- rfc-lock.json
- 가장 최근 phase handoff/gate
- traceability-matrix.md
- rfc-deviations.md

이전 worker 대화 요약이나 완료 주장보다 다음을 우선한다.

1. current git HEAD/branch/working tree
2. Final RFC SHA-256
3. actual schema/migration state
4. durable checkpoint/job/cursor/lease state
5. reproducible tests

먼저:

- 관련 없는 사용자 변경을 보존한다.
- RFC SHA가 일치하는지 확인한다.
- 가장 최근 gate status를 확인한다.
- PASS되지 않은 동일 Phase만 재개한다.
- 다음 Phase로 건너뛰지 않는다.

중단 상태 감사:

- migration이 절반 적용됐는가
- journal fsync와 DB boundary가 일치하는가
- orphan checkpoint/job/capture_gap이 있는가
- extraction cursor와 target이 일치하는가
- stale worker lease가 있는가
- Capsule/fact/Chronicle generation이 충돌하는가
- purge tombstone보다 오래된 job이 남았는가
- 신규/수정 test가 실제로 통과하는가

계획만 보고 멈추지 말고, 현재 Phase의 남은 구현·수정·test·handoff 갱신까지 수행한다.
완료 판정은 해당 Phase의 B 게이트 기준을 그대로 적용한다.
Final RFC를 수정하지 않는다.
```

---

# Gate 실패 복구용 짧은 프롬프트

```text
가장 최근 Memex Continuity gate가 PASS가 아니다.
Final RFC, rfc-lock, 해당 Phase A/B prompt, latest handoff를 기준으로 blocker를 직접 수정하라.

다음 Phase 기능은 구현하지 않는다.
관련 없는 변경은 보존한다.
RFC invariant를 약화해 테스트를 통과시키지 않는다.

수정 후 mandatory test와 전체 regression을 다시 실행하고,
동일 Phase handoff와 traceability/deviation을 갱신하라.
응답 첫 줄은 해당 Phase의 공식 GATE status 형식을 사용하라.
```
