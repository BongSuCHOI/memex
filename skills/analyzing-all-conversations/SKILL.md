---
name: analyzing-all-conversations
description: Use when the user asks to analyze, organize, or report on their ENTIRE conversation history — e.g. "모든 대화 분석", "대화내역 정리", "전체 대화 리포트", "대화 분석 리포트", "analyze all conversations", "summarize my conversation history". Produces a coverage-checked, organized report of all archived conversations (projects, decisions, patterns, activity timeline, gaps) and kicks off backfill for unanalyzed sessions.
---

# Analyzing All Conversations

**Core principle:** Numbers come from the deterministic engine (`memory-bank analyze`), meaning comes from fact/ontology search. Never fill gaps with guesses — report actual coverage numbers.

## Step 0 — Locate the plugin root

`PLUGIN_ROOT` is two directories up from this skill's base directory
(the directory containing `cli/`, `scripts/`, `skills/`).

## Step 1 — Run the deterministic analysis (read-only)

```bash
node "$PLUGIN_ROOT/cli/memory-bank.js" analyze
```

Options: `--top <n>` (projects, default 15), `--months <n>` (timeline, default 12),
`--json` (for scripting), `--out <file>` (save report).

This returns, without any LLM calls:
- **Coverage** — conversations / sessions / exchanges / projects / date range
- **Pipeline coverage** — fact extraction (done/pending %) and summaries (done/missing %)
- **Facts** — active count, by category, by scope
- **Top knowledge domains** (ontology)
- **Per-project rollups** — conversations, sessions, exchanges, facts, activity range
- **Monthly activity timeline**
- **Recommendations** — which backfills to run

## Step 2 — Fill analysis gaps (backfill, run in background)

If the report recommends backfill:

| Gap | Action |
|-----|--------|
| Pending fact extraction | `node "$PLUGIN_ROOT/scripts/backfill-extract-worker.js" --max 500` — run in background. Uses the local codex CLI (CodexExec). Lock-protected and idempotent: safe to start, exits immediately if another worker is already running. |
| Missing summaries | `node "$PLUGIN_ROOT/cli/memory-bank.js" sync` — generates up to 10 summaries per run; repeated syncs (each session start) drain the queue gradually. |

**Do NOT wait for backfills to finish.** They are long-running background work.
Report them as "진행 중 (백그라운드)" with the log location
(`~/.config/superpowers/conversation-index/backfill-extract.log`), never as "완료".

## Step 3 — Synthesize the organized report

Enrich the numbers with meaning using MCP tools (do not re-derive numbers by hand):

- `graph_stats` — knowledge graph overview (domains, relations)
- `search_facts` with `category: "decision"` / `"pattern"` / `"constraint"` — representative facts for the top projects
- `cross_project_insights` — transferable lessons relevant to the current project

Then present the final report in the **user's language** (Korean → 존댓말) with this structure:

1. **전체 개요** — 대화/세션/exchange 수, 기간, 프로젝트 수
2. **분석 커버리지** — extraction/summary 커버리지 표. 백필을 시작했다면 "완료된 것"과 "백그라운드 진행 중인 것"을 명확히 구분
3. **프로젝트별 정리** — top 프로젝트 표 + 프로젝트별 핵심 결정/패턴 1–2줄
4. **핵심 지식** — 도메인 분포 + 대표 facts (category별)
5. **활동 타임라인** — 월별 추이 요약
6. **남은 공백과 조치** — 미분석 세션 수, 실행한/권장하는 backfill

## Rules

- **Never claim full coverage unless pending == 0 and missing summaries == 0.** Always report actual N/M numbers.
- Backfill started ≠ analysis complete — report scope honestly (foreground done / background running).
- Everything here is additive: `analyze` is read-only; backfill workers only add facts/summaries, never delete.
- Keep the report to roughly one page unless the user asks for more depth. Detail belongs in `--out` files.
