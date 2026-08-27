# Codex rollout fixtures (CX-00 baseline)

Recreate the record shapes of real `codex-cli 0.149.x` files under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. Verified against a real
2026-08-25 main-thread rollout (session_meta / response_item message /
custom_tool_call(+output) / reasoning / event_msg token_count) and a real
subagent rollout (`source.subagent.thread_spawn` with `parent_thread_id`,
`thread_source: "subagent"`, cwd `/`).

| Fixture | Purpose | Acceptance |
|---|---|---|
| main-thread.jsonl | normal user/assistant/tool ingestion | AC-INGEST-01 |
| subagent-thread.jsonl | whole-thread isolation via thread_spawn source | AC-INGEST-01 |
| tool-only-turn.jsonl | tool call preserved without assistant text | AC-INGEST-01 |
| malformed-line.jsonl | per-line tolerance, rest still parsed | AC-INGEST-01 |
| empty-rollout.jsonl | no exchanges -> extraction completion forbidden | AC-FACT-01 |
| same-basename-team-a/b.jsonl | identical basenames, different cwds | AC-SCOPE-01 |
| internal-context-prompt.jsonl | AGENTS/internal context excluded from user turns | AC-INGEST-01 |
| worker-prompt.jsonl | Memex self-ingestion guard | AC-SEC-02 |
| resumed-session.jsonl | incremental watermark after resume boundary | AC-INGEST-02 |

These are synthetic but shape-faithful; they contain no personal data and are
safe to commit. Runtime version dependence: verified on codex-cli 0.149.1
(2026-08-26, Asia/Seoul). If Codex changes the rollout schema these must be
re-derived from a live rollout — treat claims built only on them as
`version-bound`, not permanent contract.
