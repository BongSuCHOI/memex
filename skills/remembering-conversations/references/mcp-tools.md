# Memex MCP tool reference

## Scope contract

All project-sensitive retrieval surfaces accept explicit stable project, workspace,
workstream, or session scope. A legacy project path remains a read-only compatibility
key. Omission returns a
structured validation error; there is no `process.cwd()` fallback.

```json
{
  "error": "search_facts: project is required for project-scoped queries",
  "expected": "canonical absolute Codex thread cwd, or scope: global|all"
}
```

## `search`

Conversation vector/text/hybrid retrieval.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string or string[2–5] | yes | array is multi-concept AND search |
| `mode` | `vector|text|both` | no | default `both`; ignored for query arrays |
| `project` | absolute path | no | scopes attached RAG facts to project + global |
| `project_id`, `workspace_id`, `workstream_id`, `session_id` | stable ID | conditional | ID matching `scope` |
| `scope` | `project|workspace|workstream|session|global|all` | no | stable raw-evidence filter; omitted keeps legacy all-project search |
| `limit` | 1–50 | no | default 10 |
| `after`, `before` | `YYYY-MM-DD` | no | date filters |
| `response_format` | `markdown|json` | no | default markdown |

## `read`

Read a confined archive file. `path` is required; `startLine` and `endLine` are
optional 1-indexed inclusive bounds. Prefer the result range from `search`.

## `search_facts`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `query` | string | yes | at least two characters |
| `project` | absolute path | conditional | legacy project-scope compatibility key |
| `project_id` | stable ID | conditional | project scope preferred identity |
| `workspace_id` | stable ID | conditional | required for workspace scope |
| `workstream_id` | stable ID | conditional | required for workstream scope |
| `session_id` | stable ID | conditional | required for session scope |
| `scope` | `project|workspace|workstream|session|global|all` | conditional | project is default |
| `category` | `decision|preference|pattern|knowledge|constraint` | no | filter |
| `include_revisions` | boolean | no | default false |
| `include_hot_evidence` | boolean | no | labeled raw evidence lane, default false |
| `hot_before`, `hot_before_evidence_id` | timestamp, ID | no | keyset cursor for Hot Evidence |
| `limit` | 1–50 | no | default 10 |

## `search_ontology`

Optional `domain`, `category`, and `include_relations` filters plus the common stable
identity scope contract. Returns Domain → Category → Fact hierarchy. Relation expansion
is filtered at every endpoint by the resolved scope.

## `ask_avatar`

`question` is required. Pass the common stable identity scope or explicit `global|all`. This is the
only tool that performs model-backed synthesis; it should cite retrieved facts
and state confidence.

## `trace_fact`

One of `query` (2–10000 chars), `fact_id` (UUID), or `subject_key` (`^[a-z0-9_.]{3,200}$`) is required;
`limit` is 1–10 (default 3). It accepts the same stable identity scope fields as `search_facts`.
Optional history controls: `include_timeline` (default true), `timeline_limit` 1–50 (default 10),
`timeline_cursor` (keyset cursor printed as `_Next timeline cursor: …_`), `timeline_order` `asc|desc`
(effective time), `include_incidents` (default true), `include_sources` (default true),
`include_hot_evidence` (default false).

Output lanes: `[CURRENT FACT]` (id, active flag, promotion, subject, semantic/lifecycle revision),
`Source Conversations [RAW EVIDENCE]`, `Interpretive Context (Non-Authoritative) [ASSISTANT CONTEXT-ONLY]`,
`Chronicle Timeline` of `[CHRONICLE EVENT]` rows (`ASSERTED|CHANGED|RETIRED|RESTORED|VALIDATED|INCIDENT|CONTRADICTED`,
`effective` vs `recorded` time, `projection changed` vs `event-only`, previous → new value, `reverts event`,
`grounded cause (source-cited)` separated from `classifier note (model inference, NOT authoritative)`,
per-event `[RAW EVIDENCE]` sources or `source unavailable (purged or missing)`), `Incidents` (occurrences and
matching signature patterns), and `Related Facts`. A `subject_key` with no current fact still returns its
historical events. A fact outside the requested scope is an error, never silently widened.

Example: `{"subject_key":"state.runtime.session_store","project_id":"<id>","timeline_limit":5}` then
`{"subject_key":"state.runtime.session_store","project_id":"<id>","timeline_limit":5,"timeline_cursor":"<cursor>"}`.

## `graph_stats`

Pass the common stable identity scope or explicit `global|all`. Returns scoped counts for active facts,
domains, categories, relations, revisions, category breakdown, and top domains.

## `cross_project_insights`

`query` plus either canonical absolute `current_project` or stable `current_project_id`
is required; `limit` is 1–20 with default 5. Results exclude that exact project.

## `explore_graph`

`query` is required, `hops` is 1–3 (default 2), and the common stable identity scope
is required. Scope is applied to the seed and every traversal hop.
