# Memory Bank for Codex

Memory Bank turns local Codex rollout sessions into searchable long-term
memory. It archives user/assistant exchanges, indexes them with local
embeddings and FTS5, extracts durable facts with the Codex CLI, and exposes the
result through MCP tools and a local dashboard.

## What it provides

- Codex rollout ingestion from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
- subagent and harness-context exclusion
- semantic and text conversation search
- extracted facts, ontology relations, provenance, and cross-project insights
- prompt-time context injection and session-end extraction hooks
- nine MCP tools: `search`, `read`, `search_facts`, `search_ontology`,
  `ask_avatar`, `trace_fact`, `explore_graph`, `cross_project_insights`, and
  `graph_stats`
- a local dashboard on port 3847

All model-backed work runs through the locally authenticated Codex CLI. No API
key or external model SDK is used. The default model is `gpt-5.6-luna`.

## Requirements

- Node.js 22.15 or newer
- Codex CLI 0.149 or newer

## Build

```bash
cd /path/to/memory-bank-codex
npm install
npm run build
```

Nothing installs dependencies, registers MCP servers, or changes Codex config
automatically. If the built server or dependencies are absent, the launcher
prints the exact manual command and exits.

## Codex wiring

The native plugin bundle is described by `.codex-plugin/plugin.json` and uses:

- `.mcp.json` for the Memory Bank MCP server
- `hooks.json` for `SessionStart`, `UserPromptSubmit`, and `SessionEnd`
- `skills/` for historical search, whole-history analysis, and dashboard launch

For checkout-local development, open Codex in this repository so the committed
`.mcp.json` and root `hooks.json` are discovered. A personal plugin installation must
be added through a Codex marketplace; do not hand-edit Codex plugin cache files.

The complete local marketplace setup, plugin registration/removal, MCP and CLI
reference, hook lifecycle, extraction logic, data cleanup, and Mermaid architecture
diagrams are documented in the [Korean operations and architecture guide](docs/GUIDE-KR.md).

User-scope MCP-only registration is also possible:

```toml
[mcp_servers.memory-bank]
command = "node"
args = ["/absolute/path/to/memory-bank/cli/mcp-server-wrapper.js"]
```

## CLI

```bash
node cli/memory-bank.js sync
node cli/memory-bank.js search "React authentication"
node cli/memory-bank.js stats
node cli/memory-bank.js analyze
```

Data is stored under `~/.config/memory-bank` by default:

```text
conversation-archive/
conversation-index/db.sqlite
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `MEMORY_BANK_HOME` | Override the complete Memory Bank data root |
| `MEMORY_BANK_CONFIG_DIR` | Test alias for the data root |
| `XDG_CONFIG_HOME` | Places data at `$XDG_CONFIG_HOME/memory-bank` |
| `MEMORY_BANK_DB_PATH` | Override only the SQLite database path |
| `MEMORY_BANK_SESSIONS_DIR` | Override the Codex rollout root |
| `MEMORY_BANK_CODEX_MODEL` | Model for every Codex-backed operation; default `gpt-5.6-luna` |
| `MEMORY_BANK_CODEX_BIN` | Alternate Codex executable |
| `MEMORY_BANK_CODEX_EXEC_TIMEOUT_MS` | Per-call timeout; default 180000 ms |

## Model isolation

Every extraction, summary, consolidation, and translation call runs in an
isolated temporary directory with:

```text
codex exec --ephemeral --ignore-user-config --ignore-rules \
  --sandbox read-only --skip-git-repo-check -C <temporary-directory> \
  -m gpt-5.6-luna --json -
```

This prevents child rollout creation, plugin/hook recursion, user-config
coupling, and writes to the active repository.

## Verification

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
```

See `docs/SCHEMA.md` for the current database schema.

## License and origin

MIT. This Codex-native project is derived from
[`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank); see
`LICENSE` and Git history for attribution.
