# Memory Bank — Codex Project Profile

Codex-only fork of the conversation-memory plugin. Every runtime path below is grounded in this checkout; historical notes live in CHANGELOG.md and upstream history.

## Surfaces

| Area | Files | Notes |
| --- | --- | --- |
| Rollout ingestion | `src/codex-rollout.ts` | Recursive `$CODEX_HOME/sessions` discovery, turn assembly (`response_item.message` user/assistant + `custom_tool_call`/`function_call`), reasoning/system/harness-context exclusion, subagent flagging via `session_meta.parent_thread_id`/source, malformed-line tolerance, cheap `readRolloutMeta`. |
| Parser facade | `src/parser.ts` | Legacy `parseConversation` API delegating to the rollout parser; `.zst` archives still supported on read. |
| Sync pipeline | `src/sync.ts`, `src/sync-cli.ts`, `src/indexer.ts` | Flat rollout walk; project key = basename of `session_meta.cwd`; archive keeps `<project>/<file>.jsonl`; DB contracts unchanged; partial transcripts stay retryable (no marker until exchanges exist). |
| LLM provider | `src/codex-exec.ts`, `src/llm.ts`, `src/summarizer.ts` | All extraction/summary/translation calls run `codex exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --skip-git-repo-check -C <mktemp> [-m MODEL] --json -`. Default model: `gpt-5.6-luna` (`DEFAULT_CODEX_MODEL`). No Anthropic SDK anywhere. |
| Plugin wiring | `.codex-plugin/plugin.json`, `.mcp.json`, `hooks.json` | Manifest uses validator-observed fields only (incl. required `interface`, `mcpServers: "./.mcp.json"`). Root hooks.json wires SessionStart / UserPromptSubmit / SessionEnd. |
| Session start maintenance | `scripts/session-start-maintenance.js` | Non-blocking: consolidation worker + re-embed/ontology/extraction backlog resume. No stdout context; context injection belongs to UserPromptSubmit inject-context. |
| Session end | `scripts/session-end-hook.js`, `scripts/hook-stdin.js` | Defensive stdin keys, transcript stabilization wait, empty/subagent guard before any worker spawn, foreground worker with success-line evidence (`worker: session=<id> extracted=<n> saved=<n>`; ERROR/FATAL/SKIPPED blocks), export strictly after evidence. No auto-installs anywhere. |

## Commands

```bash
npm install          # manual, explicit — nothing self-installs
npm run build        # tsc && esbuild bundle into dist/
npm test             # vitest suite (needs install)
node --test test/codex-slice.test.mjs   # dependency-free behavior suite (runs without install)
```

## Conventions

- ESM (`"type": "module"`): local imports keep `.js` extensions for tsc output; the two new core modules are erasable-syntax TS so Node ≥23 strip-types can run them directly for tests.
- Malformed JSONL lines are skipped per line; a transcript that yields zero exchanges is never treated as processed.
- Model precedence: explicit option → `MEMORY_BANK_CODEX_MODEL` → `DEFAULT_CODEX_MODEL` (gpt-5.6-luna). Legacy `MEMORY_BANK_FACT_MODEL` overrides only the fact-extraction path (llm.ts), before the default.

## Verification gates

1. `node --test test/codex-slice.test.mjs` — no-install gate (parser/discovery/provider/hooks/wrapper behavior).
2. Post-install: `tsc --noEmit`, `npm run build`, `npm test`.
3. Pending dynamic validation: real `codex plugin add` against `.codex-plugin/plugin.json`, live hook dispatch inside codex-cli 0.149, end-to-end extraction on genuine rollouts.

Historical author QA artifacts under `.autoresearch/`, `.omc/`, `video/`, `vercel/`, `bench/`, and most of `.codex/` are preserved as-is and are not part of the runtime contract.
