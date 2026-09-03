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

## 9. Release 원칙

`main`은 runtime source channel입니다. 따라서 merge 직전에는:

- known P1/P2 blocker가 없어야 함
- owner docs가 current behavior와 일치해야 함
- required gates가 clean committed SHA에서 통과해야 함
- receipt가 정확한 code SHA를 가리켜야 함

이 네 조건을 만족한 commit만 release-ready로 봅니다.
