---
name: remembering-conversations
description: Search Memex when a request depends on earlier Codex work, decisions, failed approaches, user preferences, or unfamiliar workflows. Use after understanding the current task; do not replace direct inspection of the current codebase.
---

# Remembering Conversations

Recover relevant evidence from Memex before repeating past work or inventing a
new rationale. These MCP calls are read-only. Their results are marked
`memex_recall`: they remain searchable context but are not eligible evidence for
new fact extraction merely because the agent repeated them.

## Route the question

- Past implementation, discussion, or exact wording: call `search`, then `read`
  only the best 2–5 archive ranges.
- Durable decision, preference, pattern, knowledge, or constraint: call
  `search_facts`.
- Why a fact exists: call `trace_fact` and inspect its source exchanges.
- How decisions connect: call `explore_graph`; use `search_ontology` for
  domain/category browsing.
- How another project solved a similar problem: call `cross_project_insights`.
- A synthesis in the user's established style: call `ask_avatar`, then retain
  its cited evidence and confidence boundary.

For project-sensitive tools, pass the current Codex thread's canonical absolute
cwd as `project`/`current_project`, or use an explicit `global`/`all` scope.
Never let the MCP server's installed-plugin cwd stand in for the user's project.

## Handoff

Synthesize the evidence into an answer for the current task. Keep conversation
archive paths and line ranges, or fact provenance, next to the claims they
support. Distinguish historical evidence from current repository state and
verify current code before making a change.

Do not load whole archives when a focused range is enough. Read
[references/mcp-tools.md](references/mcp-tools.md) when exact tool parameters or
scope behavior matter.
