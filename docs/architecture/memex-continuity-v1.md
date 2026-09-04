# Memex Continuity Architecture v1 — Final RFC

> **상태:** FINAL / 구현 목표 고정본  
> **버전:** 1.0  
> **작성 기준일:** 2026-09-03  
> **대상:** `BongSuCHOI/memex`  
> **효력:** 이 문서는 이전의 두 장문 설계 초안을 대체한다. 구현 중 목표를 바꾸지 말고, 불가피한 차이는 별도의 RFC deviation record에 남긴다.

---

# 0. 최종 결정

Memex의 최종 제품 정의는 다음과 같다.

> **Memex는 대화를 매번 요약하는 팩트 저장소가 아니라, 세션·컴팩션·재개·병렬 작업의 경계에서도 현재 작업을 정확히 이어가고, 지금의 진실과 그 진실이 형성된 이유를 구분해 제공하는 로컬 우선 작업 연속성 커널이다.**

이를 한 줄의 동작 원칙으로 줄이면 다음과 같다.

> **원본은 잃지 않고, 작업 상태는 작게 이어주며, 현재 사실은 정확하게 유지하고, 중요한 변화의 이유는 요청할 때만 꺼낸다.**

최종 구조는 네 종류의 기억을 분리한다.

```text
Raw Evidence & Checkpoints
        ↓ source of truth
Work Capsule
        ↓ current work projection
Current Facts
        ↓ current truth projection
Chronicle / Heritage
        ↓ sparse causal history
```

그리고 세 가지 실행 면을 둔다.

```text
Capture Plane
    → 원본 delta, turn fence, compact checkpoint, final fence

Distillation Plane
    → Capsule → Facts → Chronicle → Classification/Consolidation

Memory Broker
    → 시작·재개·컴팩션·사용자 prompt에 필요한 delta만 공급
       + MCP deep exploration 유지
```

고정해야 할 핵심 결정은 다음과 같다.

1. **Capture hook에서는 LLM, embedding, consolidation, full sync를 기다리지 않는다.**
2. **모든 완료 turn은 `Stop`에서 저비용 durable fence를 남긴다.**
3. **`Interrupt`는 열린 turn의 부분 증거를 보존하되 완료 처리하지 않는다.**
4. **`PreCompact`는 잃기 전 checkpoint이고, `SessionStart(compact)`는 즉시 복원 지점이다.**
5. **`PostCompact`는 선택적 telemetry/diagnostics일 뿐 correctness 의존성이 아니다.**
6. **Work Capsule을 fact extraction보다 먼저 갱신한다.**
7. **비용 budget은 처리를 미룰 수 있지만 처리하지 않은 범위를 완료로 만들 수 없다.**
8. **주입 dedup은 fact ID가 아니라 revision과 `context_epoch`을 기준으로 한다.**
9. **현재 사실과 중요한 변화의 Chronicle을 분리한다.**
10. **프로젝트·워크스페이스·워크스트림·세션을 구분한다.**
11. **자동 주입은 작은 working-memory path, MCP는 source/history 탐색용 deep-memory path다.**
12. **측정되지 않은 원인·성과·비용 절감은 authoritative memory로 저장하지 않는다.**

아래 Phase들은 서로 다른 1차안·2차안이 아니다. **처음부터 이 최종 목적지를 고정하고, 검증 가능한 의존 순서대로 구현 면적만 확장하는 단계**다.

---

# 1. 규범과 용어

이 문서에서 다음 표현은 규범적 의미를 갖는다.

- **MUST / 반드시:** 위반하면 아키텍처 invariant 또는 완료 게이트를 깨는 요구사항
- **SHOULD / 권장:** 특별한 근거가 없다면 따라야 하는 기본값
- **MAY / 선택:** 제품 또는 runtime 검증에 따라 추가할 수 있으나 correctness가 의존해서는 안 되는 요소

핵심 용어는 다음과 같다.

| 용어 | 의미 |
|---|---|
| Evidence | 사용자 발언, 신뢰된 repo/git/test/tool 결과 등 원본 근거 |
| Checkpoint | 특정 transcript prefix/segment를 가리키는 durable 처리 경계 |
| Work Capsule | 현재 작업의 목표·진행·blocker·다음 행동을 담는 bounded projection |
| Current Fact | 현재 유효하다고 판단된 프로젝트의 materialized truth |
| Chronicle | 중요한 사실 변화·결정·incident·검증의 source-linked 인과 계보 |
| Context epoch | 컴팩션·clear 등으로 모델 context residency 가정이 무효화되는 세대 |
| Memory revision | 프로젝트 current memory가 의미 있게 바뀌었음을 나타내는 invalidation token |
| Resident revision | 현재 context에 들어갔다고 추적하는 `(fact_id, semantic_generation, lifecycle_generation)` |
| Memory Bundle | Capsule, 관련 current facts, WATCH, TRACE를 조합한 bounded context block |
| Hot Evidence | 아직 fact로 증류되지 않았지만 최근 세션에서 포착된 authoritative raw evidence |
| Failed-visible | 처리에 실패했으나 정확한 범위와 원인이 durable하게 남아 있는 상태 |

---

# 2. 참조 기준과 현재 상태의 취급

이 RFC는 2026-09-03 기준 공개 `main`과 Codex Hooks 문서를 참조해 작성했다. 당시 공개 구조에서는 다음이 관찰됐다.

- lifecycle 등록은 `SessionStart`, `UserPromptSubmit`, `SessionEnd` 세 이벤트 중심이다.
- fact context injection은 `UserPromptSubmit` 경로에 있다.
- 빈 `SessionStart` matcher 때문에 `compact`에도 startup용 async 작업이 매칭될 수 있다.
- 긴 extraction은 spread window 선택과 session-level fact cap의 영향을 받는다.
- incremental extraction query에는 고정 upper fence가 없는 경로가 존재한다.
- project scope와 최근 세션 continuity가 경로 및 latest-session 중심으로 동작한다.

그러나 이 목록은 **현재 상태에 대한 참조 관찰**이지 최종 규범이 아니다. Worker는 반드시 Phase 0에서 실제 repository revision과 설치된 Codex runtime을 재감사해야 한다.

우선순위는 다음과 같다.

```text
최종 목표와 invariant
    > 실제 runtime에서 검증된 contract
    > 현재 repository 구현 상태
    > 이 문서의 예시 파일명·테이블명·수치
```

즉 현재 코드가 달라졌다면 코드를 정확히 기록하되 목표 invariant를 축소하지 않는다. 파일명과 schema 이름은 조정할 수 있지만, 조정 이유와 정합성은 deviation record에 남긴다.

---

# 3. 냉정한 제품 판단

## 3.1 Heritage는 과하지 않다

다음은 가치 있는 Chronicle/heritage다.

- MySQL에서 Redis로 전환한 사실
- 전환을 촉발한 row lock, connection pool, cleanup 비용 등의 근거
- 변경 이후 검증된 성능·안정성 결과
- rollback과 그 이유
- 여러 세션에서 반복된 동일한 실패 패턴
- checklist나 자동화 도입 후 측정된 재발 감소
- memory reuse로 감소한 retrieval 호출·주입 토큰·중복 조사량

이는 ADR, provenance, incident/postmortem, temporal knowledge, design rationale를 선택적으로 결합한 것이다.

## 3.2 모든 대화의 서사화는 과설계다

다음은 저장하지 않는다.

