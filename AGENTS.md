# Memex contributor rules

Memex is a Codex-native, local-first long-term memory system. This file contains
repository-wide guardrails for humans and coding agents. Keep it short: detailed
behavior belongs in the owner documents under `docs/`.

## Core invariants

- `$CODEX_HOME/sessions` rollout JSONL is the default conversation source.
  Never modify source rollouts; archive/index/database state is derived.
- Canonical absolute `session_meta.cwd` is project identity. Do not infer
  project identity from basename, archive path, display name, or process cwd.
- Enforce project/global/all scope at every query, import, graph traversal, and
  relation-write boundary.
- Preserve exact fact provenance to source exchanges. Human assertions and
  allowlisted local repo/Git/test observations may be learnable; Memex recall,
  assistant synthesis, external/unknown output, and unverified generated output
  are searchable but not learnable evidence.
- Keep authoritative lineage (`source_exchange_ids`) separate from local,
  non-authoritative interpretive lineage (`fact_context_dependencies`). The
  semantic verifier reports context it actually used; server validation
  canonicalizes that set without promoting context to authority.
- Preserve `exchanges.rowid` on update. Extraction uses rowid watermarks.
- Extraction claim, fact/provenance writes, saved counts, and watermark advance
  must commit atomically or remain retryable.
- Model-backed work uses isolated local `codex exec` only. Default model:
  `gpt-5.6-luna`; override with `MEMEX_CODEX_MODEL`.
- Automatic lifecycle work must be bounded, retry-safe, and observable.

## Fact state and sync protocol v4

Treat durable fact state as independent axes:

- **semantic** — fact meaning/scope; guarded by `semantic_generation` and
  `semantic_updated_at`
- **lifecycle** — active/inactive; guarded by `lifecycle_generation` and
  `lifecycle_updated_at`
- **lineage** — `source_exchange_ids` and `consolidated_count`
- **local-derived** — KR text, ontology, relations, vectors, interpretive
  `fact_context_dependencies`

Do not collapse semantic and lifecycle into one clock.

Lineage is monotonic:

- `source_exchange_ids` → set union
- `consolidated_count` → max

This applies to both existing local facts and fresh remote inserts.

Protocol v4 durable payload contains only:

```text
facts.jsonl
fact-revisions.jsonl
fact-tombstones.jsonl
recall-events.jsonl
meta.json
```

`fact_kr`, ontology/category assignments, relations, and vectors are local
derived state and must not be synced as durable truth.

Import must validate the complete pinned generation before DB mutation:
required files, protocol/schema, row counts, identity, and SHA-256 manifest.
Reject a damaged generation as a whole.

Replicated lifecycle events preserve the remote event timestamp. Exact
lifecycle timestamp ties resolve to inactive. Privacy tombstones with
`reason = source_conversation_excluded` must not be resurrected by stale peers.

Local exports are serialized with SQLite `BEGIN IMMEDIATE`. Do not reintroduce a
cloud-synced lockfile or mtime-based stale-lock deletion.

## Async/CAS rules

Any model/embedding await can race with local mutation.

- Fact-derived async writers must capture semantic generation and reject stale
  results at commit time.
- Lifecycle-sensitive operations must also validate lifecycle generation/state.
- Consolidation verdicts require semantic + lifecycle CAS for participants.
- Exchange re-embedding uses content identity/hash revalidation.
- Taxonomy classification captures `taxonomy_state.epoch`; privacy purge bumps
  the epoch and invalidates stale classification work.
- Privacy purge resets surviving facts' ontology attempt ledger so they can be
  reclassified from the remaining public corpus.
- `scripts/translate-facts.mjs` is optional/manual local-derived work. Require
  exact batch shape and semantic CAS; discard stale translations. Do not make
  translation an automatic per-session cost without an explicit product change.

## Conversation and privacy boundaries

- Conversation exclusion markers are interpreted from user-role payloads, not
  arbitrary raw substrings in tool/assistant content.
- Compaction/replacement-history transport data is not fresh human evidence.
- Subagent/internal/Memex-worker conversations are not promoted to user
  knowledge.
- Memex's own data root, Codex sessions, and model workdirs must not become
  trusted repository evidence.
- If a composite tool result cannot be attributed safely, fail closed to
  non-learnable evidence.
- Conversation exclusion purges dependent derived knowledge and emits terminal
  privacy tombstones for removed facts.

## Storage and plugin boundaries

Data-root precedence:

1. `MEMEX_HOME`
2. `$XDG_CONFIG_HOME/memex`
3. `~/.config/memex`

Do not add legacy storage/other-agent compatibility without a new requirement.
Never silently move, merge, or delete user durable data.

Public plugin surfaces include `.codex-plugin/plugin.json`, `.mcp.json`,
`hooks.json`, `skills/`, and `cli/runtime-exec.js`.

- `memex setup` may disable Codex built-in `memories` only with interactive or
  explicit CLI approval, using Codex's own feature command.
- `setup-hooks` is an explicit fallback; do not enable it beside plugin-managed
  hooks.
- SessionStart jobs are independent async tasks with eventual consistency; do
  not rely on a fixed completion order.
- Web UI binds to loopback and uses the shared transactional fact service for
  mutations.

## Documentation ownership

Update the owner document in the same change when its behavior changes:

- `README.md`, `README-KR.md` — public overview / shortest path
- `docs/GUIDE.md` — installation and operations
- `docs/ARCHITECTURE.md` — architecture and boundaries
- `docs/CONVERSATION-LIFECYCLE.md` — ingestion and sync
- `docs/FACT-LIFECYCLE.md` — extraction and fact state
- `docs/KNOWLEDGE-GRAPH.md` — ontology and relations
- `docs/RETRIEVAL-AND-CONTEXT.md` — search and injection
- `docs/SCHEMA.md` — persisted schema/invariants
- `docs/MCP-AND-SKILLS.md` — MCP and skills
- `docs/VISUALIZATION.md` — Web UI
- `docs/VERIFICATION.md` — gates and receipts
- `docs/LINEAGE.md` — upstream/project lineage

Raw verification receipts are evidence for the run they record. Do not edit old
receipt values just to make them look current.

## Required checks

Runtime changes normally require:

```bash
npm run typecheck
npm run build
npm test
node --test test/codex-slice.test.mjs
node --test test/*slice.test.mjs
```

Run the nearest isolated E2E for installer/plugin/MCP/package/lifecycle/UI
changes. Never weaken a failing test to obtain green output. Unobserved behavior
is `NOT_PROVEN`, not `PASS`.

### Merge-gate receipt

1. Finish and commit code/tests/generated artifacts/owner docs.
2. Confirm a clean working tree.
3. Run the required gate on that committed SHA.
4. Write `docs/verification/merge-gate.json` with observed results and the exact
   `candidate.codeSha`.
5. Commit the receipt separately.

If packaged/public files change after the latest receipt and the final release
artifact should be considered fully verified, create a new clean baseline and
regenerate the receipt.
