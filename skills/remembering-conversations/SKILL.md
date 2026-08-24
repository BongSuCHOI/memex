---
name: remembering-conversations
description: Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history.
---

# Remembering Conversations

**Core principle:** Search before reinventing. Searching costs nothing; reinventing or repeating mistakes costs everything.

## Historical Search: Delegate First, Fall Back to Direct Tools

For any historical search, prefer delegating to a subagent so raw transcripts never enter this session's context. Use the host's available Codex subagent or delegation mechanism to dispatch the bundled `search-conversations` agent, with a brief like: "Search past conversations for [topic]. Focus on [decisions / patterns / gotchas / code examples]."

Announce: "Dispatching search agent to find [topic]."

The agent will:
1. Search with the `search` tool
2. Read top 2-5 results with the `read` tool
3. Synthesize findings (200-1000 words)
4. Return actionable insights + sources

**Saves 50-100x context vs. loading raw conversations.**

**Direct fallback (no delegation mechanism exposed):** call the memory-bank MCP tools yourself — `search` for the query, then `read` on the top 2-5 results — and synthesize inline, citing archive paths.

## When to Use

You often get value out of consulting your memory bank once you understand what you're being asked. Search memory in these situations:

**After understanding the task:**
- User asks "how should I..." or "what's the best approach..."
- You've explored current codebase and need to make architectural decisions
- User asks for implementation approach after describing what they want

**When you're stuck:**
- You've investigated a problem and can't find the solution
- Facing a complex problem without obvious solution in current code
- Need to follow an unfamiliar workflow or process

**When historical signals are present:**
- User says "last time", "before", "we discussed", "you implemented"
- User asks "why did we...", "what was the reason..."
- User says "do you remember...", "what do we know about..."

**Don't search first:**
- For current codebase structure (use Grep/Read to explore first)
- For info in current conversation
- Before understanding what you're being asked to do

## Direct Tool Access (Fallback)

When delegation is unavailable, call the memory-bank MCP tools directly:
- `search` — semantic/text lookup over past Codex conversations
- `read` — full transcript of a result (archive path + line range)

Prefer the delegated worker for volume; direct calls are the fallback. See MCP-TOOLS.md for the complete API reference.