- 매 turn 생성하는 “프로젝트 철학의 진화” 서사
- evidence 없이 모델이 추정한 변경 이유
- 모든 파일 수정에 대한 Chronicle event
- 동일 오류 메시지의 반복 출력
- assistant 설명을 authoritative history로 승격
- 측정하지 않은 개발 시간·비용 절감 수치
- 모든 프로젝트 경험의 자동 global 승격

최종 원칙은 다음이다.

```text
현재 진실은 작게 유지한다.
중요한 변화만 source-linked Chronicle로 남긴다.
전체 원본은 checkpoint에서 다시 찾을 수 있다.
```

---

# 4. 네 층의 기억

## 4.1 Raw Evidence & Checkpoints — 실제로 무슨 일이 있었는가

여기에는 다음이 들어간다.

- human prompt
- 신뢰된 local tool output
- repository, git, test evidence
- transcript 위치, byte/line boundary, checksum
- session, turn, exchange provenance
- compaction 직전 journal prefix
- source authority와 parser version

Evidence는 append-only에 가깝게 다룬다.

```text
Current Fact가 수정됨
≠
그 사실을 만들었던 과거 Evidence가 사라짐
```

정상적인 삭제 경로는 명시적 privacy purge뿐이다. Derived projection이 틀렸거나 오래돼도 원본은 재처리할 수 있어야 한다.

## 4.2 Work Capsule — 지금 무엇을 하고 있는가

Long-range continuity의 핵심은 fact보다 Capsule이다. 장기 작업에서 먼저 유실되는 것은 대개 다음이다.

- 현재 objective
- 어디까지 검증했는가
- 어떤 접근이 실패했는가
- 현재 blocker
- 열린 질문
- 다음 행동
- 최근 touched area

권장 logical shape는 다음과 같다.

```json
{
  "workstream_id": "ws-...",
  "generation": 17,
  "objective": "세션 저장소를 MySQL 기반 구현에서 Redis로 이전",
  "current_state": "dual-write 완료, read failover 검증 중",
  "verified_progress": [
    {
      "text": "단위 테스트 148개 통과",
      "source_exchange_ids": ["ex-abc"]
    }
  ],
  "hypotheses": [
    {
      "text": "TTL 누락이 flaky test 원인일 가능성",
      "source_exchange_ids": ["ex-def"]
    }
  ],
  "blockers": [
    "reconnect 이후 세션 소실 재현"
  ],
  "open_questions": [
    "Redis failover 시 write acknowledgement 정책"
  ],
  "next_actions": [
    "failover integration test 재현",
    "TTL 갱신 경로 확인"
  ],
  "touched_areas": [
    "src/session/",
    "tests/session-failover.test.ts"
  ],
  "carry_fact_revisions": [
    ["fact-1", 4, 2]
  ],
  "through_checkpoint_id": "cp-...",
  "updated_at": "..."
}
```

Capsule 규칙:

1. **Capsule은 context-only projection이며 fact evidence가 아니다.**
2. `verified_progress`에는 사용자 진술 또는 신뢰된 repo/git/test/tool evidence만 들어간다.
3. assistant 추정은 `hypotheses`로 분리한다.
4. source checkpoint/exchange를 추적한다.
5. 매 turn LLM summary로 재생성하지 않는다.
6. compaction, SessionEnd, 또는 bounded segment가 쌓였을 때 갱신한다.
7. 같은 workstream의 materialization은 generation CAS와 partition serialization을 사용한다.
8. 배열별 개수와 전체 크기를 제한한다. 권장 target은 800~1,500자다.
9. 새 Capsule이 current projection을 대체하되 과거 원본은 checkpoint로 추적한다.
10. stale Capsule은 current fact나 authoritative tool result보다 우선할 수 없다.

### Deterministic tail baton

Capsule worker가 아직 완료되지 않았어도 continuity가 완전히 사라지면 안 된다. 다음을 조합한 fallback을 LLM 없이 만들 수 있다.

```text
latest substantive user request
+ last completed plan item
+ recent touched files
+ last trusted test status
+ latest unresolved error
```

이 “tail baton”은 Capsule이 준비되기 전 임시 context일 뿐, fact나 Chronicle source가 아니다.

## 4.3 Current Facts — 지금 무엇이 사실인가

Current Fact는 빠른 retrieval을 위한 materialized projection이다.

```text
subject_key = state.runtime.session_store
value       = Redis
status      = active
semantic_generation  = 4
lifecycle_generation = 2
project_id  = P-123
```

일반 질문은 Chronicle 전체를 replay하지 않고 Current Facts를 본다. 현재 Memex의 semantic/lifecycle/lineage/derived overlay 분리와 generation/CAS 철학은 유지한다.

Current Fact는 다음을 구분해야 한다.

```text
decision.runtime.session_store.target = Redis
state.main.runtime.session_store      = MySQL
```

“Redis로 가기로 결정했다”와 “main의 현재 구현이 Redis다”는 같은 사실이 아니다.

## 4.4 Chronicle / Heritage — 어떻게, 왜 이렇게 되었는가

Chronicle은 모든 로그가 아니라 **의미 있는 상태 전환과 검증된 incident**의 append-only 계보다.

최소 event kind는 다음 정도면 충분하다.

```text
ASSERTED
CHANGED
RETIRED
RESTORED
VALIDATED
INCIDENT
CONTRADICTED
```

기존 revision 또는 consolidation 타입과 mapping할 수 있다. 완전히 별도의 중복 history system을 만들 필요는 없다.

권장 event shape:

```text
event_id
project_id
subject_key
fact_id                     nullable
event_kind

from_semantic_generation    nullable
to_semantic_generation      nullable
previous_value               nullable
new_value                    nullable

problem                      nullable
grounded_cause               nullable
rationale                    nullable
classifier_note              nullable
outcome_json                 nullable

source_exchange_ids
source_evidence_ids
reverts_event_id             nullable
related_event_ids            nullable

actor                        extractor | consolidator | user | sync
policy_version
effective_at
recorded_at
created_at
```

`effective_at`과 `recorded_at`을 구분한다.

```text
effective_at = 실제 결정·변경·incident가 발생한 시점
recorded_at  = Memex worker가 그것을 처리한 시점
```

여러 worker의 완료 순서가 실제 역사 순서가 되어서는 안 된다.

Grounded cause 규칙:

```text
source evidence에 원인이 명시됨
    → grounded_cause 가능

모델이 문맥상 추정함
    → classifier_note만 가능

원인을 확인할 수 없음
    → grounded_cause = null
```

---

# 5. 전체 아키텍처

```text
┌────────────────────────────── Codex ────────────────────────────────┐
│ SessionStart │ UserPromptSubmit │ Stop │ Interrupt │ Compact │ End │
└───────────────────┬─────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────── Hook Gateway ──────────────────────────────┐
│ 1. payload/path/runtime validation                                 │
│ 2. project/workspace/workstream/session resolve                    │
│ 3. transcript delta → append-only journal                          │
│ 4. checkpoint + outbox atomic commit                               │
│ 5. 허용된 이벤트에서만 bounded additionalContext 반환              │
│                                                                    │
│ 금지: extraction, embedding build, consolidation, full sync wait   │
└────────────────────┬──────────────────────────────┬────────────────┘
                     │                              │
                     ▼                              ▼
┌────────────────────────────┐      ┌───────────────────────────────┐
│ Session Memory State       │      │ SQLite Durable Job Queue     │
│ context_epoch              │      │ capture/index/capsule/fact   │
│ resident revisions         │      │ chronicle/classify/sync      │
│ carry set                  │      │ lease/retry/dead-letter       │
│ capsule generation seen    │      │ partition + idempotency       │
│ project revision seen      │      └──────────────┬────────────────┘
└────────────────────────────┘                     │
                                                   ▼
                                  ┌───────────────────────────────┐
                                  │ Partitioned Memory Worker     │
                                  │ session capture/index 순차     │
                                  │ workstream Capsule 순차         │
                                  │ project fact/Chronicle 순차     │
                                  │ 다른 partition은 병렬           │
                                  └──────────────┬────────────────┘
                                                 │
       ┌──────────────────────┬──────────────────┼──────────────────┐
       ▼                      ▼                  ▼                  ▼
 Raw Evidence            Work Capsule       Current Facts       Chronicle
 immutable source        WIP projection     current truth       causal history
```

