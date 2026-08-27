# MCP 도구와 Codex 스킬

## 1. MCP server

`.mcp.json`의 server id는 `memex`입니다. Installed plugin의 dependency-free
`cli/runtime-exec.js`가 `npx`를 통해 최신 `github:BongSuCHOI/memex#main` package의
`memex-mcp-server`를 실행합니다. Package 내부 wrapper가 실제 bundled server와
native runtime dependency를 확인합니다. 사용자 project/global prefix는 변경하지
않으며 npm isolated cache만 사용합니다.

모든 도구는 local data만 읽습니다. `ask_avatar`만 저장된 근거를 합성하기 위해 local
Codex CLI를 호출하며 외부 API key를 직접 사용하지 않습니다.

## 2. 공통 scope 계약

project-sensitive 도구는 다음 중 하나가 필요합니다.

- `project: "/canonical/absolute/cwd"`
- `scope: "global"`
- `scope: "all"`

`cross_project_insights`는 `current_project`가 필수입니다. MCP process cwd는 installed
plugin root이므로 project로 사용하지 않습니다. 누락 시 구조화된 validation error를
반환합니다.

## 3. 도구 선택표

| 도구 | 언제 사용 | 핵심 입력 |
| --- | --- | --- |
| `search` | 과거 대화/구현/결정 찾기 | query, mode, date, limit, optional project |
| `read` | 검색 결과의 원문과 맥락 확인 | confined archive path, line range |
| `search_facts` | 증류된 decision/preference/pattern 등 찾기 | query, project/scope, category |
| `search_ontology` | domain/category별 fact 탐색 | filters, project/scope, relations |
| `ask_avatar` | 과거 근거로 사용자 성향/결정을 합성 | question, project/scope |
| `trace_fact` | fact의 revision/source/archive 추적 | query, project/scope, limit |
| `explore_graph` | 결정 chain을 1–3 hop 탐색 | query, hops, project/scope |
| `cross_project_insights` | 다른 project의 유사 해결책 찾기 | query, current_project, limit |
| `graph_stats` | 지식 그래프 규모/건강 확인 | project/scope |

정확한 JSON schema와 예시는
[`skills/remembering-conversations/references/mcp-tools.md`](../skills/remembering-conversations/references/mcp-tools.md)에
있습니다. 그 파일은 `src/mcp-server.ts`의 `tools/list`와 함께 변경해야 합니다.

## 4. 스킬

### `remembering-conversations`

과거 작업/결정/실패 원인을 찾을 때 사용합니다. 현재 codebase를 먼저 이해한 뒤
conversation은 `search`→`read`, 장기 지식은 `search_facts`, 구조/영향은 graph/provenance
도구로 확장합니다. 결과에는 archive path/line 또는 fact provenance를 붙입니다.

아홉 Memex MCP retrieval tool은 read-only recall source입니다. rollout의
`mcp__memex__<tool>` result는 call 단위 `memex_recall/learnable=0`입니다. 같은 turn의
repo/Git/test tool result는 독립 분류되어 살아남습니다. assistant synthesis는 항상
검색 가능하지만 새 fact extraction evidence에서는 제외됩니다.

### `analyzing-all-conversations`

전체 대화 이력을 정리할 때 deterministic `memex analyze`를 먼저 실행합니다. coverage
숫자는 엔진 결과를 사용하고 의미 해석만 MCP fact/ontology 결과로 보강합니다. backlog를
시작했다면 완료가 아니라 background running으로 보고합니다.

### `show-memex-dashboard`

사용자가 로컬 UI를 열어달라고 할 때 port owner를 확인하고, 기존 Memex server면
재사용하며 다른 process면 종료하지 않고 충돌을 보고합니다. 새 server는 observable한
process로 시작하고 loopback URL만 엽니다.

## 5. 스킬 유지보수 체크리스트

- directory name과 frontmatter `name`이 동일하다.
- `memex` 명칭과 installed root의 `cli/runtime-exec.js`를 사용한다.
- project-sensitive 호출이 canonical cwd 또는 explicit scope를 전달한다.
- read-only와 mutation/background 효과를 구분한다.
- plugin/global dependency를 등록하지 않는다. Runtime package resolution은 공통
  `runtime-exec`과 npm isolated cache로 제한한다. Marketplace hooks는 plugin manifest가
  선언하며, skill 실행이 사용자 hook 파일을 변경하지 않는다.
- background 시작을 완료로 보고하지 않는다.
- MCP schema 변경 시 tool reference와 회귀 테스트를 같은 변경에서 갱신한다.
