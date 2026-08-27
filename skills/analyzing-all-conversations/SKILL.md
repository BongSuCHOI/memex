---
name: analyzing-all-conversations
description: Produce a coverage-checked report of the entire Memex conversation corpus when the user asks to analyze, organize, or summarize all Codex history. Use deterministic totals first and label unfinished backfill honestly.
---

# Analyzing All Conversations

Resolve `PLUGIN_ROOT` as two directories above this skill directory.

## Establish coverage

Run the deterministic, read-only report before interpreting the corpus:

```bash
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex analyze --json
```

Use its conversation/session/exchange/project/date totals, extraction and
summary coverage, fact counts, domains, project rollups, timeline, and
recommendations. Never recreate those numbers from sampled search results.

## Close or disclose gaps

If requested and recommended by the report, start only the relevant explicit
backfill:

```bash
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex backfill extract --background
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex backfill ontology --background
node "$PLUGIN_ROOT/cli/runtime-exec.js" memex sync
```

A started background worker is `진행 중`, not complete. Re-run `status --json`
only when the user needs a settled coverage result; otherwise report the exact
pending counts and log path.

## Add meaning

Use `graph_stats` for the scoped graph overview, `search_facts` for representative
decisions/patterns/constraints, and `cross_project_insights` only with an explicit
canonical current project. Produce the report in the user's language with:

1. overall corpus and date range;
2. extraction/summary coverage;
3. project rollups and representative knowledge;
4. domain/category distribution;
5. activity timeline;
6. remaining gaps and actions actually started.

Do not claim full coverage unless every required pending/missing counter is zero.