처리 우선순위는 다음이다.

```text
1. Capture durability
2. Work Capsule continuity
3. Current Fact extraction
4. Chronicle enrichment
5. Ontology classification / consolidation
```

컴팩션 직후에는 최신 Capsule과 현재 필요한 facts가 있으면 충분하다. 모든 Chronicle enrichment와 ontology가 끝날 때까지 기다리지 않는다.

---

# 6. 최종 Lifecycle 계약

## 6.1 이벤트별 역할

| 이벤트 | 동기적으로 수행 | Context 출력 | 동기 경로에서 금지 |
|---|---|---|---|
| `SessionStart(startup)` | project/workspace/session resolve, queue recovery signal, epoch 확인 | 보통 없음 또는 pinned invariants | full sync, extraction, consolidation |
| `SessionStart(resume)` | 기존 session→workstream 복원, projection freshness 확인 | Capsule + 작은 current bundle | 새 extraction 대기 |
| `SessionStart(clear)` | 새 epoch, old residency/carry 폐기 | pinned project constraints만 | 이전 workstream 전체 자동 복원 |
| `UserPromptSubmit` | workstream binding 보완, cheap gate, 필요 시 retrieval, delta residency | 관련 bundle delta | 매 prompt 무조건 embedding |
| `Stop` | journal delta, closed-turn fence, job coalesce | 없음 | extraction/embedding |
| `Interrupt` | journal delta, open/interrupted fence | 없음 | turn closed 처리 |
| `PreCompact` | journal fsync, immutable prefix checkpoint, carry candidate freeze, outbox | 없음 | extraction/embedding |
| `PostCompact` | 선택적 telemetry·진단·orphan marker | 없음 | correctness 핵심 전이 의존 |
| `SessionStart(compact)` | epoch ensure, carry/Capsule/current revision 즉시 복원 | bounded continuity context | 새 query 기반 full retrieval |
| `SessionEnd` | final delta, final fence, durable outbox | 없음 | stabilize 대기, foreground extraction/export |

## 6.2 `PostCompact`에 대한 최종 결정

최종 correctness 흐름은 다음만으로 성립해야 한다.

```text
PreCompact
    → durable checkpoint

SessionStart(compact)
    → compact 성공을 전제로 epoch ensure
    → immediate rehydration
```

`PostCompact`는 runtime에서 안정적으로 제공되고 운영상 가치가 확인되면 다음 용도로 MAY 사용할 수 있다.

- compact latency telemetry
- pre/post boundary 비교
- orphan checkpoint 진단 가속
- 상태 전이 observability

그러나 다음은 금지한다.

```text
PostCompact가 누락되면 epoch이 영구히 전이되지 않음
PostCompact가 누락되면 checkpoint job이 사라짐
PostCompact가 실패하면 compact rehydration 불가
```

`SessionStart(compact)`와 startup recovery가 모든 필수 전이를 idempotent하게 `ensure`해야 한다.

## 6.3 `Stop`

`Stop`은 장기 세션과 다중 세션 freshness를 위해 중요하다. `SessionEnd`는 conversation 전환 즉시 오지 않을 수 있으므로, 완료 turn마다 다음만 한다.

```text
append new complete transcript bytes
mark exchange/turn boundary closed
insert checkpoint + coalesced processing job
return valid JSON or no output according to runtime contract
```

`Stop`의 continuation 기능은 Memex capture에 필요하지 않다. Capture hook은 정상적으로 turn을 다시 시작하지 않도록 해야 한다.

## 6.4 `Interrupt`

`Interrupt`는 `Stop`과 capture implementation을 공유하되 closure만 다르다.

```text
Stop       → closed
Interrupt  → interrupted/open
```

짧은 timeout을 고려해 local append/transaction만 수행한다. 출력 contract를 위반하는 plain text를 내보내지 않는다.

## 6.5 `PreCompact`

수행할 일:

```text
append remaining complete delta
fsync journal
record byte/line boundary
record prefix hash
freeze previous epoch carry candidates
insert checkpoint + job atomically
return
```

Capture 실패 기본 정책:

```text
default:
    fail-open
    + durable capture_gap
    + visible system warning where contract permits
    + recovery attempt

strict_capture:
    durable capture 실패 시 compaction 중단 가능
```

설정 폭발을 피하기 위해 strict switch 하나 정도로 제한한다.

## 6.6 `SessionStart(compact)`

새 semantic query가 없으므로 일반 prompt retrieval을 그대로 호출하지 않는다. 다음을 조합한다.

```text
latest current Work Capsule
+ deterministic tail baton if Capsule is stale/missing
+ previous epoch carry candidates의 최신 active revisions
+ pinned constraints
+ recently changed correction facts
```

출력 예:

```text
[WORK NOW]
Objective: extraction cursor race 제거
State: migration 완료, property test 보강 중
Blocker: interrupted exchange closure 재현 필요
Next: fake clock 기반 crash test 추가

[CURRENT TRUTH]
- 처리 budget 소진은 completed가 아니라 pending이다.
- 같은 exchange가 성장하면 content generation이 증가한다.

[WATCH]
- 오래된 prefix가 newer generation을 덮는 회귀를 이전에 발견했다.
```

## 6.7 `SessionEnd`

`SessionEnd`는 finalizer가 아니라 final fence다.

```text
append final delta
record final boundary/checkpoint
ensure durable processing job
return within supported timeout
```

worker/export 완료를 기다리지 않는다.

## 6.8 Hook runtime 안전

- 여러 matching hooks는 동시에 실행될 수 있으므로 순서를 가정하지 않는다.
- transcript format은 안정된 public interface로 가정하지 않는다.
- payload와 path는 untrusted input처럼 검증한다.
- `session_id`, `turn_id`, `source`, `trigger`, `permission_mode`, `transcript_path`를 손실 없이 normalize한다.
- event별 stdout/JSON contract를 fixture로 고정한다.
- unified hook gateway를 우선하되, latency 또는 package 제약상 일부 fast path를 분리할 수 있다.
- background hook completion 순서와 session 종료 취소에 correctness가 의존해서는 안 된다.

---

# 7. Rolling Journal과 Checkpoint

## 7.1 전체 파일 반복 복사를 피한다

매 Stop/PreCompact마다 transcript 전체를 복사하면 세션 길이에 따라 I/O가 누적된다. Memex가 소유하는 append-only rolling shadow journal을 둔다.

```text
Codex transcript
      │ copied_byte_end 이후의 complete bytes만
      ▼
~/.memex/.../journals/<session_id>/<stream_epoch>.jsonl
```

Capture 절차:

1. 이전 `copied_byte_end`를 읽는다.
2. source file identity와 size를 검증한다.
3. 새로 늘어난 구간만 bounded read한다.
4. 마지막 complete newline까지만 append한다.
5. trailing partial line은 다음 capture까지 보류한다.
6. block hash chain과 copied boundary를 transactionally 기록한다.

