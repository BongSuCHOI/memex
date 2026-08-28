# Changelog

All notable changes to Memex are documented here. Dates use Asia/Seoul.

## Unreleased

### Added

- `memex home [--json]` prints the resolved data-root exact path.
- `memex backfill all` runs extract → ontology → embeddings sequentially in one
  command, stopping at first failure with idempotent-resume guidance.
- `memex setup --install-cli` / `--uninstall-cli`: opt-in POSIX shim at
  `~/.local/bin/memex` so the CLI works without an npx shell function. Only
  Memex-owned files are created or removed; PATH misses are reported per shell;
  `--dry-run` supported. No global installs, no user-project package-manager
  calls.
- Data-deletion walkthrough in docs/GUIDE.md covering full wipe, derived-only
  reset, scoped fact deletion, and rollout safety.

### Changed

- `memex-ui` now resolves its default SQLite root under
  `$XDG_CONFIG_HOME/memex` or `~/.config/memex`, matching the CLI.
- Onboarding docs (README.md, README-KR.md, docs/GUIDE.md) now present the
  one-time `setup --install-cli` shim as the default path to a terminal `memex`
  command and drop the npx shell-function workaround; clarified that in-session
  features need only plugin registration + Codex restart.
- Data root resolution uses `MEMEX_HOME`, then `$XDG_CONFIG_HOME/memex` and
  `~/.config/memex` as the default.
- `memex backfill <target>` now runs in the foreground by default with exit-code
  propagation; background execution is opt-in via `--background`, and
  `--foreground` is accepted as a deprecated no-op for older scripts.
- Documentation updated for the canonical root resolution order, foreground
  backfill, CLI shim onboarding, and deletion guide
  (README.md, README-KR.md, docs/GUIDE.md, docs/SCHEMA.md).

## 0.1.0 - 2026-08-27

First independent Memex release. Versioned `0.1.0` because the product feature
set is complete enough for public use while marketplace and Codex host-adapter
contracts remain intentionally pre-1.0.

### Product identity

- Public package, Codex plugin, MCP server, CLI, UI, installer, and dashboard
  skill use Memex naming.
- Promoted the Codex-native implementation from a conversion branch to the
  project's primary `main` line.
- Replaced conversion plans and superseded audits with maintainable product,
  architecture, lifecycle, schema, operations, lineage, and verification docs.

### Codex-native runtime

- Ingests only Codex rollout JSONL from `$CODEX_HOME/sessions` by default.
- Uses canonical absolute rollout cwd as project identity and collision-safe
  archive storage keys.
- Runs summaries, extraction, classification, consolidation, and synthesis
  through isolated local `codex exec`, defaulting to `gpt-5.6-luna`.
- Recognizes only current `memex` cache paths when validating a live sync-lock
  owner; pre-Memex package paths are not runtime ownership evidence.
- Adds a repository marketplace installable through `codex plugin marketplace
  add` and `codex plugin add`, with plugin-managed SessionStart,
  UserPromptSubmit, and SessionEnd hooks.
- Retains explicit fingerprinted hook setup/removal as a non-plugin fallback.
- Adds clone-free runtime launch through one `npx` source of truth targeting
  verified `main`, plus `memex update` for marketplace refresh and plugin
  reinstall without touching durable data.
- Adds `memex setup`, which detects Codex built-in `memories`, recommends
  disabling the conflicting second memory system, and changes it only after
  interactive or explicit CLI approval through Codex's own feature command.

### Knowledge system

- Conversation archive, vector/FTS/hybrid search, and deterministic full-history
  analysis.
- Incremental fact extraction with row-preserving watermarks, claim leases,
  confidence gates, retryable failure states, and self-ingestion exclusion.
- Adds durable per-event `memex_recall` prepared/emitted receipts and
  evidence-level tool provenance. Human and allowlisted repo/Git/test evidence
  remain learnable beside recall; Memex/external/unknown output and assistant
  synthesis stay searchable but cannot reinforce facts.
- Preserves new evidence IDs through duplicate/evolution consolidation so a
  trusted repository observation can supersede an older recalled fact.
- Duplicate, contradiction, and evolution consolidation with revision history.
- Domain/category ontology, typed relations, scoped multi-hop traversal,
  provenance, and cross-project insights.
- Project/global/all scope enforcement across MCP, CLI, import, graph traversal,
  Web UI, and context injection.
- Transparent bounded `.jsonl.zst` archive reads.

### Retrieval and interfaces

- Nine MCP tools: `search`, `read`, `search_facts`, `search_ontology`,
  `ask_avatar`, `trace_fact`, `explore_graph`, `cross_project_insights`, and
  `graph_stats`.
- Context injection with warm Unix-socket and cold local paths, relevance gate,
  one-hop relation expansion, per-session dedup ledger, and token budget.
- Transactional fact CLI/API operations with full-UUID hard-delete gating.
- Loopback Conversations, Facts, Pipeline Health, and live 3D Knowledge Galaxy
  interfaces, including empty-state and scoped graph handling.

### Verification

- Codex rollout fixtures cover main, resumed, subagent, tool-only, malformed,
  internal-context, worker, empty, and same-basename project cases.
- Added isolated lifecycle, installer, MCP, scope, security, browser, cleanup,
  and benchmark contracts.
- Restricted npm packages to an explicit public-file allowlist so local agent
  run state, token logs, and transient workspace artifacts cannot ship.
- Codex CLI 0.149.1 does not expose a formal `plugin validate` subcommand; the
  repository includes an isolated version-bound substitute and records this as
  `PASS-WITH-NOTES`, not as a formal-validator result.

## Pre-Memex history

The Claude-to-Codex adapter conversion and upstream feature-parity work were
completed before the 0.1.0 identity change. They are summarized in
[docs/LINEAGE.md](docs/LINEAGE.md); superseded plans and transient agent
receipts are intentionally not retained as user documentation.
