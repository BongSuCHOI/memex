# Memex contributor rules

Memex is a Codex-native, local-first personal knowledge system. Runtime code,
tests, documentation, examples, plugin metadata, and user-visible names must
describe Memex and Codex. The repository is an independent continuation of
earlier MIT-licensed memory-bank work; it is not a Claude Code compatibility
layer.

## Product invariants

- Treat `$CODEX_HOME/sessions` rollout JSONL as the only default conversation
  source. Test fixtures and explicit user overrides are the only exceptions.
- Never modify source Codex rollouts. Archives and indexes are derived local
  data and must remain rebuildable.
- Use canonical absolute `session_meta.cwd` as project identity. A storage
  directory name is never identity evidence.
- Project queries may see that project plus global facts. Global and all-project
  access must be explicit. Apply scope at every graph hop and import boundary.
- Preserve provenance from fact to source exchange and archive line range.
- Preserve evidence-level provenance: human assertions and allowlisted local
  repository/Git/test observations may be learnable; Memex recall,
  external/unknown output, and agent-generated synthesis remain searchable but
  are never learnable fact evidence. One recall must not taint sibling tools.
- Preserve rowids when updating exchanges. Extraction watermarks depend on
  `exchanges.rowid`; never use `INSERT OR REPLACE` there.
- Extraction claims, fact writes, saved counts, and watermark advancement must
  either commit together or remain retryable.
- Model-backed work runs only through the local Codex CLI. The default is
  `gpt-5.6-luna`; `MEMORY_BANK_CODEX_MODEL` remains the compatibility override.
- Headless model calls are ephemeral, read-only, isolated from repository rules
  and user plugins, and protected against recursive Memex invocation.

## Storage and compatibility

The public product name, package, plugin, MCP server, CLI, UI, and skills are
`memex`. Existing installations may already contain durable data under the
historical storage namespace. Until an explicit data migration is introduced,
retain this compatibility contract:

1. `MEMORY_BANK_HOME`
2. `MEMORY_BANK_CONFIG_DIR`
3. `$XDG_CONFIG_HOME/memory-bank`
4. `~/.config/memory-bank`

Do not silently move, copy, merge, or delete that data. Do not introduce new
legacy runtime adapters for Claude Code, OMC, Superpowers, or other agents.

## Plugin and lifecycle boundaries

- `.codex-plugin/plugin.json`, `.mcp.json`, `hooks.json`, `skills/`, and
  `cli/runtime-exec.js` are the public plugin surfaces.
- `memex setup` may recommend disabling Codex built-in `memories`, but may call
  `codex features disable memories` only after interactive or explicit CLI
  approval. Never edit the user's Codex TOML directly for this setting.
- Marketplace/plugin installation is an explicit user action. The plugin
  manifest declares `hooks.json`; it may resolve the latest
  `github:BongSuCHOI/memex#main` runtime through `npx` in npm's isolated cache.
  It must not run package-manager installs inside user projects, register
  plugins, install globally, or mutate user hook files merely because loaded.
- `setup-hooks` is a non-plugin-host fallback and merges only Memex-owned
  fingerprinted entries. Do not activate it together with plugin-managed hooks.
  `remove-hooks` removes only exact owned entries and preserves user hooks,
  Codex rollouts, and Memex data.
- SessionStart performs drift check, background sync, sync import, and bounded
  maintenance. UserPromptSubmit performs bounded context retrieval. SessionEnd
  waits for a stable main rollout before incremental extraction and export.
- The Web UI binds to loopback. Mutations use POST JSON, origin/content-type/body
  guards, and the same transactional fact-management service as the CLI.

## Documentation ownership

- `README.md`: public overview and shortest successful path.
- `README-KR.md`: Korean overview matching the same product contract.
- `docs/GUIDE.md`: installation through removal and troubleshooting.
- `docs/ARCHITECTURE.md`: component boundaries and end-to-end data flow.
- `docs/SCHEMA.md`: persisted schema and database invariants.
- `docs/CONVERSATION-LIFECYCLE.md`: rollout ingestion and hook lifecycle.
- `docs/FACT-LIFECYCLE.md`: extraction, consolidation, revision, and deletion.
- `docs/KNOWLEDGE-GRAPH.md`: ontology, relation, traversal, and scope rules.
- `docs/RETRIEVAL-AND-CONTEXT.md`: search, RAG, injection, and dedup budgets.
- `docs/VISUALIZATION.md`: Web UI and 3D Galaxy contracts.
- `docs/MCP-AND-SKILLS.md`: MCP tool and skill usage contracts.
- `docs/LINEAGE.md`: upstream attribution and host-adapter migration history.
- `docs/VERIFICATION.md`: reproducible quality gates and version boundaries.

When behavior changes, update its owner document in the same change. Historical
plans, superseded failure reports, and one-off agent ledgers do not belong in
the public documentation tree.

## Skill rules

Every directory under `skills/` must contain a `SKILL.md` whose frontmatter
`name` exactly matches the directory name. A skill must resolve the installed
plugin root, use current `memex`/MCP surfaces, state mutation and scope effects,
and never claim a background operation has completed without observing it.
Keep detailed tool schemas in `skills/remembering-conversations/references/mcp-tools.md`
and link to it instead of copying drifting schemas across skills.
After changing a skill, run the `skill-creator` `quick_validate.py` helper for
that skill and then validate the installed plugin artifact so discovery is
checked in both the source tree and Codex cache layout.

## Required checks

Runtime changes normally require:

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
node --test test/*slice.test.mjs
```

Manifest, hook, MCP, installer, or UI changes also require the nearest isolated
end-to-end script and complete cleanup of temporary registrations, processes,
databases, sockets, listeners, and caches. Use the formal Codex plugin validator
when available; otherwise report the CLI version and run the repository's
version-bound substitute without representing it as the formal validator.

Never weaken or delete a failing test to obtain green output. Never report
`PASS` for an unobserved behavior; use `NOT_PROVEN` and name the missing proof.