```text
block_hash_N = sha256(block_hash_N-1 || newly_appended_bytes)
```

source transcript가 truncate, replace, rewind되면 기존 journal을 되감지 않는다.

```text
session S / stream_epoch 0
session S / stream_epoch 1  ← source replacement/truncation
```

## 7.2 Checkpoint는 파일이 아니라 처리 경계다

권장 logical schema:

```text
checkpoint_id
session_id
workspace_id              nullable during early migration
workstream_id             nullable
stream_epoch
ordinal
kind                      stop | interrupt | precompact | final
turn_id
from_byte
through_byte
from_line
through_line
segment_hash
prefix_hash
parser_version
closure_state
context_epoch_before
state
capture_gap_reason        nullable
created_at
```

ID는 prefix identity를 포함한다.

```text
checkpoint_id = sha256(
    session_id
  + stream_epoch
  + through_byte
  + prefix_hash
  + kind
)
```

효과:

- 동일 event 재전달 → 같은 ID, no-op 또는 동일 효과
- 같은 turn에서 prefix가 더 자란 뒤 다시 compact → 다른 checkpoint
- 오래된 checkpoint가 늦게 도착 → ordinal/generation guard로 regression 불가

## 7.3 모든 captured 범위는 상태를 가져야 한다

```text
captured
pending
processing
processed
retry
failed-visible / dead-letter
```

어떤 범위도 상태 없이 사라져서는 안 된다. `dead-letter`는 완료가 아니며 release gate에서 별도로 드러난다.

---

# 8. Extraction Correctness Spine

## 8.1 Fixed upper fence

Extraction 시작 시 target을 고정한다.

전환기 구현:

```text
from_rowid    = previous_processed_rowid
through_rowid = claim 시점의 고정 MAX(rowid)
```

```sql
SELECT ...
FROM exchanges
WHERE session_id = :session
  AND rowid > :from_rowid
  AND rowid <= :through_rowid
ORDER BY rowid;
```

성공 cursor도 정확히 `through_rowid` 또는 실제 처리된 contiguous page 끝까지만 전진한다. completion 시점의 live MAX를 다시 읽지 않는다.

최종형은 `exchange_seq`와 checkpoint의 `through_closed_exchange_seq`를 사용한다.

## 8.2 Contiguous durable pagination

Sampling은 scheduling에만 사용할 수 있다.

허용:

```text
한 worker invocation에서 최대 N개 window/page
```

금지:

```text
중간 window를 건너뛰고 마지막 target까지 완료 표시
```

정상 흐름:

```text
target 180
worker 1 → 121..140 → cursor 140
worker 2 → 141..160 → cursor 160
worker 3 → 161..180 → cursor 180
```

Fact cap도 session 완료 cap이 아니라 page/run budget으로 해석한다.

```text
MAX_FACTS_PER_RUN = 20
남은 range         = pending
```

## 8.3 Growing exchange와 closure

동일 user turn의 assistant/tool suffix가 커져도 rowid가 유지될 수 있다. 따라서 exchange에는 다음이 필요하다.

```text
exchange_id
session_id
exchange_seq
content_hash
content_generation
line_start
line_end
closure_state       open | interrupted | closed | final
updated_at
```

규칙:

```text
content_hash 또는 line_end가 변화
    → content_generation += 1
    → 새 generation pending
```

Extraction identity:

```text
(exchange_id, content_generation, extraction_policy_version)
```

stale worker가 이전 generation 결과를 최신 projection 위에 덮을 수 없다.

MVP 전환 중 generation이 아직 없다면 마지막 open exchange를 processed cursor에 포함하지 않는 방어를 사용할 수 있으나, 최종 완료 조건은 generation-aware 처리다.

## 8.4 Prefix ingestion과 canonical reconciliation 분리

```text
checkpoint/prefix ingestion
    = monotonic partial upsert only

canonical full archive/sync
    = desired-set reconciliation
```

DB/API invariant:

```text
incoming generation < stored generation → update 거부
incoming line_end < stored line_end       → update 거부
older prefix                             → newer exchange 삭제 금지
```

## 8.5 실패 처리

- transient provider failure → retry, cursor 미전진
- budget/rate limit → pending/retry
- oversized page → 더 작은 contiguous page로 분할 시도
- irreducible deterministic failure → 정확한 range와 payload fingerprint를 dead-letter로 기록, completed 아님
- claim loss → fact/current projection commit rollback
- stale generation result → discard 후 최신 generation 재평가

보장할 수 있는 것은 **모든 authoritative transcript 범위가 extractor에게 실제 제시되었는가**다. LLM이 모든 의미 있는 fact를 100% 찾는 semantic completeness는 별도 quality evaluation 대상이다.

---

# 9. Durable Queue와 Worker

외부 Redis, Kafka, Temporal은 추가하지 않는다. local-first 제품에는 SQLite transactional outbox와 lease가 충분하다.

```text
memory_jobs
────────────────────────────────────────
job_id
kind
partition_key
checkpoint_id             nullable
from_cursor               nullable
through_cursor            nullable
policy_version
priority

state                     pending | running | retry | completed | dead
available_at
lease_owner
lease_until
attempts
last_error
idempotency_key           UNIQUE
created_at
updated_at
```

Hook transaction:

```text
BEGIN
  INSERT checkpoint
  INSERT OR IGNORE memory_job
COMMIT
```

Worker partition:

```text
session partition
    journal ingest
    exchange indexing
    extraction cursor

workstream partition
    Capsule materialization

project partition
    Current Fact mutation
    Chronicle mutation
    consolidation

다른 partition
    병렬 처리 가능
```

우선순위:

```text
P0 capture recovery / gap
P1 Capsule continuity
P2 Current Fact extraction
P3 Chronicle enrichment
P4 ontology / relation / optional maintenance
```

동일 job이 여러 번 실행돼도 idempotency key와 generation/CAS로 효과는 한 번이어야 한다. lease가 만료된 stale owner는 completion을 commit할 수 없다.

---

# 10. Project · Workspace · Workstream · Session

## 10.1 네 ID를 분리한다

| ID | 의미 | 예시 |
|---|---|---|
| `project_id` | 논리 프로젝트 가족 | Memex |
| `workspace_id` | 실제 checkout/location | `/work/memex-feature` |
| `workstream_id` | 하나의 작업 목적 | Redis migration |
| `session_id` | Codex conversation | 현재 thread |

```text
project
 ├─ workspace A: main checkout
 │   ├─ workstream: Redis migration
 │   │   ├─ session 1
 │   │   └─ session 2
 │   └─ workstream: release hotfix
 │       └─ session 3
 └─ workspace B: feature worktree
     └─ workstream: Redis migration
         └─ session 4
```

## 10.2 Stable project registry

```text
projects
────────────────────────────
project_id UUID
portable_project_key nullable
display_name
memory_revision
created_at
updated_at
```

```text
workspaces
────────────────────────────
workspace_id UUID
project_id
device_id
canonical_path
git_common_dir
remote_fingerprint
location_kind      worktree | clone | directory
branch
last_seen_at
```

절대경로는 identity가 아니라 local provenance/location이다.

## 10.3 Project resolve 정책

권장 우선순위:

```text
1. explicit portable project UUID / approved link
2. 동일 local git common-dir
3. 이미 승인된 remote fingerprint mapping
4. canonical cwd fallback → 새 project/workspace
```

자동 병합 금지 근거:

