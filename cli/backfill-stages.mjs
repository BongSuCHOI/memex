/**
 * Issue #114 — run `memex backfill` stages in the foreground and SAY WHY one failed.
 *
 * The stage loop used to swallow the cause entirely: a stage worker that died
 * printed nothing the CLI kept, so `backfill all` ended at
 *
 *   embeddings backfill failed; remaining stages were not started. …
 *
 * and neither the operator nor a gate receipt could tell a cold model download
 * from a disk error or a dimension mismatch (0.6.9 `package-runtime-e2e`). The
 * stage runner now carries the child's exit code/signal and the tail of its
 * output into the message it prints and into the exit summary.
 *
 * Kept out of `cli/memex.js` because that file executes on import (it reads
 * `process.argv` at module scope); this module is side-effect-free so the slice
 * test can drive the loop with a stubbed stage.
 */

/** Lines of child output worth repeating in the failure message. */
export const STAGE_TAIL_LINES = 5;

/** Keep the last `STAGE_TAIL_LINES` non-empty lines of a child's output. */
export function tailLines(text, limit = STAGE_TAIL_LINES) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-limit);
}

/**
 * The one-line "what actually went wrong" for a failed stage.
 *
 * Takes whatever the stage threw: an `Error` with `message`, an optional `code`
 * (process exit code, or an errno like `ENOTFOUND`), an optional `signal`, and
 * an optional `tail` of the child's own output.
 */
export function describeStageCause(cause) {
  if (cause === undefined || cause === null) return "";
  const parts = [];
  const message =
    cause instanceof Error ? cause.message : String(cause);
  if (message.trim()) parts.push(message.trim());
  const code = cause?.code;
  if (
    code !== undefined &&
    code !== null &&
    String(code).trim() &&
    !message.includes(String(code))
  ) {
    parts.push(`code=${code}`);
  }
  const signal = cause?.signal;
  if (signal) parts.push(`signal=${signal}`);
  const tail = Array.isArray(cause?.tail) ? cause.tail.filter(Boolean) : [];
  const head = parts.join(" ");
  return tail.length > 0
    ? `${head}${head ? " " : ""}— last output: ${tail.join(" | ")}`
    : head;
}

/**
 * The message `memex backfill` prints (and exits with) when a stage fails.
 *
 * `allStages` distinguishes `backfill all` — whose remaining stages were not
 * started — from a single-stage run. The embeddings stage gets the `doctor`
 * pointer, because its most common cause is a cold or interrupted model cache
 * and `doctor`'s `embedding-cache` check already tells those two apart.
 */
export function formatStageFailure(stage, { allStages = false, cause } = {}) {
  const detail = describeStageCause(cause);
  const head = `${stage} backfill failed${detail ? `: ${detail}` : ""}`;
  const tail = allStages
    ? "; remaining stages were not started. Re-run 'memex backfill all' to resume (stages are idempotent)."
    : ".";
  const hint =
    stage === "embeddings"
      ? " Run 'memex doctor' — its embedding-cache check separates a missing model from an interrupted download, and 'memex deps warm' fixes both."
      : "";
  return `${head}${tail}${hint}`;
}

/**
 * Run `stages` in order, stopping at the first failure.
 *
 * Sequential and fail-fast so each stage's ledger/idempotency state stays
 * coherent. Returns `{ ok, failedStage, cause, message }`; the caller owns the
 * exit code.
 */
export async function runBackfillStages({
  stages,
  allStages = false,
  runStage,
  log = console.log,
  logError = console.error,
}) {
  for (const stage of stages) {
    log(`Running ${stage} backfill in foreground...`);
    try {
      await runStage(stage);
    } catch (cause) {
      const message = formatStageFailure(stage, { allStages, cause });
      logError(message);
      return { ok: false, failedStage: stage, cause, message };
    }
  }
  return { ok: true, failedStage: null, cause: null, message: "" };
}
