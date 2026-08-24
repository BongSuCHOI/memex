# Memory Bank for Codex

> Conversations → Knowledge Graph. Your local **Codex** session rollouts become searchable, structured knowledge: facts, ontology relations, RAG search, and automatic context injection.

This fork strips every Claude/Anthropic runtime dependency. The LLM backend for fact extraction, summarization, consolidation, and translation is the locally installed **codex CLI** (CodexExec provider) — authenticated by your existing Codex login, no API keys.

## Features

- **Rollout ingestion** — recursive discovery of `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`; turns assembled from `response_item.message` (user/assistant) and `custom_tool_call` / `function_call`; `reasoning`, developer/system records, and harness context blocks are never indexed.
- **Subagent isolation** — threads flagged by `session_meta.parent_thread_id` or subagent sources are skipped end-to-end.
- **Knowledge graph** — domain/category ontology with typed relations (INFLUENCES / SUPPORTS / SUPERSEDES / CONTRADICTS).
- **RAG search** — vector search (384-dim, local embeddings) + FTS5, enriched with related facts.
- **Context injection** — relevant past decisions prepended to prompts on session start/prompt boundaries.
- **MCP server** — `search`, `read`, `search_facts`, `search_ontology`, `ask_avatar`, `trace_fact`, `explore_graph`, `cross_project_insights`, `graph_stats`.

## Requirements

| Tool | Version |
|---|---|
| Node.js | ≥ 22.15 (built-in zstd) |
| codex CLI | ≥ 0.149 (`codex exec --ephemeral --ignore-user-config …` flags) |

## Install

```bash
git clone --branch codex-only https://github.com/BongSuCHOI/memory-bank.git
cd memory-bank
npm install
npm run build          # tsc && esbuild bundle into dist/
```

Nothing installs itself behind your back: the MCP launcher (`cli/mcp-server-wrapper.js`) and the prompt injector fail loudly with the exact commands above when dependencies are missing.

### Register the MCP server

Project scope — commit at repo root (`.mcp.json`):

```json
{ "mcpServers": { "memory-bank": { "command": "node", "args": ["cli/mcp-server-wrapper.js"] } } }
```

or user scope in `~/.codex/config.toml`:

```toml
[mcp_servers.memory-bank]
command = "node"
args = ["/absolute/path/to/memory-bank/cli/mcp-server-wrapper.js"]
```

### Hooks

The repo-root [`hooks.json`](hooks.json) is a default discovery target for Codex sessions opened in this checkout. It wires `SessionStart` (version check + background sync + non-blocking maintenance), `UserPromptSubmit` (context injection), and `SessionEnd` (stabilized fact extraction → export). First invocation asks you to trust each command hash.

## Quick Start

```bash
node cli/memory-bank.js sync      # archive + index new rollouts
node cli/memory-bank.js search "React auth"
node cli/memory-bank.js stats
```

## Environment

| Variable | Meaning |
|---|---|
| `MEMORY_BANK_CODEX_MODEL` | Model forwarded to `codex exec -m`. Default: **gpt-5.6-luna**. Legacy `MEMORY_BANK_FACT_MODEL` overrides only the fact-extraction path. |
| `MEMORY_BANK_CODEX_BIN` | Alternate codex binary (default `codex` on PATH). |
| `MEMORY_BANK_CODEX_EXEC_TIMEOUT_MS` | Per-call timeout (default 180000). |
| `MEMORY_BANK_SESSIONS_DIR` / `TEST_SESSIONS_DIR` | Override rollout discovery root. |
| `MEMORY_BANK_STABILIZE_*_MS` | SessionEnd transcript stabilization tuning. |

## Safety contract (LLM calls)

Every extraction/summary call runs:

```
codex exec --ephemeral --ignore-user-config --ignore-rules \
           --sandbox read-only --skip-git-repo-check -C <mktemp> [-m <model>] --json -
```

`--ephemeral` writes no child rollout; `--ignore-user-config` prevents plugin/hook recursion; the throwaway workdir keeps your repositories untouched; a process-group kill enforces timeouts. Nested invocations refuse via `MEMORY_BANK_CODEX_EXEC_INNER`.

## Verification

Dependency-free behavior suite (no install needed):

```bash
node --test test/codex-slice.test.mjs
```

Full typecheck/build/vitest requires the install step above. Dynamic gates still pending validation on this fork: real `codex plugin add` against `.codex-plugin/plugin.json`, live hook dispatch inside a Codex session, and end-to-end extraction against a genuine rollout.

## License

MIT — see upstream [jung-wan-kim/memory-bank](https://github.com/jung-wan-kim/memory-bank) for the original project and history.