```text
basename 동일
remote URL 동일
package name 동일
```

이 조건만으로는 fork, mirror, 실험 clone을 안전하게 구분할 수 없다.

정책:

```text
동일 git common-dir
    → 자동 link 가능

다른 clone/device
    → explicit link 또는 portable UUID

후보가 모호함
    → merge하지 않고 suggestion/pending mapping
```

## 10.4 Workstream binding

“가장 최근 세션”을 무조건 복원하면 병렬 작업에서 context poisoning이 생긴다.

binding 우선순위:

```text
1. resume된 기존 session_id
   → 정확한 기존 workstream

2. 명시적 workstream/task/branch binding
   → 지정 workstream

3. 같은 workspace/branch + 유일한 active workstream
   → 자동 연결 가능

4. prompt와 Capsule의 강한 topic match
   → 충분한 margin이 있을 때만

5. 모호함
   → 새 session-local workstream
```

브랜치는 hint이지 identity 자체가 아니다. 매 prompt LLM classifier를 사용하지 않는다.

## 10.5 Branch/workspace state promotion

feature worktree에서 Redis 구현이 끝났어도 main은 MySQL일 수 있다.

```text
미병합·실험 상태
    → Work Capsule

프로젝트 차원의 명시적 결정
    → decision fact

병합·검증된 구현 상태
    → current state fact
```

예:

```text
decision.runtime.session_store.target = Redis
state.main.runtime.session_store      = MySQL
workstream redis-migration            = Redis 구현 검증 중
```

처음부터 branch-scoped fact graph 전체를 만들지 않는다. 필요가 검증될 때만 확장한다.

---

# 11. Multi-session Freshness와 Memory Lanes

## 11.1 Durable Fact Lane

Worker가 추출·검증한 current facts. 기본 authoritative retrieval source다.

## 11.2 Hot Evidence Lane

`Stop`/checkpoint에서 deterministic하게 index된 최근 human/trusted-tool evidence다. sibling session의 최신 결정이 아직 fact로 증류되지 않았을 때 보완한다.

자동 context에 넣을 경우 반드시 표시한다.

```text
[RECENT EVIDENCE — NOT YET DISTILLED]
Session A의 trusted benchmark에서 P95 240ms가 기록됨.
```

Current Fact처럼 포맷하지 않는다.

## 11.3 Assistant Continuity Lane

이전 assistant output, compact summary, Capsule은 context-only다.

- 참고는 가능
- authoritative current fact로 자동 승격 금지
- fact extraction evidence로 재진입 금지
- current fact와 충돌하면 current fact 우선

과거 assistant answer를 자동 반복 주입하는 기능은 source-linked fallback 또는 MCP exploration으로 강등한다.

## 11.4 Revision invalidation

프로젝트의 semantic/lifecycle current state 또는 Chronicle의 relevant state가 바뀌면:

```text
projects.memory_revision += 1
```

Session은 다음을 가진다.

```text
memory_revision_seen
capsule_generation_seen
```

다른 session의 변경을 현재 context에 강제로 push하지 않는다.

```text
project.memory_revision > session.memory_revision_seen
    → 다음 UserPromptSubmit 또는 rehydrate에서 recall/correction 강제
```

이것은 cache invalidation 문제로 다룬다.

---

# 12. Memory Broker와 Context Injection

## 12.1 매 prompt hook과 매 prompt retrieval을 분리한다

최종 원칙:

> **`UserPromptSubmit` hook은 매번 실행될 수 있지만, 비싼 embedding/retrieval은 필요할 때만 실행한다.**

SessionStart 한 번만 주입하면 topic shift, sibling session update, explicit history question, incident match를 처리할 수 없다. 반대로 매 substantive prompt에 embedding을 수행하면 continuation에서 낭비가 크다.

## 12.2 Session memory state

```text
session_memory_state
─────────────────────────────────────────
session_id
project_id
workspace_id
workstream_id
context_epoch
capsule_generation_seen
memory_revision_seen
topic_fingerprint
resident_fact_revisions_json
resident_bundle_hash
informative_prompts_since_retrieval
last_retrieval_at
updated_at
```

Resident identity:

```text
(fact_id, semantic_generation, lifecycle_generation)
```

같은 fact ID의 새 generation은 새로운 context delta다.

## 12.3 Cheap gate

Embedding/vector search보다 먼저 실행한다.

Recall trigger:

```text
first substantive prompt in epoch
OR context_epoch changed
OR capsule generation changed
OR project memory_revision changed
OR explicit memory/history/source intent
OR significant topic drift
OR resident lexical coverage insufficient
OR known failure signature matched
OR high-impact decision/change intent
OR safety refresh interval reached
```

기본 skip 후보:

```text
"고마워"
"계속해"
"응"
직전 turn을 명확히 잇는 짧은 확인/수정
```

단순 길이만으로 중요한 짧은 질문을 버리지 않는다.

Topic drift 1차 신호는 정규화 token set, Jaccard, SimHash/Hamming 등 cheap lexical fingerprint를 사용할 수 있다.

```text
명확한 skip/retrieve
    → embedding 0

애매함
    → embedding 한 번
       같은 embedding을 retrieval에 재사용
```

## 12.4 Delta-only injection

```text
candidate facts
    ↓ latest active revision normalize
scope/project/workstream filter
    ↓
resident revision 비교
    ↓
new revision/correction만 emit
```

동일 revision 반복 주입을 막되 새 generation은 suppress하지 않는다.

## 12.5 Memory Bundle

권장 section:

```text
[WORK NOW]
Objective / State / Blocker / Next

[CURRENT TRUTH]
현재 prompt에 필요한 2~4개 fact

[WATCH]
현재 failure signature와 실제 매칭된 과거 incident

[TRACE]
왜/이전/변경 이유 intent가 있을 때 history 존재 안내
```

항상 네 section을 모두 넣지 않는다.

| Section | 기본 정책 |
|---|---|
| WORK NOW | resume, compact, substantive task prompt |
| CURRENT TRUTH | 관련 current facts만 |
| WATCH | verified incident signature match일 때만 |
| TRACE | explicit history/rationale intent일 때만 |

권장 budget:

```text
normal prompt delta
    target 300~700자
    soft limit 1,000자

resume / compact bundle
    target 1,000~1,500자
    hard limit 2,000자
```

수치는 runtime과 replay benchmark로 조정할 수 있지만 hard cap과 deterministic ranking/truncation을 둔다.

## 12.6 Correction semantics

Model context의 과거 문장을 물리적으로 삭제할 수 없으므로 수정 fact는 명시적으로 교정한다.

```text
[MEMEX CORRECTION]
- 이전 context의 “main은 Redis를 사용한다”는 정보는 더 이상 유효하지 않다.
- 현재 main 상태는 MySQL이며 Redis migration은 workstream 단계다.
- 근거: ...
```

다음 compaction에서는 stale revision을 carry하지 않는다.

## 12.7 Graph expansion

relation/graph 1-hop expansion은 기본값으로 매번 실행하지 않는다. 다음 intent에서만 켠다.

- 왜
- 관련 결정
- 의존성
- contradiction
- architecture trace

---

# 13. MCP Deep Memory Path

자동 injection은 전체 memory를 대신하지 않는다. MCP는 계속 다음을 탐색할 수 있어야 한다.

- 자동 주입에 없는 current fact
- raw conversation/evidence
- 특정 fact의 출처
- Chronicle timeline
- 이전 값과 rollback
- 다른 session/workstream의 기록
- contradiction
- repeated incident pattern
- 대량 history의 bounded pagination

