# 검증과 릴리스 게이트

## 1. 판정 규칙

- `PASS`: 현재 artifact에서 직접 관측하거나 충분한 자동 검증이 통과함
- `FAIL`: 요구와 반대되는 결과를 관측함
- `NOT_PROVEN`: 필요한 환경/권한/상태가 없어 증명하지 못함
- `PASS-WITH-NOTES`: 동작은 통과했으나 정확한 version boundary가 있음

필수 항목에 FAIL이 하나라도 있으면 전체 FAIL, FAIL 없이 NOT_PROVEN이 있으면 전체
NOT_PROVEN입니다. 숫자를 평균내어 불확실성을 덮지 않습니다.

## 2. 기본 기계 검증

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
node --test test/*slice.test.mjs
```

## 3. 배포/동작 검증

```bash
node scripts/validate-plugin.mjs
node scripts/install-e2e.mjs
node scripts/lifecycle-e2e.mjs --tier offline
node scripts/lifecycle-e2e.mjs --tier authenticated
node scripts/web-ui-browser-e2e.mjs
node scripts/benchmark.mjs --rollouts 200 --queries 30
```

각 E2E는 temp Codex home/data root/marketplace를 사용하고 다음 surface를 정리해야
합니다: plugin registry, owned hooks, temp data, workers, sockets, listeners, browser
profile/cache. 실제 사용자 `$CODEX_HOME`과 data root에 run marker가 유출되면 실패입니다.

## 4. Acceptance map

| 영역 | 최소 증거 |
| --- | --- |
| rollout ingestion | main/resumed/subagent/tool/malformed/worker/same-basename fixtures |
| scope isolation | archive, DB, analyze, MCP, graph traversal, import에서 A/B 분리 |
| extraction | real/fixture fact 저장, no-new-row no-op, retry/claim/atomic watermark |
| context injection | offline shape + authenticated model turn에서 nonce 관측 |
| MCP | installed wrapper initialize, 9-tool list, representative call, schema/handler parity |
| installer | dry-run no mutation, real, idempotent, failure rollback, installedPath use |
| Web UI | empty/populated, navigation/search/facts/provenance/graph/pipeline, rejection paths |
| performance | repeated raw samples, correctness assertions, p50/p95, child maxRSS |
| cleanup | 7 surfaces의 exact absence와 user-state isolation |
| verify/repair | outdated 상태 해소, 실제 exchange 재색인, file별 실패 집계, 실패 시 CLI non-zero, `PRAGMA foreign_key_check` 위반 검출과 파생 child orphan 제거 |

## 5. Version boundary

Codex CLI 0.149.1에는 `codex plugin validate` subcommand가 없습니다. 이 버전에서는
`scripts/validate-plugin.mjs`가 temp marketplace add, installed cache identity,
manifest/skill contract, dependency packaging, MCP initialize/list/call, UI assets, cleanup을
검사합니다. 이는 formal validator 통과가 아니라 version-bound substitute의
`PASS-WITH-NOTES`입니다. 향후 formal command가 생기면 substitute보다 먼저 실행합니다.

## 6. 보존된 machine receipts

`docs/verification/`의 JSON은 과거 또는 최신 성공 run의 raw artifact입니다.
관련 code/config가 변경되면 자동으로 현재성이 유지되지 않습니다.

- `benchmark.json`
- `plugin-validation.json`

릴리스 판정은 receipt 파일 존재가 아니라 현재 checkout에서 필요한 명령을 실행한 결과로
결정합니다.

## 7. 0.1.0 현재 체크아웃 검증 기록

2026-08-27(Asia/Seoul)에 로컬 `main`의 현재 artifact를 다시 빌드하고 다음을 직접
관측했습니다.

| 게이트 | 결과 | 관측값 |
| --- | --- | --- |
| TypeScript/build | PASS | `tsc --noEmit`, `tsc`, MCP bundle 모두 exit 0 |
| Vitest | PASS | 41 files, 411/411 tests |
| Codex rollout slice | PASS | 21/21 |
| 전체 Node slice | PASS | 69/69 |
| recall/evidence 경계 | PASS | mixed recall+repo 보존, Memex MCP 차단, assistant synthesis 차단, trusted repo evidence의 EVOLUTION 및 source/revision 보존 |
| built-in Memory setup | PASS | enabled 감지, 승인 없는 무변경, explicit disable+재확인, disabled no-op, help 4/4; 실제 사용자 config dry-run 전후 SHA-256 동일 |
| 설치 artifact 계약 | PASS-WITH-NOTES | MCP 9 tools, 3 skills, installed cache, package onboarding, cleanup 모두 PASS; formal validator는 0.149.1에 없음 |
| installer E2E | PASS | dry-run, plugin-managed hook manifest, fallback hook 무변경, real install, idempotent rerun, first sync, removal, user-state isolation |
| public GitHub 설치 | PASS | `BongSuCHOI/memex`에서 두 명령 설치, setup, 2-exchange sync, Luna fact 2건, ontology/embedding, readiness 3종 true, update 후 data 보존, removal/cleanup |
| lifecycle offline | PASS | 9/9 및 7-surface cleanup |
| lifecycle authenticated | PASS | 11/11; 실제 Codex 3-event hook, context nonce, Luna fact 추출, 다음 MCP 검색 |
| browser E2E | PASS | Facts, Pipeline, empty graph, keyboard focus, CJK, markup injection rejection |
| populated 3D/performance | PASS | 200 rollouts, 800 exchanges, 50 facts, 49 relations; 6개 성능 threshold 그룹 모두 PASS |
| CLI manual QA | PASS | `--help`, 잘못된 command exit 1, fresh data root `status --json` |
| docs/package | PASS | Markdown 상대 링크, `git diff --check`, npm public-file allowlist 176 files 확인 |
| repository skills | PASS | `skill-creator` official `quick_validate.py` 3/3 및 installed-artifact discovery |

현재 전체 판정은 **PASS-WITH-NOTES**입니다. FAIL 또는 NOT_PROVEN은 없습니다. 유일한
note는 Codex CLI 0.149.1의 formal plugin validator 부재이며, 기능·설치·MCP·스킬
동작은 격리된 installed-artifact 검증으로 통과했습니다.

세 repository skill은 로컬 `skill-creator`의 official `quick_validate.py`로 각각
검증했고 모두 통과했습니다. `scripts/validate-plugin.mjs`의 installed-artifact 검사도
동일한 세 스킬을 Codex cache layout에서 발견했습니다.
