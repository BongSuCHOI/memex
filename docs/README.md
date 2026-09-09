# Memex documentation

이 디렉터리의 owner 문서는 Memex의 **현재 제품 계약**을 설명합니다. `architecture/`의 잠긴 RFC와 `verification/`의 과거 실행 기록은 해당 시점의 증거로 보존하며, 현행 구현과의 차이는 [Continuity as-built](CONTINUITY.md)와 [deviation record](verification/continuity-v1/rfc-deviations.md)에서 확인합니다.

## 처음 읽는 순서

1. [운영 가이드](GUIDE.md) — 설치, 첫 동기화, 일상 사용, [CLI 전체](GUIDE.md#18-cli-한눈에-보기), [환경 변수](GUIDE.md#19-환경-변수), 진단, [실패 클래스별 복구](GUIDE.md#20-문제가-생겼을-때--실패-클래스별-복구), 제거
2. [아키텍처](ARCHITECTURE.md) — 전체 계층, 데이터 흐름, 상태 모델
3. [대화 라이프사이클](CONVERSATION-LIFECYCLE.md) — rollout → archive/index → sync
4. [팩트 라이프사이클](FACT-LIFECYCLE.md) — 추출, 통합, 수정, 비활성화, 삭제
5. [지식 그래프](KNOWLEDGE-GRAPH.md) — ontology, relation, taxonomy rebuild
6. [검색과 컨텍스트](RETRIEVAL-AND-CONTEXT.md) — FTS/vector/RAG/injection
7. [스키마](SCHEMA.md) — SQLite 테이블과 transaction 불변식
8. [MCP와 스킬](MCP-AND-SKILLS.md) — 9개 MCP 도구와 3개 스킬
9. [Web UI](WEBUI-WORKSPACE.md) — Memex Workspace 로컬 화면, 범위 선택, 계층 배지와 승격/강등, 동기화 탭, 지식 지도
10. [검증](VERIFICATION.md) — merge gate, E2E, receipt 규칙
11. [계보](LINEAGE.md) — upstream attribution과 Codex-native 경계
12. [Continuity as-built](CONTINUITY.md) — lifecycle/journal/outbox/worker, Capsule, identity, Chronicle, Memory Broker, sync/privacy의 실제 구현 지도. 규범은 [Final RFC](architecture/memex-continuity-v1.md), 차이는 [deviation record](verification/continuity-v1/rfc-deviations.md)

0.6.0 **범위 모델(브랜치 ⇄ 프로젝트 공용 ⇄ 글로벌)의 단일 출처**는
[FACT-LIFECYCLE.md §1](FACT-LIFECYCLE.md#1-fact란-무엇인가)의 표이고, 결정 규칙은
[CONTINUITY.md §5](CONTINUITY.md#5-project--workspace--workstream--session-10),
저장 형태는 [SCHEMA.md §3](SCHEMA.md#3-facts)입니다. README / README-KR의 같은 표는 이 문서의 사본입니다.

## 핵심 개념

Memex는 데이터를 한 덩어리로 취급하지 않습니다.

- **Conversation source** — Codex rollout과 Memex archive. 원본은 read-only입니다.
- **Semantic fact state** — fact 문장, category, scope. `semantic_updated_at`으로 기기 간 충돌을 판단합니다.
- **Lifecycle state** — active/inactive. 의미와 독립적인 `lifecycle_updated_at`을 사용합니다.
- **Lineage metadata** — `source_exchange_ids`는 set union, `consolidated_count`는 max로 단조 수렴합니다.
- **Local derived state** — `fact_kr`, ontology, relation, vector. protocol v5에서는 sync하지 않고 각 기기가 재구축합니다.
- **Durable sync state** — facts, revisions, tombstones, recall receipts만 generation snapshot으로 교환합니다.
- **기억 계층(memory tier)** — 같은 fact라도 브랜치 tier / 프로젝트 공용 / 글로벌 중 어디에 있느냐가 주입과 조회 범위를 정합니다. `facts.promotion_state`와 `facts.tier_reason`이 그 위치와 근거이고, 이동은 Chronicle `PROMOTED`/`DEMOTED`로 남습니다.

이 분리는 multi-device sync에서 의미 편집, 비활성화, provenance, 파생 상태가 서로를 덮어쓰지 않게 하는 기본 설계입니다.

## 책임 지도

| 관심사 | 구현 소유자 | 문서 소유자 |
| --- | --- | --- |
| Codex rollout parsing | `src/codex-rollout.ts`, `src/parser.ts` | `CONVERSATION-LIFECYCLE.md` |
| archive/index | `src/sync.ts`, `src/indexer.ts`, `src/archive-io.ts` | `CONVERSATION-LIFECYCLE.md` |
| cross-device sync | `src/sync-export.ts`, `src/sync-import.ts`, `src/fact-management.ts` | `CONVERSATION-LIFECYCLE.md`, `FACT-LIFECYCLE.md` |
| 동기화 스위치·공유 폴더 | `src/sync-control.ts`, `src/sync-paths.ts`, `scripts/sync-export-hook.js`, `scripts/sync-import-hook.js` | `GUIDE.md`, `WEBUI-WORKSPACE.md` |
| facts/provenance | `src/fact-extractor.ts`, `src/fact-db.ts` | `FACT-LIFECYCLE.md` |
| fact mutation/consolidation | `src/fact-management.ts`, `src/consolidator.ts` | `FACT-LIFECYCLE.md`, `SCHEMA.md` |
| 기억 계층·승격 사다리 | `src/fact-management.ts`(`promoteFact`/`demoteFact`/`reconcileFactTiers`), `src/fact-db.ts`(`defaultTierFor`) | `FACT-LIFECYCLE.md`, `SCHEMA.md` |
| project identity 신뢰 경계·read scope | `src/project-identity.ts`, `src/read-scope.ts` | `CONVERSATION-LIFECYCLE.md`, `RETRIEVAL-AND-CONTEXT.md` |
| terminal 상태 복구 | `src/job-recovery.ts`, `src/pipeline-status.ts` | `GUIDE.md` |
| 주입 관측 로그 | `src/inject-log.ts`, `src/inject-core.ts` | `RETRIEVAL-AND-CONTEXT.md`, `GUIDE.md` |
| ontology/relations | `src/ontology-classifier.ts`, `src/ontology-db.ts` | `KNOWLEDGE-GRAPH.md` |
| taxonomy 수리·parking selector | `src/ontology-admin.ts`, `src/ontology-selector.ts` | `KNOWLEDGE-GRAPH.md`, `GUIDE.md` |
| 근거 영수증 backfill | `src/evidence-backfill.ts`, `scripts/backfill-receipts-worker.js` | `FACT-LIFECYCLE.md`, `GUIDE.md` |
| 유지보수 계보·derived lane 기아 | `src/model-budget.ts`, `src/derived-lane-skip.ts` | `SCHEMA.md`, `CONVERSATION-LIFECYCLE.md` |
| search/RAG/injection | `src/search.ts`, `src/inject-*.ts` | `RETRIEVAL-AND-CONTEXT.md` |
| lifecycle/hooks | `src/lifecycle.ts`, `scripts/*hook*` | `GUIDE.md`, `CONVERSATION-LIFECYCLE.md` |
| MCP | `src/mcp-server.ts`, `.mcp.json` | `MCP-AND-SKILLS.md` |
| Web UI | `ui/server.cjs`, `ui/lib/`, `ui/public/` | `WEBUI-WORKSPACE.md` |
| persistence | `src/db.ts`, `src/fact-db.ts`, `src/ontology-db.ts` | `SCHEMA.md` |
| installation/package/update | `.codex-plugin/`, `cli/runtime-exec.js`, installer/update scripts | `GUIDE.md`, `ARCHITECTURE.md` |
| 설치본 root 해석·의존성 materialize | `src/plugin-root.ts`, `scripts/materialize-deps.mjs` | `GUIDE.md` |
| release evidence | tests, E2E, `docs/verification/*` | `VERIFICATION.md` |
| continuity capture/queue/worker | `src/continuity-core.ts`, `src/continuity-store.ts`, `src/continuity-evidence.ts`, `src/continuity-worker.ts`, `scripts/continuity-hook.js` | `CONTINUITY.md`, `CONVERSATION-LIFECYCLE.md` |
| identity/Chronicle/recall gate | `src/continuity-identity.ts`, `src/chronicle.ts`, `src/recall-gate.ts`, `src/memory-bundle.ts` | `CONTINUITY.md`, `FACT-LIFECYCLE.md`, `RETRIEVAL-AND-CONTEXT.md` |
| project ancestry | license/upstream history | `LINEAGE.md` |

## 문서 유지 규칙

- public 명령이나 설치 경로가 바뀌면 `GUIDE.md`와 public README를 함께 갱신합니다.
- persisted field나 transaction 불변식이 바뀌면 `SCHEMA.md`와 해당 lifecycle 문서를 함께 갱신합니다.
- MCP schema가 바뀌면 `MCP-AND-SKILLS.md`와 skill reference를 같은 변경에서 갱신합니다.
- sync protocol이 바뀌면 `ARCHITECTURE.md`, `CONVERSATION-LIFECYCLE.md`, `FACT-LIFECYCLE.md`, `SCHEMA.md`와 두 README의 멀티디바이스 절을 함께 검토합니다.
- Web UI가 문서 앵커를 인용하므로(`ui/public/help.mjs`·`guidance.mjs`) `GUIDE.md`·`WEBUI-WORKSPACE.md`·`FACT-LIFECYCLE.md`의 헤딩을 바꾸면 `ui/test/help.test.cjs`가 먼저 실패합니다.
- 검증 수치나 PASS receipt는 **실제 명령을 실행한 경우에만** 기록합니다.

## 상태 표기

- `PASS` — 현재 artifact에서 직접 관측하거나 충분한 자동 검증으로 증명됨
- `FAIL` — 요구 동작과 반대되는 결과를 관측함
- `NOT_PROVEN` — 필요한 환경·권한·관측이 없어 증명하지 못함
- `PASS-WITH-NOTES` — 필수 correctness/safety gate는 통과했지만 environment,
  nondeterminism, quality 또는 comparability 한계를 함께 기록해야 함

최신 release evidence와 merge-gate 절차는 [VERIFICATION.md](VERIFICATION.md)를 기준으로 합니다.