역할 분리:

```text
Automatic injection
    = 작고 빠른 working-memory fast path

MCP search / trace
    = 필요할 때 파고드는 source/history deep path
```

기존 도구를 우선 확장한다.

```text
search / read
search_facts
trace_fact
explore_graph
```

불필요하게 `trace_chronicle`, `history_fact`, `why_fact`, `source_fact`처럼 도구를 폭증시키지 않는다. `trace_fact` 또는 가장 자연스러운 도구가 current fact → event → evidence를 연결하도록 확장한다.

MCP 결과에는 lane과 authority를 표시한다.

```text
CURRENT FACT
CHRONICLE EVENT
RAW EVIDENCE
ASSISTANT CONTEXT-ONLY
HOT EVIDENCE — NOT YET DISTILLED
```

자동 injection 최적화가 MCP 검색 완전성을 약화해서는 안 된다.

---

# 14. Work Capsule Distillation

## 14.1 Segment 기준

turn 수 하나로만 자르지 않는다. 초기 scheduling 예시는 다음이다.

```text
substantive exchanges 6~8개
OR new text 8~16KB
OR PreCompact
OR SessionEnd
```

핵심은 수치가 아니라 다음이다.

```text
segment는 짧고 contiguous하다.
처리되지 않은 suffix는 pending이다.
```

## 14.2 Capsule과 Fact extractor를 처음부터 합치지 않는다

초기 final implementation에서는 분리한다.

```text
Capsule distiller
    → objective/state/blocker/next projection

Fact extractor
    → strict authority/provenance pipeline
```

하나의 prompt에 작업 요약과 authoritative fact extraction을 섞으면 precision이 떨어질 수 있다. Benchmark에서 동일 segment를 한 호출로 처리해도 품질이 유지된다는 evidence가 생겼을 때만 합친다.

## 14.3 Capsule patch semantics

Worker는 whole history를 다시 요약하지 않고 이전 Capsule + 새 contiguous segment로 patch를 만든다. 그러나 projection drift를 막기 위해 주기적으로 raw checkpoints에서 rebuild 가능한 경로를 유지한다.

```text
previous capsule
+ segment evidence
→ typed patch
→ validation
→ generation CAS
→ new capsule projection
```

`verified_progress`, `hypotheses`, `blockers`의 타입 혼합은 validation error로 취급한다.

---

# 15. Chronicle 상세 정책

## 15.1 Event 생성 조건

생성:

```text
Current Fact의 의미가 실제로 변함
사용자가 rationale을 포함해 결정을 명시함
trusted test/log가 validation 또는 incident를 증명함
구현/결정이 rollback됨
독립된 failure episode가 반복됨
```

미생성:

```text
동일 fact의 재표현
formatting 차이
assistant 추측
단순 파일 open/edit
같은 오류의 연속 재출력
분류 모델의 단독 의견
```

## 15.2 MySQL → Redis 예

```text
Current Fact
subject_key = state.runtime.session_store
value       = Redis
```

```json
{
  "event_kind": "CHANGED",
  "subject_key": "state.runtime.session_store",
  "previous_value": "MySQL",
  "new_value": "Redis",
  "problem": "burst traffic의 row lock contention",
  "grounded_cause": "session write P95가 허용치를 초과",
  "rationale": "ephemeral workload를 relational DB에서 분리",
  "outcome": {
    "load_test": "passed",
    "failover_test": "passed"
  },
  "effective_at": "2026-08-14T10:20:00Z",
  "recorded_at": "2026-08-14T10:24:12Z",
  "source_exchange_ids": ["ex-123", "ex-128"]
}
```

일반 prompt:

```text
현재 runtime session store는 Redis다.
```

History prompt/MCP:

```text
이전에는 MySQL이었으며 burst traffic의 row lock contention과 P95 초과가 근거가 되어 Redis로 전환했다. 관련 load/failover 검증 기록이 있다.
```

## 15.3 Rollback

Rollback도 과거 event를 삭제하지 않는다.

```text
CHANGED MySQL → Redis
CHANGED Redis → MySQL
reverts_event_id = first_change
```

Current projection은 MySQL이지만 Chronicle에는 시도와 되돌림이 모두 남는다.

## 15.4 반복 실수와 Incident Pattern

반복 실수는 단순 fact보다 incident episodes와 warning rule에 가깝다.

```text
incident signature
    redis reconnect + missing TTL refresh

episodes
    2026-07-02 integration failure
    2026-08-14 failover failure

validated remediation
    reconnect callback에서 TTL 재설정
```

자동 pattern 승격:

```text
사용자가 반복이라고 명시
OR 서로 독립적인 authoritative episode 2개 이상
```

같은 turn/session/root-cause의 retry는 하나로 coalesce한다. 이후 재발이 없다는 이유만으로 resolved를 추정하지 않는다. trusted test 또는 명시적 확인이 있어야 한다.

WATCH는 signature가 현재 prompt/error와 매칭될 때만 주입한다.

## 15.5 비용 절감

비용 절감은 측정된 outcome일 때만 Chronicle/report에 연결한다.

측정 가능:

```text
semantic_retrieval_calls
retrieval_gate_skip_count
injected_chars / estimated_tokens
duplicate_tool_calls
repeated_context_turns
time_to_first_correct_action
incident_recurrence_rate
warning_precision
worker/extraction tokens
```

금지:

```text
"개발 시간을 12시간 절약했다"
"비용이 크게 줄었다"
```

baseline과 sample이 없으면 authoritative outcome이 아니다.

---

# 16. Concurrency와 Temporal Semantics

복잡한 CRDT 대신 세 종류의 serialization과 CAS를 사용한다.

```text
동일 session checkpoint/index/extraction
    → session partition ordinal 순서

동일 workstream Capsule update
    → workstream partition + generation CAS

동일 project/subject current fact·Chronicle
    → project/subject partition + semantic/lifecycle CAS
```

다른 project/workstream은 병렬 처리한다.

동일 `subject_key`에 충돌하는 evidence가 오면 worker completion 순서로 last-write-wins 하지 않는다.

판정 입력:

- source authority
- effective_at
- current semantic/lifecycle generation
- workspace/workstream 상태
- merge/validation 상태
- contradiction evidence

모호하면 current fact를 강제로 변경하지 않고 contradiction candidate로 보존한다.

---

# 17. 최소 데이터 모델

최종 logical entities:

```text
projects
workspaces
workstreams
sessions
session_memory_state
session_journals / journal_streams
checkpoints
memory_jobs
work_capsules
fact_events / extended fact_revisions
incident_occurrences
capture_gaps
```

기존 entities 확장:

```text
exchanges
  + exchange_seq
  + content_hash
  + content_generation
  + closure_state
  + parser_version

facts
  + project_id
  + subject_key
  + optional verified workspace/workstream provenance

recall_events
  + context_epoch
  + capsule_generation
  + project_memory_revision
  + fact_semantic_generation
  + fact_lifecycle_generation
  + retrieval_gate_reason
  + injected_section

fact_revisions / fact_events
  + event_kind
  + subject_key
  + grounded_cause
  + classifier_note
  + outcome_json
  + source evidence IDs
  + effective_at
  + recorded_at
  + reverts_event_id

extraction progress
  → exact target, contiguous cursor, policy version, failed ranges
```

`resident revisions`는 bounded state이므로 compact JSON 또는 작은 normalized table 중 현재 코드에 자연스러운 방식을 선택할 수 있다.

---

# 18. Repository 변경 지도

