# Memex MCP tool reference

## Scope contract

Project-sensitive tools require a canonical absolute Codex thread cwd or an
explicit scope. Omission returns a structured validation error; there is no
`process.cwd()` fallback.

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
| `project` | absolute path | conditional | required for project scope |
| `scope` | `project|global|all` | conditional | project is default |
| `category` | `decision|preference|pattern|knowledge|constraint` | no | filter |
| `include_revisions` | boolean | no | default false |
| `limit` | 1–50 | no | default 10 |

## `search_ontology`

Optional `domain`, `category`, and `include_relations` filters plus the common
`project`/`scope` contract. Returns Domain → Category → Fact hierarchy.

## `ask_avatar`

`question` is required. Pass `project` or explicit `global|all`. This is the
only tool that performs model-backed synthesis; it should cite retrieved facts
and state confidence.

## `trace_fact`

`query` is required; `limit` is 1–10 (default 3). Pass `project` or explicit
scope. Returns revisions, source exchange IDs, archive paths, and line ranges.

## `graph_stats`

Pass `project` or explicit `global|all`. Returns scoped counts for active facts,
domains, categories, relations, revisions, category breakdown, and top domains.

## `cross_project_insights`

`query` and canonical absolute `current_project` are required; `limit` is 1–20
with default 5. Results exclude the current project.

## `explore_graph`

`query` is required, `hops` is 1–3 (default 2), and `project` or explicit scope
is required. Scope is applied to the seed and every traversal hop.
