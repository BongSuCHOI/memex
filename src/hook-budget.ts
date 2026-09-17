// Issue #162 — ONE hook-wide deadline, not a per-connection busy_timeout.
//
// The host kills a continuity hook at 3 s (5 s for PreCompact) and every hook
// connection used to wait on the 5 s sqlite default, so a lock held for 2 s
// turned into "Hook failed — hook timed out after 3s" instead of a bounded,
// logged skip. The budget below covers EVERYTHING the process does after entry
// — stdin read, dist import, connection open and its migration pass, the
// capture transaction, the marker write — and leaves ≥1 s of slack for node's
// own start-up and exit.
//
// Kept in its own leaf module (no database import) so `memex doctor` can state
// the same budget it diagnoses against without pulling better-sqlite3 in.

export const HOOK_BUDGET_MS = 2_000;
export const HOOK_BUDGET_PRECOMPACT_MS = 3_800;
/** Never spend more than this on a single lock wait, whatever remains. */
const HOOK_MAX_SINGLE_WAIT_MS = 800;
/** Slack reserved inside the budget for writing rows and exiting cleanly. */
const HOOK_WAIT_RESERVE_MS = 200;
/** A second bounded attempt (the capture-gap row) needs at least this much. */
export const HOOK_RETRY_FLOOR_MS = 150;
/** Assumed ingest throughput for the oversize pre-check, bytes per millisecond. */
export const HOOK_INGEST_BYTES_PER_MS = 20_000;
/** Headroom subtracted from the remaining budget by the oversize pre-check. */
export const HOOK_INGEST_RESERVE_MS = 300;

function positiveEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Total budget for one hook invocation, `MEMEX_HOOK_BUDGET_MS`-overridable. */
export function hookBudgetMs(hookEventName: string): number {
  return (
    positiveEnvInt("MEMEX_HOOK_BUDGET_MS") ??
    (hookEventName === "PreCompact" ? HOOK_BUDGET_PRECOMPACT_MS : HOOK_BUDGET_MS)
  );
}

/** `MEMEX_HOOK_INGEST_BYTES_PER_MS` override for the oversize pre-check. */
export function hookIngestBytesPerMs(): number {
  return positiveEnvInt("MEMEX_HOOK_INGEST_BYTES_PER_MS") ?? HOOK_INGEST_BYTES_PER_MS;
}

/** The busy_timeout one DB wait may use, derived from what is left. */
export function busyTimeoutForRemaining(remainingMs: number): number {
  return Math.max(0, Math.min(remainingMs - HOOK_WAIT_RESERVE_MS, HOOK_MAX_SINGLE_WAIT_MS));
}

/** The hook ran out of its own budget; the caller must not commit anything. */
export class HookDeadlineExceeded extends Error {
  readonly code = "MEMEX_HOOK_DEADLINE";
  constructor(message = "hook budget exhausted before the capture committed") {
    super(message);
    this.name = "HookDeadlineExceeded";
  }
}

/** The pending transcript delta cannot be ingested inside the budget. */
export class HookOversizeCapture extends Error {
  readonly code = "MEMEX_HOOK_OVERSIZE";
  constructor(message = "transcript delta is too large for the remaining hook budget") {
    super(message);
    this.name = "HookOversizeCapture";
  }
}

export function isSqliteBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^SQLITE_BUSY/.test(code)) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(message);
}