실제 파일명은 Phase 0 감사 후 조정할 수 있다.

| 영역 | 최종 책임 |
|---|---|
| lifecycle config | matcher별 SessionStart, Stop, Interrupt, PreCompact, optional PostCompact, End |
| lifecycle registration | event-specific matcher/timeout/context limit/contract |
| hook input normalization | source, trigger, turn_id, permission mode, path validation |
| unified hook gateway | capture, state ensure, bounded context dispatch |
| journal module | incremental append, partial line, stream epoch, hash chain |
| checkpoint store | content-addressed ID, state machine, capture gaps |
| durable job queue | outbox, lease, retry, dead-letter, partition |
| transcript parser | versioned parser, exchange generation/closure |
| archive ingestion | monotonic prefix ingest vs canonical reconcile |
| fact extractor | fixed target, contiguous pagination, exact cursor |
| capsule distiller | typed patch, source validation, CAS, tail baton |
| project registry | stable project/workspace mappings, link/split |
| workstream binding | conservative deterministic binding |
| injection core | cheap gate, bundle, revision-aware delta/correction |
| fact management | subject key, current projection, Chronicle event |
| MCP | current→history→evidence trace, pagination |
| sync | stable project/event IDs, local path exclusion, CAS conflict |
| privacy purge | journal/checkpoint/capsule/event/cache/sync cascade |
| tests/benchmarks | lifecycle, crash, scope, heritage, product A/B |

Hook binary를 이벤트마다 무한히 늘리기보다 공통 gateway를 우선한다. 다만 `UserPromptSubmit` fast path는 latency 때문에 별도 daemon path를 유지할 수 있다.

---

# 19. 반드시 고정할 Invariant

```text
CAPTURE
모든 checkpoint가 가리키는 journal prefix는 durable하고 hash 검증 가능하다.

ACCOUNTABILITY
모든 captured authoritative range는 pending/processing/processed/retry/dead-visible 중 하나다.

MONOTONIC INGESTION
오래된 prefix는 최신 exchange를 삭제하거나 content generation을 되돌릴 수 없다.

EXACT EXTRACTION
Cursor가 통과한 exchange/page는 실제 extractor input에 포함됐다.

NO SAMPLING LOSS
Budget 때문에 처리하지 못한 범위는 pending이지 completed가 아니다.

OPEN TURN
성장 가능한 exchange는 closed cursor에 포함되지 않거나 generation으로 재처리된다.

AUTHORITY
Assistant, recall, compact summary, Capsule은 authoritative fact evidence가 아니다.

CAPSULE TYPING
Verified progress, hypothesis, blocker를 서로 다른 authority/type으로 유지한다.

CURRENT VS HISTORY
Current Fact와 Chronicle event를 혼동하거나 한쪽으로 덮어쓰지 않는다.

GROUNDED CAUSE
Evidence가 없는 변경 원인을 authoritative history로 저장하지 않는다.

TEMPORAL ORDER
Worker recorded order가 실제 effective order를 대체하지 않는다.

RESIDENCY
과거 epoch에 주입됐다는 사실은 현재 context에 존재함을 의미하지 않는다.

REVISION-AWARE INJECTION
같은 fact ID라도 semantic/lifecycle generation이 바뀌면 새 delta/correction이다.

SCOPE
Project, workspace, workstream, session의 경계를 지키고 모호하면 merge보다 분리를 택한다.

BRANCH TRUTH
미병합 workstream 상태를 project-wide current state로 자동 승격하지 않는다.

OUTBOX
Checkpoint commit과 processing job 생성은 원자적이다.

RECOVERY
미처리 범위와 stale lease는 restart 후 재식별 가능하다.

HOOK BOUNDARY
Capture lifecycle hook은 LLM/embedding/consolidation/full sync를 기다리지 않는다.

POSTCOMPACT INDEPENDENCE
PostCompact가 없어도 capture, epoch, rehydration correctness가 성립한다.

MCP ACCESS
자동 주입에 없는 source/history/other-session memory는 MCP로 탐색 가능하다.

PRIVACY
Purge된 source가 worker/sync/cache에 의해 부활하지 않는다.

NO SILENT LOSS
실패·skipped·dead range를 정상 완료로 위장하지 않는다.
```

이 invariant가 아키텍처의 헌법이다. 최적화가 하나라도 깨면 받아들이지 않는다.

---

# 20. 실패·경계 상황 처리

| 상황 | 처리 |
|---|---|
| 같은 turn에서 auto compact 두 번 | prefix boundary/hash가 달라 별도 checkpoint |
| 동일 Stop/PreCompact 재전달 | 동일 idempotency key, no-op 또는 동일 효과 |
| PostCompact 누락 | SessionStart(compact)/startup recovery가 ensure |
| PreCompact capture 실패 | capture_gap + warning + recovery; strict mode만 block |
| journal fsync 후 DB crash | recovery가 journal tail과 DB boundary 재조정 |
| checkpoint commit 후 wake crash | durable pending job을 startup worker가 발견 |
| CP2 후 CP1 도착 | monotonic generation/line guard로 regression 금지 |
| exchange가 compact 후 성장 | content generation 증가, 새 pending generation |
| worker가 LLM 중 죽음 | lease expiry 후 같은 page 재처리 |
| budget/rate limit | cursor 유지, retry/pending |
| deterministic unprocessable page | split 후에도 불가하면 exact dead-letter, complete 아님 |
| sibling session fact 변경 | memory_revision invalidation, 다음 경계 correction |
| clear | 새 epoch, old carry 폐기, pinned constraints만 |
| 동일 repo 여러 worktree | common project, distinct workspace/workstream |
| 같은 remote의 모호한 clones | explicit link 전까지 분리 |
| feature Redis / main MySQL | decision과 main state 분리, workstream 상태는 Capsule |
| assistant answer와 current fact 충돌 | current fact 우선, assistant context-only |
| evidence 없는 change reason | grounded cause null, classifier note 분리 |
| purge 중 pending job | tombstone/version check로 재생성 차단 |

---

# 21. Acceptance Tests

## 21.1 상태 머신·Property 테스트

- 동일 checkpoint 10회 중복 전달
- 각 DB write 직후 crash injection
- lease expiry 후 reclaim
- stale owner의 늦은 completion
- extraction 중 concurrent insert/update
- 같은 turn에서 두 번 compact
- prefix out-of-order delivery
- migration 중단 후 재실행

Invariant:

```text
processed cursor는 뒤로 가지 않는다.
실제로 처리하지 않은 범위를 건너뛰지 않는다.
오래된 prefix가 최신 상태를 덮지 않는다.
모든 captured segment는 accounted 상태다.
```

## 21.2 Long-session

```text
200 turns
6 auto compactions
2 manual compactions
same-turn double compaction
multiple Interrupt
SessionEnd
worker crash/restart
```

필수 결과:

```text
unaccounted closed exchanges = 0
checkpoint prefix hash mismatch = 0
cursor overrun = 0
silent skipped pages = 0
compact rehydration miss = 0
```

## 21.3 Multi-session / Multi-workspace

| 시나리오 | 기대 결과 |
|---|---|
| 같은 project, 같은 workstream A/C | 검증된 Capsule/current state 공유 |
| 같은 project, 다른 workstream B | blocker/next action 혼입 0 |
| 서로 다른 project | fact/context leakage 0 |
| 여러 worktree | same logical project, distinct workspace |
| 다른 clone, 같은 remote | explicit link 전까지 분리 |
| feature Redis, main MySQL | main에 Redis current state 주입 금지 |
| sibling fact evolution | stale session 다음 경계 correction |

