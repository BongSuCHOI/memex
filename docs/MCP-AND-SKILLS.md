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
`search_facts`와 `trace_fact`의 관련 사실도 resolved `ReadScope`를 필수 graph core에 전달합니다.
기본 fact, seed, 관련 fact와 최종 결과가 같은 범위를 사용합니다.
`search_facts`는 파일 경로·함수명·에러 코드의 exact text 후보와 semantic 후보를 함께 찾습니다.
임베딩을 사용할 수 없어도 lexical 조회는 유지합니다. 텍스트 응답은 `exact text match` /
`lexical match`와 semantic 점수를 구분합니다. 내부 `KnowledgeContext`의 `lane`,
`semanticSimilarity`, `lexicalScore`도 구분하며 lexical-only 결과의 semantic 값은 `null`입니다.
Exact text 일치를 semantic similarity 100%로 표시하지 않습니다.
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
| `trace_fact` | current fact → Chronicle timeline(previous value, rollback, grounded cause vs classifier note, validation/incident, contradiction) → source evidence 추적. `query\|fact_id\|subject_key`, bounded cursor pagination, stable scope filter |
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
0.6.0의 `PROMOTED`/`DEMOTED` event도 같은 timeline에 나타나며 `from_tier`/`to_tier`/`actor`를 함께 보여줍니다.
event의 `grounded cause (source-cited)`와 `classifier note (model inference, NOT authoritative)`는 항상 분리됩니다.
history는 `timeline_limit`(≤50)과 `timeline_cursor`로 bounded pagination됩니다.
timeline의 scope 가시성은 fact search 계약과 같습니다: `project` scope는 project-wide truth와 event-only
observation만 보여주고 unmerged workspace/workstream fact의 history는 숨깁니다. `workspace`/`workstream`
scope는 정확히 그 workspace/workstream의 fact와 evidence를 추가하며 sibling workstream의 history는 보이지 않습니다.
unmerged fact의 event는 `scope: workstream <id> (unmerged; not project-wide truth)`로 표시됩니다.

같은 turn의 별도 repo/Git/test tool result는 call ID별로 독립 분류합니다. Memex MCP call 하나가 sibling evidence를 자동으로 taint하지 않습니다.

## 5. Repository skills

세 skill 모두 `skills/<name>/SKILL.md`가 원본이며, 아래 설명은 그 파일과 `src/mcp-server.ts`의
실제 handler에서 확인한 내용입니다.

### `remembering-conversations`

과거 구현, 결정, 실패 원인을 찾을 때 사용합니다. 현재 codebase를 먼저 이해하고 필요한 경우 conversation search/read, fact, graph, provenance 순으로 확장합니다.

**언제 쓰나**

- "이거 전에 왜 이렇게 했더라?" / "예전에 이 에러 어떻게 고쳤지?"
- "우리 인증 구조 결정한 이유가 뭐였지?"
- "다른 프로젝트에서 비슷한 문제 어떻게 풀었어?"

**시나리오** — 사용자가 "세션 저장소를 왜 Redis 대신 SQLite로 갔지?"라고 묻습니다.
skill은 먼저 `search_facts`로 durable decision을 찾고, 근거가 필요하면 `trace_fact`로
current fact → Chronicle timeline(이전 값, rollback, `PROMOTED`/`DEMOTED`) → source exchange를
따라갑니다. 결정의 원문 표현이 필요하면 `search`로 후보 archive 범위를 찾고 `read`로 2–5개
구간만 읽습니다. 연결된 결정이 궁금하면 `explore_graph`, 다른 프로젝트의 해법이 궁금하면
`cross_project_insights`를 씁니다.

**동작** — 전부 read-only MCP 호출입니다. `search`, `search_facts`, `cross_project_insights`,
`explore_graph`는 질의를 로컬 임베딩 모델(`Xenova/multilingual-e5-small`)로 벡터화하는데, 이는
로컬 추론이며 Codex 호출이 아닙니다. **Codex 모델을 실제로 부르는 것은 `ask_avatar` 하나뿐**입니다
(`callMemoryModel` 1회). 어떤 호출도 fact를 만들거나 바꾸지 않고, 결과는 전부
`memex_recall / learnable = 0`으로 표시되어 새 fact의 근거가 되지 못합니다.
project-sensitive 도구에는 현재 스레드의 canonical absolute cwd나 명시적 `global`/`all` scope를
넘겨야 하며, MCP 프로세스의 cwd를 프로젝트로 쓰지 않습니다.

**결과** — 답변과 함께 근거의 위치가 남습니다: archive 경로와 line range, 또는 fact provenance와
그 fact의 계층. 직접 근거(`RAW EVIDENCE`)와 해석 맥락(`ASSISTANT CONTEXT-ONLY`)은 분리해 제시하고,
`grounded cause (source-cited)`와 `classifier note (…NOT authoritative)`도 섞지 않습니다.
검색이 비면 "기록이 없다"가 아니라 다른 브랜치 계층에 있을 수 있다고 말합니다.

### `analyzing-all-conversations`

전체 conversation history를 분석할 때 deterministic `memex analyze` 결과를 기본 coverage로 사용하고 fact/ontology를 의미 해석에 보강합니다.

