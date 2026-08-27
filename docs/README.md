# Memex documentation

이 디렉터리는 Memex의 현재 제품 계약을 설명합니다. 전환 과정의 계획이나
일회성 에이전트 보고서가 아니라, 구현과 함께 유지해야 하는 문서만 둡니다.

## 처음 읽는 순서

1. [운영 가이드](GUIDE.md) — 설치, 첫 동기화, 사용, 진단, 해제
2. [아키텍처](ARCHITECTURE.md) — 전체 구성요소와 데이터 흐름
3. [대화 라이프사이클](CONVERSATION-LIFECYCLE.md) — rollout부터 archive/index까지
4. [팩트 라이프사이클](FACT-LIFECYCLE.md) — 추출, 통합, revision, 삭제
5. [지식 그래프](KNOWLEDGE-GRAPH.md) — ontology, relation, traversal, scope
6. [검색과 컨텍스트](RETRIEVAL-AND-CONTEXT.md) — vector/FTS/RAG/injection
7. [스키마](SCHEMA.md) — SQLite 테이블, 인덱스, 트랜잭션 불변식
8. [MCP와 스킬](MCP-AND-SKILLS.md) — 9개 도구와 3개 스킬
9. [시각화](VISUALIZATION.md) — Web UI와 3D Knowledge Galaxy
10. [검증](VERIFICATION.md) — 테스트/E2E/성능/버전 경계
11. [계보](LINEAGE.md) — upstream attribution과 Codex-native 전환 원칙

## 책임 지도

| 관심사 | 구현 소유자 | 문서 소유자 |
| --- | --- | --- |
| Codex rollout parsing | `src/codex-rollout.ts`, `src/parser.ts` | `CONVERSATION-LIFECYCLE.md` |
| archive/index/sync | `src/sync.ts`, `src/indexer.ts`, `src/archive-io.ts` | `CONVERSATION-LIFECYCLE.md` |
| facts/provenance | `src/fact-extractor.ts`, `src/fact-db.ts` | `FACT-LIFECYCLE.md` |
| consolidation | `src/consolidator.ts` | `FACT-LIFECYCLE.md` |
| ontology/relations | `src/ontology-classifier.ts`, `src/ontology-db.ts` | `KNOWLEDGE-GRAPH.md` |
| search/RAG/injection | `src/search.ts`, `src/inject-*.ts` | `RETRIEVAL-AND-CONTEXT.md` |
| lifecycle/hooks | `src/lifecycle.ts`, `scripts/*hook*` | `GUIDE.md`, `CONVERSATION-LIFECYCLE.md` |
| built-in Memory conflict/setup | `scripts/setup-memex.js`, `cli/memex.js` | `GUIDE.md`, public READMEs |
| MCP | `src/mcp-server.ts`, `.mcp.json` | `MCP-AND-SKILLS.md` |
| UI/3D | `ui/server.cjs`, `ui/relations/` | `VISUALIZATION.md` |
| persistence | `src/db.ts`, `src/fact-db.ts`, `src/ontology-db.ts` | `SCHEMA.md` |
| recall provenance/non-learnable evidence | `src/inject-core.ts`, `src/db.ts`, `src/fact-extractor.ts` | `RETRIEVAL-AND-CONTEXT.md`, `FACT-LIFECYCLE.md`, `SCHEMA.md` |
| project identity/scope | `src/project-identity.ts`, scoped query/import paths | `ARCHITECTURE.md`, `SCHEMA.md`, affected lifecycle document |
| model execution | `src/codex-exec.ts`, model-backed workers | `ARCHITECTURE.md`, `RETRIEVAL-AND-CONTEXT.md` |
| fact management | `src/fact-management.ts`, CLI/API mutation routes | `FACT-LIFECYCLE.md`, `SCHEMA.md`, `GUIDE.md` |
| plugin/install/package/update | `.codex-plugin/`, manifests, `cli/runtime-exec.js`, update/installer scripts, npm metadata | `GUIDE.md`, `MCP-AND-SKILLS.md`, `ARCHITECTURE.md`, public READMEs when the shortest path changes |
| skills | `skills/*/SKILL.md`, skill references | `MCP-AND-SKILLS.md`, exact reference owned by the skill |
| security/performance/acceptance | guards, fixtures, E2E, benchmark | `VERIFICATION.md` and current machine receipt when regenerated |
| public identity/release | package/plugin/UI names and release surface | `README.md`, `README-KR.md`, `CHANGELOG.md`, `LINEAGE.md` when ancestry changes |

문서 패치 기준은 간단합니다. public 명령이나 설치 순서가 바뀌면 README와 GUIDE를,
persisted field나 transaction 불변식이 바뀌면 SCHEMA와 해당 lifecycle 문서를, MCP
input/output이 바뀌면 MCP 문서와 skill tool reference를 같은 변경에서 갱신합니다.
검증 수치나 receipt는 실제 명령을 다시 실행한 경우에만 VERIFICATION에 기록합니다.

## 상태 표기

- `PASS`: 현재 artifact에서 직접 관측 또는 충분한 기계 검증으로 증명됨
- `FAIL`: 요구 동작과 반대되는 결과를 직접 관측함
- `NOT_PROVEN`: 필요한 환경/권한/관측이 없어 아직 증명하지 못함
- `PASS-WITH-NOTES`: 기능은 통과했지만 명시된 버전 경계가 있음

계획 문서나 과거 로그는 현재 동작의 증거가 아닙니다. 최신 검증 명령과 남은
경계는 [VERIFICATION.md](VERIFICATION.md)에 기록합니다.