## 21.4 Chronicle

- MySQL → Redis change
- Redis → MySQL rollback
- contradiction
- missing cause evidence
- effective_at과 recorded_at 역순 처리
- 동일 incident retry coalescing
- 독립 episode 2개 pattern 승격
- verified remediation 후 resolution
- duplicate sync event

## 21.5 Context / MCP

- old epoch fact가 compact summary에서 탈락
- `SessionStart(compact)` immediate rehydration
- same fact new generation correction
- inactive revision carry 차단
- explicit “왜/출처/이전 기록” query
- MCP current→event→evidence trace
- large history pagination
- assistant/capsule contamination attempt

## 21.6 Privacy / Security

- journal, checkpoint, exchange, fact, event, Capsule, vector/cache, sync artifact purge
- pending worker가 purged source를 재생성하지 못함
- path traversal 및 malformed hook payload
- unexpected transcript replacement
- source path leakage 점검

## 21.7 제품 효과 A/B

비교:

```text
A: plugin 없음
B: 기존 Memex
C: Continuity Architecture v1
```

측정:

- resume/compact 후 사용자가 배경을 다시 설명한 turn 수
- 첫 올바른 tool action까지 turn 수
- 중복 파일 탐색·테스트 실행 수
- stale fact injection
- wrong-workstream injection
- prompt 100개당 semantic retrieval 호출
- prompt 100개당 injected chars/tokens
- WATCH precision
- source/history MCP 성공률

초기 engineering target은 reference일 뿐 실제 CI machine에서 calibration한다.

```text
no-op prompt path embedding calls = 0
capture hooks model calls          = 0
compact rehydrate new extraction   = 0
cross-project leakage              = 0
wrong-workstream leakage           = 0
silent skipped segment             = 0
```

---

# 22. 구현 순서 — 고정된 최종 목표에 도달하는 5개 Phase

## Phase 0 — Baseline & RFC Lock

- 실제 git revision, working tree, runtime contract 감사
- 최종 RFC를 repository에 고정하고 checksum 기록
- lifecycle/data/schema 흐름 추적
- invariant traceability matrix 작성
- baseline tests/benchmarks

## Phase 1 — Correctness Spine

- fixed extraction upper fence
- contiguous durable pagination
- exchange generation/closure
- monotonic prefix ingestion
- exact failed-range accounting
- SQLite job/outbox/lease 기반
- crash/out-of-order/property tests

**이 단계에서 stable project identity migration을 하지 않는다.** 먼저 범위 누락과 cursor correctness를 격리해 검증한다.

## Phase 2 — Continuity Core

- append-only rolling journal
- Stop / Interrupt / PreCompact capture
- SessionStart(compact) immediate rehydration
- optional PostCompact telemetry only
- SessionEnd final fence
- context epoch / revision-aware residency
- minimal workstream state
- Work Capsule distiller + deterministic tail baton
- Capture → Capsule 우선 worker scheduling

이 단계에서는 기존 path scope를 compatibility key로 유지할 수 있다.

## Phase 3 — Multi-session & Workspace Identity

- stable logical project ID
- workspace mapping과 location provenance
- worktree auto-link, explicit clone/device link/split
- conservative workstream binding
- branch/workspace state promotion policy
- subject key 기반 current slots의 기초
- project memory revision / Capsule generation invalidation
- Hot Evidence lane
- sync/privacy scope migration

## Phase 4 — Chronicle & Deep Memory Exploration

- sparse fact/Chronicle events
- subject key 완성
- grounded cause vs classifier note
- effective_at / recorded_at
- rollback, validation, incident, contradiction
- repeated incident pattern과 WATCH source
- MCP current→history→evidence trace
- Chronicle sync/privacy
- measured outcome telemetry

## Phase 5 — Adaptive Recall & Product Calibration

- pre-retrieval cheap gate
- lexical topic/coherency signals
- embedding reuse on ambiguous path
- revision-aware delta/correction
- Memory Bundle sections와 budgets
- intent-gated graph/TRACE/WATCH
- stale assistant repeat downgrade
- MCP deep path 회귀 검증
- A/B workload와 threshold calibration

## Final Integration & Release Closure

- 모든 Phase 경계 end-to-end crash/race 테스트
- clean install/upgrade/rollback
- hook setup idempotency
- final traceability와 as-built 문서
- release notes와 known limitations

---

# 23. 하지 않을 것

| 하지 않을 것 | 이유 |
|---|---|
| 매 turn LLM summary | 비용·projection drift·자기 요약 증폭 |
| capture hook의 모델 호출 | latency와 경계 실패 위험 |
| 매 prompt full embedding retrieval | continuation 대부분에서 낭비 |
| 모든 history 기본 주입 | current truth를 흐림 |
| 모든 fact 재표현을 Chronicle event로 저장 | event noise 폭증 |
| latest session 무조건 복원 | 병렬 workstream contamination |
| basename/remote만으로 project auto-merge | clone/fork leakage |
| 미병합 branch state를 project current fact로 승격 | main truth 오염 |
| full event-sourced database | 복잡도 대비 이익 작음 |
| 처음부터 CRDT | partition serialization + CAS로 충분 |
| 외부 broker/vector DB 추가 | local-first 운영 복잡도 증가 |
| assistant answer를 authoritative evidence로 사용 | stale/wrong answer 증폭 |
| 자동 global knowledge promotion | cross-project contamination |
| 미측정 ROI fact | 신뢰 훼손 |
| 거대한 task/issue manager | Workstream의 목적을 벗어남 |
| PostCompact 필수 의존 | runtime 누락/실패가 continuity를 깨뜨림 |

---

# 24. 최종 제품 경험

```text
새 세션을 열었다
    → 올바른 workstream을 찾거나 모호하면 분리한다.
    → 무엇을 하던 중인지 Capsule로 이어받는다.

컴팩션이 일어났다
    → PreCompact에서 원본 prefix가 durable하다.
    → 같은 turn의 다음 model request부터 Capsule과 필요한 current facts가 복구된다.

다른 세션이 프로젝트를 변경했다
    → memory revision이 바뀐다.
    → 다음 자연스러운 경계에서 delta/correction이 들어온다.

"왜 Redis로 바꿨지?"
    → Current Fact만 반복하지 않는다.
    → MCP/TRACE가 Chronicle과 evidence를 보여준다.

같은 failover 오류가 다시 발생했다
    → source가 검증된 관련 incident만 WATCH로 알려준다.

"계속해줘"
    → 불필요한 embedding과 중복 fact injection을 하지 않는다.

worker가 죽었다
    → 어떤 range가 처리됐고 남았는지 durable 상태로 재개한다.
```

Memex의 차별점은 “모든 것을 기억한다”가 아니다.

> **Memex는 지금 필요한 작업 상태를 잃지 않고, 현재 진실과 과거 진실, 근거와 추측, 프로젝트와 워크스트림을 서로 혼동하지 않는다.**

---

# 참고 링크

- Memex repository: https://github.com/BongSuCHOI/memex
- Codex Hooks: https://developers.openai.com/codex/hooks
- Git glossary / worktree concepts: https://git-scm.com/docs/gitglossary
- Event Sourcing: https://martinfowler.com/eaaDev/EventSourcing.html
- CQRS: https://martinfowler.com/bliki/CQRS.html

> 구현 worker는 이 링크를 그대로 신뢰하지 말고 Phase 0에서 현재 revision과 runtime behavior를 다시 검증한다.
