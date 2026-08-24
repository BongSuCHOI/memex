# Changelog

## 1.5.0-codex.1

- Converted ingestion to native Codex rollout discovery and parsing.
- Replaced model SDK calls with isolated `codex exec` calls using
  `gpt-5.6-luna` by default.
- Added a native Codex plugin manifest, MCP configuration, hooks, skills, and
  commands.
- Moved all runtime data to `~/.config/memory-bank` with explicit overrides.
- Removed compatibility with other coding-agent plugins and their generated
  QA, marketing, deployment, and session artifacts.
- Added clean-start locking and idempotent resumed-session extraction.
