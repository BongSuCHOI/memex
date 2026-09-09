# Memex

[![Release](https://img.shields.io/badge/release-0.5.2-2563eb)](CHANGELOG.md)
[![Codex](https://img.shields.io/badge/Codex-native-111827)](https://developers.openai.com/codex/)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.15-339933)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

> A local-first long-term memory layer for Codex: collect conversations, distill durable facts, connect them, and bring the right context back when it matters.

![Memex Workspace overview: pipeline readiness, recent memory changes, and scope-aware activity metrics](assets/readme/overview.png)

Memex turns local Codex session history into a searchable conversation archive, durable facts, a scoped knowledge graph, and bounded context that can be recalled in later work. It is designed as a **memory system**, not a second agent — Codex remains the working agent; Memex provides the persistent layer around it.

[한국어 README](README-KR.md) · [Documentation](docs/README.md) · [Operations guide](docs/GUIDE.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md)

### What it does

- **Archives conversations** — searchable snapshots of Codex rollouts, with hybrid semantic + FTS5/BM25 retrieval, without modifying the originals.
- **Distills durable facts** — reusable decisions, preferences, patterns, knowledge, and constraints, each bound to the exchange that proves it.
- **Tracks how facts evolve** — duplicate consolidation, contradictions, revisions, deactivation, restoration, and provenance.
- **Connects and recalls** — classifies facts into domains/categories with typed relations, and injects small, relevance-gated memory blocks into later Codex prompts.
- **Shows its work** — a loopback Web UI, nine MCP tools, and durable multi-device sync of fact state only.

---

## Why Memex

**Local-first.** Source Codex rollouts stay read-only. The primary database, indexes, derived graph, and operational logs live under the local Memex data root; the archive and DB are a rebuildable local layer.

**Evidence-bound memory.** A fact is not a summary. `source_exchange_ids` holds only exact authoritative human or trusted local-tool exchanges; the separate local `fact_context_dependencies` records the long-range non-authoritative context needed to *interpret* a fact and is never promoted to authority. The Web UI and `trace_fact` render the two lanes apart.

**Honest observability.** Missing data is reported as not-collected, never folded into `0`: unobserved token usage reads `null` / `NOT_PROVEN`, partially observed reads `partial`. "Context was provided" is recorded as exactly that, and is not evidence that the model used it in its answer.

**No model work without an explicit action.** Capture hooks perform bounded local I/O only. Opening a Web UI page never starts model work; automatic maintenance resumes unfinished work only when its cooldown and shared rolling call cap permit.

**Project isolation.** Memex resolves the canonical absolute `session_meta.cwd` to a local workspace and uses a stable `project_id` for logical identity. Search, related facts, tracing, and every graph hop share the same scope, and the MCP server never infers project identity from its own process cwd.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md), [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md), and [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md).

---

## Quick start

**Requirements** — Node.js 22.15+, an authenticated Codex CLI, and macOS or Linux for the current hook / Unix-socket runtime.

```bash
# 1. install the plugin, then restart Codex so hooks, skills and the MCP server load
codex plugin marketplace add BongSuCHOI/memex
codex plugin add memex@memex

# 2. optional: a `memex` command in your own terminal (creates ~/.local/bin/memex,
#    not a global npm install)
npx --yes --package=github:BongSuCHOI/memex#main memex setup --install-cli

# 3. prepare the existing Codex history
memex setup          # check for conflicts with Codex built-in Memory
memex sync           # archive and index eligible $CODEX_HOME/sessions rollouts
memex backfill all   # durable fact extraction, ontology, missing embeddings
memex status         # readiness and remaining backlog

# 4. open the local workspace at http://127.0.0.1:3847
npx --yes --package=github:BongSuCHOI/memex#main memex-ui

# 5. ask for something you already worked on — in Codex, the bundled skills
#    reach for the Memex MCP tools; the same lookup from a shell is:
memex search "why did we choose SQLite?"
```

`memex setup` never disables Codex built-in Memory without explicit approval. All backfill stages are idempotent.

Memex uses native SQLite, vector, and embedding dependencies. Installation materializes them beside the plugin and the launcher runs that same installed artifact first; an isolated npm cache is used only for the MCP server and for the `npx` fallback that a not-yet-materialized plugin registration takes. Neither path installs dependencies into your project or requires a source checkout for normal use.

For local marketplace development and source-based validation, see the [operations guide](docs/GUIDE.md).

---

## Web UI

The workspace is plain server-side CommonJS plus ES modules served to the browser — no separate frontend build and no extra npm package. It binds to `127.0.0.1` only, validates `Host`/`Origin`, and requires a CSRF token for writes. Fact mutations use the same transactional service as the CLI. Set `PORT` to use another port.

```bash
npx --yes --package=github:BongSuCHOI/memex#main memex-ui
# http://127.0.0.1:3847
```

| Page | Covers |
| --- | --- |
| `/` overview | pipeline readiness, recent memory changes, activity |
| `/conversations` conversation ledger | sessions, exchanges, source text |
| `/facts` memory | facts, revisions, authoritative provenance, interpretive context, guarded edit/deactivate/restore/delete |
| `/taxonomy` classification | ontology domains and categories |
| `/graph` knowledge map | WebGL 2D/3D relation graph with a Canvas2D fallback |
| `/activity` chronicle | jobs, model attempts, recalls, logs, admin runs |
| `/settings` administration | runtime, admin commands, display preferences, diagnostics |

Every page takes an explicit scope: one project, global memory, or all projects. Opening a page never starts model work.

![Fact detail drawer on the evidence tab, showing direct evidence and interpretive context as separate sections](assets/readme/facts-detail.png)

*Memory detail, evidence tab — direct evidence and interpretive context stay in separate lanes, with the verification receipt below them.*

![Knowledge map in 2D with one node selected and its typed relations highlighted](assets/readme/graph.png)

*Knowledge map — fact nodes and typed relations (`SUPPORTS`, `INFLUENCES`, `SUPERSEDES`, `CONTRADICTS`) drawn with browser-native WebGL. Layout encodes domain grouping only; on-screen distance is **not** an embedding-similarity number.*

![Jobs tab of the activity page with one durable job expanded into its target, inputs and model attempts](assets/readme/activity-jobs.png)

*Activity · tracking, processing jobs — one durable job expanded down to its extraction target, input versions, and model attempts.*

<details>
<summary>Dark mode</summary>

![The same overview page rendered in dark mode](assets/readme/overview-dark.png)

</details>

The Web UI is not an authentication, TLS, or multi-tenant isolation service; do not port-forward or publicly deploy it. See [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md).

---

## How it works

```mermaid
flowchart TB
    subgraph Codex[Codex]
      Rollouts[Session rollouts]
      Hooks[Lifecycle hooks]
      MCP[MCP + skills]
    end

    subgraph Core[Memex core]
      Archive[Archive / index]
      Extract[Fact extraction]
      Reconcile[Fact reconciliation]
      Retrieve[Retrieval / injection]
      Graph[Ontology / relations]
    end

    subgraph Durable[Durable state]
      Facts[(Facts)]
      Revisions[(Fact revisions)]
      Tombstones[(Fact tombstones)]
      Recall[(Recall receipts)]
    end

    subgraph Local[Local derived state]
      Exchanges[(Conversation index)]
      Vectors[(FTS / vectors)]
      KR[(KR translations)]
      Ontology[(Ontology / relations)]
    end

    Rollouts --> Archive
    Archive --> Exchanges
    Exchanges --> Extract
    Extract --> Facts
    Facts --> Reconcile
    Reconcile --> Revisions
    Reconcile --> Tombstones
    Facts --> Graph
    Graph --> Ontology
    Facts --> Vectors
    Facts --> KR
    Exchanges --> Retrieve
    Facts --> Retrieve
    Ontology --> Retrieve
    Retrieve --> Hooks
    Retrieve --> MCP
    Hooks --> Recall
```

### Fact state model

Sync protocol v4 separates fact state into independent axes:

| Axis | Examples | Merge rule |
| --- | --- | --- |
| **Semantic** | fact text, category, scope | semantic event clock + deterministic tie-break |
| **Lifecycle** | active / inactive | lifecycle event clock; inactive wins exact ties |
| **Lineage** | source exchange IDs, consolidated count | monotonic union / max |
| **Derived overlay** | KR text, ontology, relations, vectors | local-only, rebuildable |

This separation matters because editing a fact and deactivating it are different events. A newer semantic edit must not accidentally undo a newer deactivation, and provenance must never disappear just because another device has an older snapshot.

### Scope and consolidation

Supported fact/query scopes are **project** (project-wide truth plus global facts where appropriate), **workspace/workstream/session** (the selected work scope and permitted parent truth), **global** (global facts only), and **all** (explicit cross-project access).

Read scope and consolidation permission are separate. Consolidation preserves different workstreams and promotion states, adopts only verified input wording, and leaves ambiguous legacy identity for review. Existing data can be [backed up, audited, and selectively repaired](docs/GUIDE.md#16-기억-정합성-감사와-선별-복구) without re-extracting every fact.

### Recall without self-training loops

Recalled memory must not become fresh evidence merely because Codex repeated it. Memex distinguishes human assertions, trusted local repository / Git / test observations, external or unverifiable tool output, Memex recall, and assistant-generated synthesis. The last two remain searchable but are never treated as new durable fact evidence, which prevents:

```text
old fact → recalled into prompt → assistant repeats it → repeated text extracted as a "new" fact
```

Recall events are recorded as durable provenance receipts before context is emitted.

### Privacy and exclusion

A user-role `DO NOT INDEX` marker excludes the whole conversation from the Memex knowledge corpus. The privacy purge removes or invalidates exchanges and tool-call index state, FTS/vector rows, extraction/recall processing state, facts that depended on the excluded conversation as authoritative evidence or persisted interpretive context, fact-derived revisions/relations/vectors, and the local taxonomy derived from the previous corpus. Facts removed this way receive a terminal privacy tombstone so an older device snapshot cannot resurrect them; surviving public facts are reclassified from the remaining evidence.

### Multi-device sync

Protocol v4 exports one committed generation per local device, containing `facts.jsonl`, `fact-revisions.jsonl`, `fact-tombstones.jsonl`, `recall-events.jsonl`, and a `meta.json` recording the protocol version, device/generation identity, row counts, and SHA-256 integrity for each payload file. Imports pin and validate an entire generation before mutating SQLite: missing files, hash mismatches, invalid JSON, or schema-invalid rows reject that device generation as a whole. Local exporters are serialized with SQLite's process-owned `BEGIN IMMEDIATE` transaction, so a slower export cannot move `CURRENT` back to an older snapshot and no cloud-synced lockfile is required. KR translations, ontology categories, relations, and vector indexes are rebuilt locally instead.

Deep dives: [ARCHITECTURE.md](docs/ARCHITECTURE.md) · [CONVERSATION-LIFECYCLE.md](docs/CONVERSATION-LIFECYCLE.md) · [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md) · [RETRIEVAL-AND-CONTEXT.md](docs/RETRIEVAL-AND-CONTEXT.md) · [SCHEMA.md](docs/SCHEMA.md)

---

## Usage

```bash
memex search "why did we choose SQLite?"
memex search --both "authentication migration"
memex facts list
memex stats
memex analyze --top 30 --out ~/memex-report.md
memex status
```

| Command | Purpose |
| --- | --- |
| `memex sync` | Archive and index new Codex rollouts |
| `memex search` | Semantic, text, or hybrid conversation search |
| `memex show` | Read one archived conversation |
| `memex stats` | Inspect corpus/index statistics |
| `memex analyze` | Generate a deterministic history report |
| `memex facts` | Inspect and manage durable facts |
| `memex backfill` | Run extraction / ontology / embedding backlog work |
| `memex model-work status` | Inspect model attempts, observed usage, and pending work; [bounded resume](docs/GUIDE.md#17-모델-작업-예산과-대기-진단) |
| `memex status` | Inspect pipeline readiness |
| `memex doctor` | Diagnose runtime, plugin, MCP, and lifecycle state |
| `memex update` | Refresh the marketplace/plugin while preserving data |

Fact management includes edit, deactivate, restore, history, and guarded hard-delete operations. Semantic edits keep fact identity and revision history while invalidating stale derived state.

Foreground backfill exits `0` only when no processable, active, or unresolved work remains. If a bounded run leaves retryable backlog for a later wake, it reports `completed with deferred work`, prints the post-run count for each selected stage, and exits `2`. Active claims or terminal extraction failures are also reported as outstanding work with exit `2`. A worker failure takes precedence, stops later stages, and exits `1`.

See [GUIDE.md](docs/GUIDE.md) for the complete CLI and lifecycle reference.

### MCP tools and skills

Memex exposes nine MCP tools:

| Tool | Purpose |
| --- | --- |
| `search` | Search past conversations |
| `read` | Read archived source text / line ranges |
| `search_facts` | Search distilled facts |
| `search_ontology` | Browse facts by domain/category |
| `ask_avatar` | Synthesize an answer from stored evidence |
| `trace_fact` | Trace current fact → Chronicle timeline → source evidence |
| `explore_graph` | Traverse 1–3 relation hops |
| `cross_project_insights` | Find comparable solutions in other projects |
| `graph_stats` | Inspect graph size and health |

Project-sensitive tools require either a stable project/workspace/workstream/session ID or a legacy canonical absolute project path, `scope: global`, or `scope: all`.

Three bundled Codex skills cover remembering conversations, analyzing all conversations, and opening the Memex dashboard. See [MCP-AND-SKILLS.md](docs/MCP-AND-SKILLS.md).

### Automatic lifecycle

| Event | Memex behavior |
| --- | --- |
| **SessionStart(startup/resume)** | resolve session state, recover the durable queue, then run independent background sync/import/maintenance |
| **SessionStart(clear/compact)** | advance `context_epoch`; compact immediately returns a bounded Capsule/current-fact bundle |
| **UserPromptSubmit** | scoped retrieval and bounded context injection; separate asynchronous maintenance wake check |
| **Stop** | append only new complete transcript bytes and commit a closed-turn fence |
| **Interrupt** | append delta and preserve an interrupted/open fence |
| **PreCompact** | fsync the journal, freeze carry candidates, and atomically commit checkpoint + outbox |
| **PostCompact** | optional telemetry only; correctness never depends on it |
| **SessionEnd** | final delta + final fence + durable jobs; no foreground model, embedding, extraction, or export |

The durable worker queue runs capture indexing first, Work Capsule updates second, and fact/derived work afterward. SessionStart background jobs remain eventually consistent; each writer owns its transaction/CAS safety.

### Data location

Resolution order is `MEMEX_HOME`, then `$XDG_CONFIG_HOME/memex`, then `~/.config/memex`.

```text
~/.config/memex/
├── conversation-archive/
├── conversation-index/
│   ├── db.sqlite
│   ├── sync/
│   └── logs/
├── ui/
│   └── operations.json
└── logs/
    └── ui-audit.jsonl
```

`ui/operations.json` keeps metadata for admin commands the Web UI ran, and `logs/ui-audit.jsonl` is its audit trail; both record metadata only, never conversation text, fact text, or command output. The original `$CODEX_HOME/sessions` rollouts are always treated as read-only input. Run `memex home` (or `memex home --json`) before deleting or moving Memex data.

---

## Configuration

| Variable | Effect |
| --- | --- |
| `MEMEX_HOME` | Memex data root; highest-precedence override |
| `XDG_CONFIG_HOME` | Fallback root: `$XDG_CONFIG_HOME/memex` |
| `MEMEX_DB_PATH` | Overrides the index DB path independently of the data root |
| `CODEX_HOME` | Codex home; `$CODEX_HOME/sessions` is the read-only rollout source |
| `MEMEX_AUTO_ONTOLOGY` | Automatic ontology is on by default; `0` disables it |
| `MEMEX_STRICT_CAPTURE` | `1` makes a capture hook fail instead of recording a capture gap |
| `PORT` | Web UI port (default `3847`) |

Automatic ontology stays available through manual `memex backfill ontology`, and existing derived data and core embeddings remain in place when it is disabled.

Model work is budgeted per run ([GUIDE §17](docs/GUIDE.md#17-모델-작업-예산과-대기-진단)):

| Setting | Default | Actual limit |
| --- | --- | --- |
| `MEMEX_MODEL_BUDGET_MAX_ATTEMPTS` | `64` | provider attempts within one work run |
| `MEMEX_MODEL_BUDGET_DEADLINE_MS` | `900000` | deadline for the whole run |
| `MEMEX_CODEX_EXEC_TIMEOUT_MS` | `180000` | per-call timeout; never longer than the run's remaining time |
| `MEMEX_MODEL_BUDGET_MAX_INPUT_CHARS` | `120000` | UTF-16 characters of call input |
| `MEMEX_MODEL_BUDGET_MAX_OUTPUT_CHARS` | `16000` | characters of the final answer; domain schema/field validation applies on top |
| `MEMEX_AUTO_MODEL_MAX_ATTEMPTS` | `256` | shared 24-hour call cap for automatic maintenance in one data root; `0` blocks it |

Token counts are provider observations. Unobserved usage is `null` / `NOT_PROVEN` and partially observed usage is `partial`; missing usage and dollar cost are never estimated as zero.

Optional Korean fact translations (`fact_kr`) are local derived state, intentionally not synced and not generated on every session, so lifecycle hooks never pay translation-model cost. From a source checkout they can be filled manually with `node scripts/translate-facts.mjs`, which records a translation only if the fact meaning is unchanged since the request began.

---

## Verification and releases

The repository keeps the release gate separate from implementation commits. The current verified code baseline is recorded in [`docs/verification/merge-gate.json`](docs/verification/merge-gate.json), which holds the committed candidate SHA, environment, exact gate results, hard-safety results, and any retained notes. Do not infer current verification from numbers copied into an owner document.

A required gate is FAIL if any required item is FAIL; unobserved behavior is never marked PASS by inference. For the full acceptance model, version boundaries, and retained machine receipts, see [VERIFICATION.md](docs/VERIFICATION.md).

---

## Contributing

```bash
git clone https://github.com/BongSuCHOI/memex.git
cd memex
npm install
npm run build          # tsc + esbuild bundle
npm test               # vitest
npm run typecheck
node --test ui/test/*.test.cjs          # Web UI service/HTTP contracts
node scripts/web-ui-browser-e2e.mjs     # real headless-Chrome UI gate
MEMEX_PLUGIN_ROOT="$PWD" node ui/server.cjs   # run the Web UI from a checkout
```

Read [AGENTS.md](AGENTS.md) before changing behavior — it defines repository invariants, verification rules, and documentation ownership. When a public command, persisted field, lifecycle rule, MCP schema, or release contract changes, update its owner document in the same change.

The documentation set is organized by ownership rather than as one large manual; start from [docs/README.md](docs/README.md).

| Document | Covers |
| --- | --- |
| [GUIDE.md](docs/GUIDE.md) | installation, onboarding, CLI, lifecycle, uninstall |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | system boundaries and end-to-end flow |
| [CONVERSATION-LIFECYCLE.md](docs/CONVERSATION-LIFECYCLE.md) | rollout parsing, archive/index, sync protocol |
| [FACT-LIFECYCLE.md](docs/FACT-LIFECYCLE.md) | extraction, consolidation, semantic/lifecycle state |
| [KNOWLEDGE-GRAPH.md](docs/KNOWLEDGE-GRAPH.md) | ontology, relations, traversal |
| [RETRIEVAL-AND-CONTEXT.md](docs/RETRIEVAL-AND-CONTEXT.md) | search, RAG, context injection |
| [SCHEMA.md](docs/SCHEMA.md) | SQLite schema and transaction invariants |
| [MCP-AND-SKILLS.md](docs/MCP-AND-SKILLS.md) | MCP tools and bundled skills |
| [WEBUI-WORKSPACE.md](docs/WEBUI-WORKSPACE.md) | local Web UI pages, scope model, knowledge map |
| [CONTINUITY.md](docs/CONTINUITY.md) | lifecycle/journal/outbox/worker, Capsule, identity, Chronicle as built |
| [VERIFICATION.md](docs/VERIFICATION.md) | tests, E2E gates, release evidence |
| [LINEAGE.md](docs/LINEAGE.md) | upstream attribution and project lineage |

---

## Lineage and license

Memex is an independent Codex-native project derived from the MIT-licensed [`obra/episodic-memory`](https://github.com/obra/episodic-memory) and [`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank). It preserves the knowledge-system ideas while replacing the previous host adapter with Codex-native rollout, hook, plugin, MCP, and model-execution contracts. See [LINEAGE.md](docs/LINEAGE.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT. See [LICENSE](LICENSE).
