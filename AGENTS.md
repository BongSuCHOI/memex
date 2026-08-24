# Memory Bank contributor rules

This repository is a Codex-native plugin. Runtime code, tests, documentation,
and examples must target Codex rollouts and Codex plugin conventions only.

## Runtime contract

- Read conversations only from `$CODEX_HOME/sessions` unless a documented
  Memory Bank test or user override is supplied.
- Store plugin data below `MEMORY_BANK_HOME`, `MEMORY_BANK_CONFIG_DIR`,
  `$XDG_CONFIG_HOME/memory-bank`, or `~/.config/memory-bank` in that order.
- Run every model-backed operation through the local Codex CLI. The default
  model is `gpt-5.6-luna`; `MEMORY_BANK_CODEX_MODEL` is the only model override.
- Keep headless model calls ephemeral, read-only, isolated from user config and
  repository instructions, and protected from recursive plugin invocation.
- Do not add compatibility paths for Claude Code, OMC, Superpowers, or other
  coding-agent plugins.
- Do not install dependencies or register plugins automatically.

## Required checks

Run checks in proportion to the change. Runtime changes normally require:

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
```

Plugin manifest changes also require the Codex plugin validator. Hook, MCP, or
dashboard changes require one isolated end-to-end check and cleanup of every
temporary registration, process, database, and cache created by that check.