**언제 쓰나**

- "전체 대화 내역 분석해줘" / "대화 기록 정리해서 리포트 만들어줘"
- "지금까지 어떤 프로젝트에 시간을 썼는지 보여줘"
- "추출 안 된 대화가 얼마나 남았어?"

**시나리오** — 사용자가 "지금까지 쌓인 대화 전체를 정리해줘"라고 합니다. skill은 먼저
`memex analyze --json`(read-only, 모델 호출 없음)을 실행해 대화/세션/턴/프로젝트/기간 총계,
추출·요약 커버리지, fact 분포, 도메인, 프로젝트별 롤업, 월별 활동, 권장 backfill을 받습니다.
그 숫자를 표본 검색으로 다시 만들지 않습니다. 의미를 붙일 때만 `graph_stats`(범위별 그래프 규모),
`search_facts`(대표 decision/pattern/constraint), 그리고 현재 프로젝트가 명시된 경우에 한해
`cross_project_insights`를 씁니다. 리포트가 커버리지 부족을 드러내고 사용자가 원하면
`memex backfill extract --background` / `backfill ontology --background` / `memex sync`를
실행합니다.

**동작** — 기본 경로는 완전히 read-only이며 모델을 부르지 않습니다. **backfill을 시작하면 그때부터
모델 작업이 발생합니다**(추출·분류 LLM 호출, [GUIDE §17](GUIDE.md#17-모델-작업-예산과-대기-진단)의
run 예산과 24시간 공통 호출 한도 적용). `--background`로 시작한 작업은 "시작됨"일 뿐 완료가 아니며,
skill은 이를 완료로 보고하지 않고 정확한 pending 건수와 로그 경로를 남깁니다.

**결과** — 사용자 언어로 된 리포트: 전체 코퍼스와 기간, 추출·요약 커버리지, 프로젝트별 롤업과
대표 지식, 도메인/카테고리 분포, 활동 타임라인, 남은 공백과 실제로 시작한 작업. 필수 pending
카운터가 하나라도 0이 아니면 "전체 커버리지"라고 주장하지 않습니다.

### `show-memex-dashboard`

사용자가 local UI를 열어달라고 할 때 기존 Memex listener를 재사용하고 다른 process가 port를 사용 중이면 종료하지 않고 충돌을 보고합니다.

**언제 쓰나**

- "메멕스 대시보드 열어줘" / "기억 목록 화면에서 보고 싶어"
- "지식 지도 보여줘"
- "지금 파이프라인 상태 화면으로 확인하고 싶어"

**시나리오** — 사용자가 "기억들 화면에서 좀 보자"라고 합니다. skill은 먼저 `3847` 포트의 주인을
확인합니다. 이미 이 설치본의 Memex 서버가 쓰고 있으면 그대로 재사용하고, 다른 프로세스가 쓰고
있으면 **종료하지 않고 충돌만 보고**합니다. 필요할 때만
`node "$PLUGIN_ROOT/cli/runtime-exec.js" memex-ui`로 새 서버를 띄우고,
`Memex Workspace <version>` · loopback URL · 해석된 `DB:` 경로가 출력되면 준비된 것으로 봅니다.
그 다음 요청에 해당하는 라우트 하나만 엽니다 — 기억이면 `/facts`, 지도면 `/graph`,
파이프라인 상태면 `/`.

**동작** — MCP 도구를 쓰지 않고 로컬 프로세스만 다룹니다. 모델 작업은 전혀 발생하지 않으며,
**화면을 여는 것만으로는 어떤 모델 작업도 시작되지 않습니다**. 의존성 설치, hook/plugin 등록,
기억 변경을 하지 않고 loopback 밖으로 서버를 노출하지도 않습니다. 범위는 모든 라우트의 query
파라미터입니다: `?scope=all`은 전체 프로젝트 + 공통 기억, `?scope=global`은 공통 기억만,
`?scope=project&project=<encoded-canonical-absolute-cwd>`는 프로젝트 하나입니다. 파라미터가 없으면
화면은 마지막으로 저장한 범위, 그것도 없으면 `all`로 떨어집니다(0.6.1 #24 — JSON API만 여전히
`global`이 기본입니다). 대화 원장·활동·해석 맥락 행은 글로벌 전용 범위에서 보이지 않으므로 그때는
`?scope=all`이나 프로젝트 범위를 씁니다.

**결과** — 사용자는 URL과, 새로 띄운 것인지 기존 서버를 재사용한 것인지를 함께 받습니다.
포트 충돌이면 어떤 프로세스가 잡고 있는지 보고하고 사용자가 결정하게 둡니다.

## 6. 스킬 유지보수

- skill directory와 frontmatter `name` 일치
- project-sensitive MCP 호출은 canonical project 또는 explicit scope 사용
- background “started”를 완료로 보고하지 않음
- mutation/background effect를 read-only lookup과 구분
- MCP schema 변경 시 reference와 regression test를 같은 변경에 포함
- Memex recall 결과를 learnable evidence로 바꾸지 않음
- installed runtime은 공통 `runtime-exec` 경계를 사용
