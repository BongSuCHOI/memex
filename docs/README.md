# Memex documentation

이 디렉터리는 Memex의 **현재 제품 계약**을 설명합니다. 개발 과정의 임시 계획이나 감사 로그가 아니라, 구현과 함께 유지해야 하는 owner documentation만 둡니다.

## 처음 읽는 순서

1. [운영 가이드](GUIDE.md) — 설치, 첫 동기화, 일상 사용, 진단, 제거
2. [아키텍처](ARCHITECTURE.md) — 전체 계층, 데이터 흐름, 상태 모델
3. [대화 라이프사이클](CONVERSATION-LIFECYCLE.md) — rollout → archive/index → sync
4. [팩트 라이프사이클](FACT-LIFECYCLE.md) — 추출, 통합, 수정, 비활성화, 삭제
5. [지식 그래프](KNOWLEDGE-GRAPH.md) — ontology, relation, taxonomy rebuild
6. [검색과 컨텍스트](RETRIEVAL-AND-CONTEXT.md) — FTS/vector/RAG/injection
7. [스키마](SCHEMA.md) — SQLite 테이블과 transaction 불변식
8. [MCP와 스킬](MCP-AND-SKILLS.md) — 9개 MCP 도구와 3개 스킬
9. [시각화](VISUALIZATION.md) — Web UI와 3D Knowledge Galaxy
10. [검증](VERIFICATION.md) — merge gate, E2E, receipt 규칙
11. [계보](LINEAGE.md) — upstream attribution과 Codex-native 경계

## 핵심 개념

Memex는 데이터를 한 덩어리로 취급하지 않습니다.

- **Conversation source** — Codex rollout과 Memex archive. 원본은 read-only입니다.
- **Semantic fact state** — fact 문장, category, scope. `semantic_updated_at`으로 기기 간 충돌을 판단합니다.
- **Lifecycle state** — active/inactive. 의미와 독립적인 `lifecycle_updated_at`을 사용합니다.
- **Lineage metadata** — `source_exchange_ids`는 set union, `consolidated_count`는 max로 단조 수렴합니다.
- **Local derived state** — `fact_kr`, ontology, relation, vector. protocol v4에서는 sync하지 않고 각 기기가 재구축합니다.
- **Durable sync state** — facts, revisions, tombstones, recall receipts만 generation snapshot으로 교환합니다.

이 분리는 multi-device sync에서 의미 편집, 비활성화, provenance, 파생 상태가 서로를 덮어쓰지 않게 하는 기본 설계입니다.

## 책임 지도

| 관심사 | 구현 소유자 | 문서 소유자 |
| --- | --- | --- |
| Codex rollout parsing | `src/codex-rollout.ts`, `src/parser.ts` | `CONVERSATION-LIFECYCLE.md` |
| archive/index | `src/sync.ts`, `src/indexer.ts`, `src/archive-io.ts` | `CONVERSATION-LIFECYCLE.md` |
| cross-device sync | `src/sync-export.ts`, `src/sync-import.ts`, `src/fact-management.ts` | `CONVERSATION-LIFECYCLE.md`, `FACT-LIFECYCLE.md` |
| facts/provenance | `src/fact-extractor.ts`, `src/fact-db.ts` | `FACT-LIFECYCLE.md` |
| fact mutation/consolidation | `src/fact-management.ts`, `src/consolidator.ts` | `FACT-LIFECYCLE.md`, `SCHEMA.md` |
| ontology/relations | `src/ontology-classifier.ts`, `src/ontology-db.ts` | `KNOWLEDGE-GRAPH.md` |
| search/RAG/injection | `src/search.ts`, `src/inject-*.ts` | `RETRIEVAL-AND-CONTEXT.md` |
| lifecycle/hooks | `src/lifecycle.ts`, `scripts/*hook*` | `GUIDE.md`, `CONVERSATION-LIFECYCLE.md` |
| MCP | `src/mcp-server.ts`, `.mcp.json` | `MCP-AND-SKILLS.md` |
| UI/3D | `ui/server.cjs`, `ui/relations/` | `VISUALIZATION.md` |
| persistence | `src/db.ts`, `src/fact-db.ts`, `src/ontology-db.ts` | `SCHEMA.md` |
| installation/package/update | `.codex-plugin/`, `cli/runtime-exec.js`, installer/update scripts | `GUIDE.md`, `ARCHITECTURE.md` |
| release evidence | tests, E2E, `docs/verification/*` | `VERIFICATION.md` |
| project ancestry | license/upstream history | `LINEAGE.md` |

## 문서 유지 규칙

- public 명령이나 설치 경로가 바뀌면 `GUIDE.md`와 public README를 함께 갱신합니다.
- persisted field나 transaction 불변식이 바뀌면 `SCHEMA.md`와 해당 lifecycle 문서를 함께 갱신합니다.
- MCP schema가 바뀌면 `MCP-AND-SKILLS.md`와 skill reference를 같은 변경에서 갱신합니다.
- sync protocol이 바뀌면 `ARCHITECTURE.md`, `CONVERSATION-LIFECYCLE.md`, `FACT-LIFECYCLE.md`, `SCHEMA.md`를 함께 검토합니다.
- 검증 수치나 PASS receipt는 **실제 명령을 실행한 경우에만** 기록합니다.

## 상태 표기

- `PASS` — 현재 artifact에서 직접 관측하거나 충분한 자동 검증으로 증명됨
- `FAIL` — 요구 동작과 반대되는 결과를 관측함
- `NOT_PROVEN` — 필요한 환경·권한·관측이 없어 증명하지 못함
- `PASS-WITH-NOTES` — 동작은 통과했지만 명시할 version/environment boundary가 있음

최신 release evidence와 merge-gate 절차는 [VERIFICATION.md](VERIFICATION.md)를 기준으로 합니다.
