# MCP 도구와 Codex 스킬

## 1. MCP server

`.mcp.json`의 server id는 `memex`입니다. installed plugin의 `cli/runtime-exec.js`는 materialized된
version-pinned local artifact의 `memex-mcp-server`를 실행합니다. `github:BongSuCHOI/memex#main`은
dependency materialization 전 raw registration을 위한 compatibility fallback일 뿐입니다.

MCP 전용 cache:

```text
$XDG_CACHE_HOME/memex/npm-mcp
# default: ~/.cache/memex/npm-mcp
```

대부분의 도구는 local data만 읽습니다. `ask_avatar`는 저장된 evidence를 합성하기 위해 local Codex CLI를 사용할 수 있습니다.

## 2. Scope 계약

Project-sensitive MCP surfaces(`search`, `search_facts`, `search_ontology`, `ask_avatar`,
`trace_fact`, `graph_stats`, `explore_graph`)는 stable identity의 explicit scope를 지원합니다.

```text
scope: "project"    + project_id (또는 legacy canonical path)
scope: "workspace"  + workspace_id
scope: "workstream" + workstream_id
scope: "session"    + session_id
scope: "global"
scope: "all"
```

MCP process cwd는 installed plugin/cache 위치일 수 있으므로 project identity로 사용하지 않습니다.
Workspace/workstream/session ID는 DB membership을 검증하며 다른 project의 ID 조합을 허용하지 않습니다.
`search`는 raw conversation evidence를 같은 stable scope로 제한합니다. Ontology/avatar/graph도
동일 membership 검사를 거치며 relation traversal의 모든 hop을 요청 scope로 제한합니다.
`include_hot_evidence`는
stable scope 안의 recent raw evidence를 `NOT YET DISTILLED`로 분리하고
`hot_before` + `hot_before_evidence_id` keyset cursor를 지원합니다. Legacy canonical path는 read-only
compatibility surface이며 process cwd 추론이나 identity registry mutation 없이 explicit path로만 받습니다.

## 3. 9개 도구

| 도구 | 용도 |
| --- | --- |
| `search` | 과거 conversation 검색 |
| `read` | archive 원문/line range 읽기 |
| `search_facts` | 증류된 fact 검색 |
| `search_ontology` | domain/category별 fact 탐색 |
| `ask_avatar` | 저장된 evidence를 바탕으로 답변 합성 |
| `trace_fact` | current fact → Chronicle timeline(previous value, rollback, grounded cause vs classifier note, validation/incident, contradiction) → source evidence 추적. `query|fact_id|subject_key`, bounded cursor pagination, stable scope filter |
| `explore_graph` | 1–3 hop relation 탐색 |
| `cross_project_insights` | 다른 project의 유사 해결책 탐색 |
| `graph_stats` | graph 규모와 health 확인 |

정확한 JSON schema는 `skills/remembering-conversations/references/mcp-tools.md`가 소유합니다. `src/mcp-server.ts`의 `tools/list`와 함께 변경해야 합니다.

## 4. Recall evidence 경계

모든 Memex MCP retrieval result는 `memex_recall/learnable=0`입니다. 검색에는 남지만 다시 장기 fact의 증거로 학습하지 않습니다.

`trace_fact`는 `source_exchange_ids`의 원문을 authoritative source로 먼저 표시하고, 별도
`Interpretive Context (Non-Authoritative)` 절에 local `fact_context_dependencies`를 표시합니다.
Context는 model-declared index가 bounded causal check를 통과한 뒤 server-resolved된 관계입니다.
두 절의 exchange가 같아 보이더라도 context 절은 Fact evidence로 승격되지 않습니다.

Phase 4부터 `trace_fact`는 lane label을 출력합니다: `CURRENT FACT`(authoritative current), `CHRONICLE EVENT`
(append-only history, `effective`/`recorded` 시각과 `projection changed|event-only` 표시), `RAW EVIDENCE`(source
exchange, purge된 경우 `source unavailable`), `ASSISTANT CONTEXT-ONLY`, `HOT EVIDENCE — NOT YET DISTILLED`.
event의 `grounded cause (source-cited)`와 `classifier note (model inference, NOT authoritative)`는 항상 분리됩니다.
history는 `timeline_limit`(≤50)과 `timeline_cursor`로 bounded pagination됩니다.

같은 turn의 별도 repo/Git/test tool result는 call ID별로 독립 분류합니다. Memex MCP call 하나가 sibling evidence를 자동으로 taint하지 않습니다.

## 5. Repository skills

### `remembering-conversations`

과거 구현, 결정, 실패 원인을 찾을 때 사용합니다. 현재 codebase를 먼저 이해하고 필요한 경우 conversation search/read, fact, graph, provenance 순으로 확장합니다.

### `analyzing-all-conversations`

전체 conversation history를 분석할 때 deterministic `memex analyze` 결과를 기본 coverage로 사용하고 fact/ontology를 의미 해석에 보강합니다.

### `show-memex-dashboard`

사용자가 local UI를 열어달라고 할 때 기존 Memex listener를 재사용하고 다른 process가 port를 사용 중이면 종료하지 않고 충돌을 보고합니다.

## 6. 스킬 유지보수

- skill directory와 frontmatter `name` 일치
- project-sensitive MCP 호출은 canonical project 또는 explicit scope 사용
- background “started”를 완료로 보고하지 않음
- mutation/background effect를 read-only lookup과 구분
- MCP schema 변경 시 reference와 regression test를 같은 변경에 포함
- Memex recall 결과를 learnable evidence로 바꾸지 않음
- installed runtime은 공통 `runtime-exec` 경계를 사용
