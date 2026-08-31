# 검증과 릴리스 게이트

## 1. 판정 규칙

- `PASS` — 현재 artifact에서 직접 관측하거나 충분한 자동 검증이 통과함
- `FAIL` — 요구와 반대되는 결과를 관측함
- `NOT_PROVEN` — 필요한 환경·권한·상태가 없어 아직 증명하지 못함
- `PASS-WITH-NOTES` — 기능은 통과했지만 version/environment boundary를 함께 기록해야 함

필수 항목에 FAIL이 하나라도 있으면 merge gate는 FAIL입니다. 관측하지 않은 동작을 추정으로 PASS 처리하지 않습니다.

## 2. 기본 gate

현재 repository의 최소 merge gate:

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
node --test test/*slice.test.mjs
node scripts/install-e2e.mjs
node scripts/marketplace-e2e.mjs
node scripts/package-runtime-e2e.mjs
node scripts/lifecycle-e2e.mjs
```

변경 범위에 따라 plugin validation, browser E2E, benchmark, specialized regression suite를 추가합니다.

## 3. Acceptance map

| 영역 | 최소 증거 |
| --- | --- |
| rollout ingestion | main/resumed/subagent/tool/malformed/worker fixture |
| project isolation | archive, DB, search, MCP, graph, sync에서 동일 canonical scope |
| extraction | retry/claim/no-new-row/atomic watermark |
| context dependency | server mapping, atomic save, consolidation union, edit/sync clear, privacy/FK cascade |
| extraction quality | 17-case curated fixture, baseline diff, FP/MISS taxonomy, model call/token/latency |
| fact mutation | semantic/lifecycle generation과 derived-state CAS |
| sync v4 | generation integrity, strict schema, semantic/lifecycle/lineage convergence |
| privacy | conversation purge, terminal tombstone, taxonomy epoch/in-flight race |
| retrieval | scope-before-limit, recall provenance, dedup/budget |
| MCP | initialize, 9 tools, schema/handler parity |
| installer/package | isolated install, idempotence, removal, packaged runtime |
| lifecycle | SessionStart/UserPromptSubmit/SessionEnd + cleanup |
| UI | empty/populated/mutation/security/accessibility |
| data integrity | FK check, vector/parent consistency, repair behavior |

## 4. Merge-gate receipt 절차

`docs/verification/merge-gate.json`은 **어떤 committed tree를 실제로 검증했는지** 기록하는 raw evidence입니다.

권장 순서:

```text
1. runtime/test/docs 수정 commit
2. working tree clean 확인
3. 그 committed SHA에서 전체 gate 실행
4. merge-gate.json의 candidate.codeSha에 정확한 SHA 기록
5. 관측값으로 receipt 갱신
6. receipt-only commit
```

receipt-only commit 뒤에는 runtime, tests, generated artifacts, scripts, owner docs를 변경하지 않습니다. 이후 코드가 바뀌면 기존 receipt는 현재 merge evidence가 아닙니다.

## 5. 현재 검증 baseline

최신 검증 baseline의 commit과 관측 결과는
`docs/verification/merge-gate.json` 하나를 기준으로 확인합니다. owner document에 특정
commit SHA나 package byte 수를 복제하면 다음 receipt에서 즉시 stale해지므로 여기에는
고정하지 않습니다.

receipt에서 확인할 필드:

| Gate | Result |
| --- | --- |
| code baseline | `candidate.codeSha` |
| 실행 시각·환경 | `recordedAt`, `environment` |
| gate 결과·관측값 | `gates[]` |
| 감사 closure | `reauditClosures` |

receipt는 기록된 code SHA에만 유효하며 future commit에 자동으로 상속되지 않습니다.

## 6. 이번 baseline에서 검증된 주요 회귀 경계

- remote semantic winner와 lifecycle winner의 독립 fold
- fresh insert의 lineage union/max
- replicated lifecycle event time 보존
- same-state newer lifecycle clock 수렴
- lifecycle commit-time LWW 재검증
- consolidation semantic + lifecycle dual CAS
- commit-time provenance union/max
- taxonomy epoch vs in-flight privacy purge
- purge 후 ontology attempt reset
- translation semantic CAS와 batch cardinality/type validation
- export serialization의 SQLite `BEGIN IMMEDIATE` 전환
- generation hash/count/schema fail-closed

## 7. Raw receipts

`docs/verification/`에는 machine-generated 또는 machine-observed artifact가 들어갑니다.

대표 파일:

- `merge-gate.json` — 최신 merge gate candidate와 관측 결과
- `benchmark.json` — 특정 benchmark run
- `plugin-validation.json` — plugin/install validation artifact
- `fact-extraction-baseline.json` — synthetic curated fixture에 대한 특정 model/prompt baseline

파일이 존재한다고 현재성까지 보장되는 것은 아닙니다. candidate SHA와 실행 시점을 항상 확인하십시오.

## 8. Version/environment boundary

latest merge-gate receipt는 다음 환경을 기록합니다.

```text
Codex CLI 0.150.1
Node v26.7.0
darwin arm64
```

host-specific behavior는 Codex version이 바뀌면 재검증합니다. repository-owned `scripts/validate-plugin.mjs`는 Memex의 validation harness이며, Codex가 제공하는 formal validator와 동일한 것으로 표현하지 않습니다.

실제 Codex CLI를 사용하는 translation script 전체 run처럼 사용자 data/model 호출이 필요한 검증은 별도 실행 증거가 없으면 `NOT_PROVEN`으로 남겨야 합니다. SQL/CAS regression test가 통과했다는 사실과 실제 external/model invocation이 관측됐다는 주장은 구분합니다.

fact extraction baseline도 같은 원칙을 적용합니다. committed
`fact-extraction-baseline.json`은 synthetic fixture run의 raw evidence이며 future extractor의
품질을 자동 보증하지 않습니다. `source.sha256`, `model`, `created_at`, `run_context`를
확인하고 다음 명령으로 동일 fixture의 새 report를 비교합니다.

```bash
npm run eval:fact-extraction -- \
  --baseline docs/verification/fact-extraction-baseline.json
```

실제 archive shadow evaluation은 user conversation을 model에 전송하므로 명시적 승인을
받은 run만 수행합니다. report는 private-derived artifact로 취급해 ignored local path에
보관하고, repository에는 aggregate 관측과 `PASS`/`FAIL`/`NOT_PROVEN` 판정만 기록합니다.

Phase 1/2 grounding 및 Phase 3 semantic-window contract의 최소 회귀 표면은 다음을 포함합니다.

- assistant/recall 본문이 JSON envelope의 context-only field에는 존재
- assistant/recall/external evidence 선언은 server-side hard reject
- trusted tool 선언은 실제 DB `tool_name/source_type/learnable/is_error`와 일치해야 통과
- inferred candidate는 서로 다른 authoritative exchange 2개 이상 필요
- accepted `source_exchange_ids`에는 validated human/tool exchange UUID만 존재
- recall 영향을 받은 assistant text는 conversation FTS에서 계속 검색 가능
- short ratification은 candidate anchor이며 immediate raw neighbor와 같은 model window에 존재
- pure social/bridge reply는 context eligible이지만 단독 model call을 유발하지 않음
- transport artifact는 raw-adjacency run을 끊고, window는 최대 5 exchanges로 bounded
- overlapping window의 duplicate fact는 normalized text로 합쳐지고 authoritative lineage는 union
- `MEMEX_MAX_EXTRACT_CALLS`는 semantic window 생성 후 적용되며 claim/retry/watermark 계약은 유지
- watermark suffix가 있으면 직전 1개 prefix가 `context_only_due_to_watermark`로만 보임
- prefix 단독은 anchor/model call을 만들지 않고 prefix human/tool evidence 선언은 hard reject
- boundary ratification은 prefix assistant referent를 보되 persisted lineage는 신규 human UUID만 포함
- prefix 도입 후에도 no-new-row/claim/retry와 completion watermark 원자 commit 계약이 유지
- `precision-durability-v1`의 grounding→durability→category/scope→confidence gate가 prompt에 존재
- inferred는 같은 결론의 독립 authoritative exchange 2개 이상을 요구하고 context 반복은 제외
- one-off request/action은 global에서 project로 강등 저장하지 않고 no-fact 처리
- current-state correction과 recall-backed new ratification은 새 human authority로 복구
- fact count 목표는 없으며 runtime maximum은 safety cap으로만 문서화

Phase 5의 동일 17-case Luna 비교는 fixture SHA를 유지한 채 17/17 PASS, matched 11/11,
precision/positive recall/negative accuracy/ratification/verified-local 100%, self-amplification
leakage 0, model call 17회를 관측했습니다. raw model report는 private-derived ignored artifact로만
보관합니다.

Phase 6 regression gate는 위 extraction 계약을 durable consumer와 retrieval surface까지 연결합니다.

- accepted candidate의 context index는 `source_exchange_ids`에 저장되지 않음
- overlap/consolidation/sync는 authoritative lineage만 set-union하고 count는 max로 수렴
- conversation exclusion purge는 authoritative source exchange에 연결된 fact와 derived state를 제거
- recall-influenced assistant의 고유 text가 FTS와 vector conversation search 양쪽에서 검색됨
- 검색된 row는 동시에 `assistant_learnable = 0`, `has_memex_recall = 1`을 유지
- eval report의 candidate acceptance/rejection reason은 배타적으로 집계되며 production DB에는 미저장
- grounding별 accepted count와 context-resolved human ratification count를 report에 기록

Optional Phase 7 persistent context dependency gate는 authority 의미를 유지한 채 audit/UI 소비처를
연결합니다.

- validated `context_exchange_indices`만 server가 실제 exchange UUID와 dependency kind로 매핑
- fact/context dependency/saved count/watermark가 한 extraction transaction에서 commit 또는 rollback
- overlap 및 DUPLICATE/CONTRADICTION/EVOLUTION survivor가 context dependency를 set-union
- manual semantic edit와 remote semantic replacement가 stale local context dependency를 제거
- conversation exclusion이 excluded context에 의존한 fact도 terminal tombstone과 함께 purge
- exchange canonical rename/delete와 fact hard delete 뒤 FK 정합성 유지
- protocol v4 payload에 context dependency 파일/field가 추가되지 않음
- Fact Detail과 `trace_fact`가 context를 non-authoritative로 명시
- real Chrome 1440×900 Fact Detail에서 context kind/ID/authority가 보이고 overflow/runtime error가 없음

동일 fixture SHA `f45b4f0a…5bcd6`의 최종 Luna run은 17/17 PASS, matched/observed
11/11, false positive/self-amplification leakage 0을 관측했습니다. Candidate/accepted는 11/11,
rejection 5종은 모두 0, accepted grounding은 explicit 8 / verified 2 / inferred 1,
context-resolved ratification은 5였습니다. Phase 0 baseline 대비 improvement 8, regression 0이며
raw report는 ignored `.fact-extraction-eval/`에만 보관합니다.

승인된 read-only archive shadow는 Phase 0과 같은 3 sessions / 38 exchanges에서 execution error
0, candidate/accepted 14/14를 관측했습니다. 로컬 수동 판정은 KEEP 12, cross-window semantic
duplicate `DROP-noise` 2, `WRONG-category`/`WRONG-scope`/`DROP-unsupported` 0,
unreferenced `MISS-important` at least 4 exchanges였습니다. Shadow report에는 expected label이
없으므로 자동 `precision=0`은 품질 지표가 아니며 수동 taxonomy가 판정 근거입니다. Model call은
12회, input/output token은 276,829/6,279, latency는 159.7s였습니다. 실행 전후 archive DB
SHA-256은 모두
`a476ec1c46b4dadf1cc3ce572f6b2adf06fdb58d7a5f4d8fc7fb7c6153e1d0bd`였습니다. Raw report와
대화 원문은 ignored private artifact이고 production backfill은 실행하지 않았습니다.

관련 좁은 gate:

```bash
npx vitest run \
  test/fact-extractor.test.ts \
  test/recall-provenance.test.ts \
  test/fact-extraction-eval.test.ts \
  test/extraction-claim-e2e.test.ts \
  test/extraction-session-retry.test.ts \
  test/session-end-worker-p0.test.ts
```

G/H 연결 gate:

```bash
npx vitest run \
  test/fact-extractor.test.ts \
  test/extraction-claim-e2e.test.ts \
  test/recall-provenance.test.ts \
  test/sync-exclusion-marker.test.ts \
  test/sync-export-import.test.ts \
  test/conversation-search-window.test.ts \
  test/fact-extraction-eval.test.ts
```

## 9. Release 원칙

`main`은 runtime source channel입니다. 따라서 merge 직전에는:

- known P1/P2 blocker가 없어야 함
- owner docs가 current behavior와 일치해야 함
- required gates가 clean committed SHA에서 통과해야 함
- receipt가 정확한 code SHA를 가리켜야 함

이 네 조건을 만족한 commit만 release-ready로 봅니다.
