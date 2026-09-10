/**
 * Operator recovery for terminal Continuity work (issues #20, #39).
 *
 * `memory_jobs.state = 'dead'` was one of eight terminal states with no
 * recovery path. Seven of the eight had none at all, and the eight are written
 * together in one transaction (`continuity-store.ts`, the attempts-exhausted
 * claim path and the failure-record path): `extraction_failed_ranges`,
 * `extraction_target_items`, `exchange_extraction_state`, `extraction_targets`,
 * `checkpoints`, `memory_jobs`, and — for Capsule work —
 * `capsule_checkpoint_state`. Recovering only `memory_jobs` leaves the rest
 * terminal and the work never resumes, so recovery here is one transaction over
 * the same unit.
 *
 * Nothing is deleted. A retried job keeps its failure record in
 * `retry_history`; a dismissed job keeps its cause in `last_error`.
 */
import fs from "node:fs";
import path from "node:path";
import { getMemexHome } from "./paths.js";
/** Terminal states this module can act on. */
const RECOVERABLE_JOB_STATE = "dead";
const RECOVERABLE_TARGET_STATE = "dead";
function tableExists(db, name) {
    return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
}
function columnExists(db, table, column) {
    return db.prepare(`PRAGMA table_info(${table})`).all()
        .some((row) => row.name === column);
}
/**
 * Additive: `retry_history` preserves the failure a retry clears.
 * A read-only connection (`memex jobs list|show`) never migrates.
 */
export function ensureJobRecoverySchema(db) {
    if (db.readonly || !tableExists(db, "memory_jobs"))
        return;
    if (!columnExists(db, "memory_jobs", "retry_history")) {
        db.exec("ALTER TABLE memory_jobs ADD COLUMN retry_history TEXT");
    }
}
function parseRetryHistory(raw) {
    if (typeof raw !== "string" || !raw.trim())
        return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function toSummary(row, nowIso) {
    const leaseUntil = row.lease_until == null ? null : String(row.lease_until);
    return {
        jobId: String(row.job_id),
        kind: String(row.kind),
        state: String(row.state),
        partitionKey: String(row.partition_key),
        checkpointId: row.checkpoint_id == null ? null : String(row.checkpoint_id),
        targetId: row.target_id == null ? null : String(row.target_id),
        attempts: Number(row.attempts),
        maxAttempts: Number(row.max_attempts),
        availableAt: String(row.available_at),
        leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
        leaseUntil,
        leaseExpired: leaseUntil !== null && leaseUntil <= nowIso,
        lastError: row.last_error == null ? null : String(row.last_error),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
    };
}
export function listMemoryJobs(db, options = {}) {
    if (!tableExists(db, "memory_jobs"))
        return [];
    const nowIso = (options.now ?? new Date()).toISOString();
    const where = [];
    const params = [];
    if (options.state && options.state !== "all") {
        where.push("state = ?");
        params.push(options.state);
    }
    if (options.kind) {
        where.push("kind = ?");
        params.push(options.kind);
    }
    const limit = Math.max(1, Math.min(1_000, options.limit ?? 50));
    const rows = db.prepare(`
    SELECT * FROM memory_jobs
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY CASE state WHEN 'dead' THEN 0 WHEN 'retry' THEN 1 WHEN 'running' THEN 2 ELSE 3 END,
             updated_at DESC, job_id
    LIMIT ?
  `).all(...params, limit);
    return rows.map((row) => toSummary(row, nowIso));
}
export function showMemoryJob(db, jobId, options = {}) {
    if (!tableExists(db, "memory_jobs"))
        return null;
    ensureJobRecoverySchema(db);
    const nowIso = (options.now ?? new Date()).toISOString();
    const row = db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(jobId);
    if (!row)
        return null;
    const summary = toSummary(row, nowIso);
    const checkpoint = summary.checkpointId
        ? db.prepare("SELECT checkpoint_id, kind, state, session_id FROM checkpoints WHERE checkpoint_id = ?")
            .get(summary.checkpointId)
        : undefined;
    const capsuleState = summary.checkpointId && tableExists(db, "capsule_checkpoint_state")
        ? db.prepare("SELECT state, last_error FROM capsule_checkpoint_state WHERE checkpoint_id = ?")
            .get(summary.checkpointId)
        : undefined;
    const target = summary.targetId && tableExists(db, "extraction_targets")
        ? db.prepare("SELECT target_id, session_id, state, item_count, last_error FROM extraction_targets WHERE target_id = ?")
            .get(summary.targetId)
        : undefined;
    const itemStates = summary.targetId && tableExists(db, "extraction_target_items")
        ? db.prepare("SELECT state, COUNT(*) AS c FROM extraction_target_items WHERE target_id = ? GROUP BY state")
            .all(summary.targetId)
        : [];
    const failedRanges = summary.targetId && tableExists(db, "extraction_failed_ranges")
        ? db.prepare(`SELECT failure_id, from_ordinal, through_ordinal, state, error_kind, error_message
        FROM extraction_failed_ranges WHERE target_id = ? ORDER BY from_ordinal`)
            .all(summary.targetId)
        : [];
    return {
        ...summary,
        retryHistory: parseRetryHistory(row.retry_history),
        checkpoint: checkpoint
            ? { checkpointId: checkpoint.checkpoint_id, kind: checkpoint.kind, state: checkpoint.state, sessionId: checkpoint.session_id }
            : null,
        capsuleCheckpointState: capsuleState
            ? { state: capsuleState.state, lastError: capsuleState.last_error }
            : null,
        target: target
            ? { targetId: target.target_id, sessionId: target.session_id, state: target.state, itemCount: target.item_count, lastError: target.last_error }
            : null,
        targetItemStates: Object.fromEntries(itemStates.map((entry) => [entry.state, entry.c])),
        failedRanges: failedRanges.map((range) => ({
            failureId: range.failure_id,
            fromOrdinal: range.from_ordinal,
            throughOrdinal: range.through_ordinal,
            state: range.state,
            errorKind: range.error_kind,
            errorMessage: range.error_message,
        })),
    };
}
function resolveUnits(db, input, nowIso) {
    const jobRow = (where, ...params) => db.prepare(`SELECT * FROM memory_jobs WHERE ${where}`).get(...params);
    const unitFromJob = (row) => ({
        jobId: String(row.job_id),
        targetId: row.target_id == null ? null : String(row.target_id),
        checkpointId: row.checkpoint_id == null ? null : String(row.checkpoint_id),
        kind: String(row.kind),
        fromState: String(row.state),
        attempts: Number(row.attempts),
        lastError: row.last_error == null ? null : String(row.last_error),
        retryHistory: parseRetryHistory(row.retry_history),
    });
    if (input.allDead) {
        const jobs = db.prepare(`SELECT * FROM memory_jobs WHERE state = ?${input.kind ? " AND kind = ?" : ""}`)
            .all(...(input.kind ? [RECOVERABLE_JOB_STATE, input.kind] : [RECOVERABLE_JOB_STATE]));
        const units = jobs.map(unitFromJob);
        const claimed = new Set(units.map((unit) => unit.targetId).filter(Boolean));
        if (!input.kind && tableExists(db, "extraction_targets")) {
            // A dead target whose job already left `dead` (superseded, completed) is
            // still a dead end: `pending-extraction` excludes its whole session.
            const orphans = db.prepare("SELECT target_id, last_error, attempts FROM extraction_targets WHERE state = ?")
                .all(RECOVERABLE_TARGET_STATE);
            for (const orphan of orphans) {
                if (claimed.has(orphan.target_id))
                    continue;
                units.push({
                    jobId: null, targetId: orphan.target_id, checkpointId: null, kind: "fact_extract",
                    fromState: RECOVERABLE_TARGET_STATE, attempts: orphan.attempts, lastError: orphan.last_error,
                    retryHistory: [],
                });
            }
        }
        return units;
    }
    const id = input.jobId ?? input.targetId;
    if (!id)
        throw new Error("recover requires a job id, a target id, or --all-dead");
    const byJob = jobRow("job_id = ?", id);
    if (byJob) {
        const state = String(byJob.state);
        if (state !== RECOVERABLE_JOB_STATE) {
            throw new Error(`job ${id} is '${state}'; only '${RECOVERABLE_JOB_STATE}' work is recovered`);
        }
        return [unitFromJob(byJob)];
    }
    const byTarget = tableExists(db, "extraction_targets")
        ? db.prepare("SELECT target_id, state, last_error, attempts FROM extraction_targets WHERE target_id = ?")
            .get(id)
        : undefined;
    if (!byTarget)
        throw new Error(`no memory job or extraction target with id ${id}`);
    if (byTarget.state !== RECOVERABLE_TARGET_STATE) {
        throw new Error(`target ${id} is '${byTarget.state}'; only '${RECOVERABLE_TARGET_STATE}' work is recovered`);
    }
    const owner = jobRow("target_id = ?", id);
    if (owner) {
        // Issue #70: a target can be `dead` while the job that owns it was picked
        // up again — `claimExtractionTarget` re-queues the target under the same
        // job. Recovering through the target id then reset a RUNNING job to
        // `pending` with `attempts = 0` and `lease_owner = NULL`, stealing a live
        // lease: the holder kept working while a second worker claimed the same
        // unit, so the model call and the extraction both ran twice. Only work
        // nobody is holding may be recovered — a terminal state, or an expired
        // lease (which is what recovery is for).
        const ownerState = String(owner.state);
        const leaseUntil = owner.lease_until == null ? null : String(owner.lease_until);
        const leaseLive = leaseUntil !== null && leaseUntil > nowIso;
        if (leaseLive && ownerState !== RECOVERABLE_JOB_STATE && ownerState !== "retry") {
            throw new Error(`target ${id} is owned by job ${String(owner.job_id)} which is '${ownerState}' ` +
                `with a lease held until ${leaseUntil}; recover it once that lease is terminal or expired`);
        }
        return [unitFromJob(owner)];
    }
    return [{
            jobId: null, targetId: byTarget.target_id, checkpointId: null, kind: "fact_extract",
            fromState: byTarget.state, attempts: byTarget.attempts, lastError: byTarget.last_error,
            retryHistory: [],
        }];
}
/**
 * Reset one terminal unit — or every dead unit — back to claimable, in a single
 * transaction over the same tables that were made terminal together.
 */
export function recoverTerminalWork(db, input) {
    ensureJobRecoverySchema(db);
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const dryRun = input.dryRun === true;
    const notes = [];
    const entries = [];
    const run = () => {
        // A rolled-back attempt must not leave its half-built report behind.
        notes.length = 0;
        entries.length = 0;
        // Issue #70: resolve the unit INSIDE the write transaction. Reading the
        // target first and writing afterwards left a window in which a worker or a
        // second recoverer could move the job, and the reports below were built
        // from the stale read.
        const units = resolveUnits(db, input, nowIso);
        for (const unit of units) {
            const reset = {};
            const bump = (table, changes) => {
                if (changes > 0)
                    reset[table] = (reset[table] ?? 0) + changes;
            };
            if (unit.jobId) {
                const history = [
                    ...unit.retryHistory,
                    { at: nowIso, fromState: unit.fromState, attempts: unit.attempts, lastError: unit.lastError, action: "retry" },
                ].slice(-32);
                const changes = dryRun
                    ? 1
                    : db.prepare(`
              UPDATE memory_jobs
              SET state = 'pending', attempts = 0, available_at = ?, lease_owner = NULL,
                  lease_until = NULL, last_error = NULL, retry_history = ?, updated_at = ?
              WHERE job_id = ? AND state = ?
            `).run(nowIso, JSON.stringify(history), nowIso, unit.jobId, unit.fromState).changes;
                bump("memory_jobs", changes);
                // Issue #70: the CAS is the unit's gate, not a statistic. When it
                // matches nothing the job has already left `unit.fromState` — another
                // recoverer took it, or a worker claimed it — and resetting the child
                // tables anyway pulled `processing` items back to `pending` underneath
                // the holder, which is the duplicate-extraction path. Leave the whole
                // unit alone and say why.
                if (changes === 0) {
                    notes.push(`job ${unit.jobId} left '${unit.fromState}' before it could be reset ` +
                        "(claimed by another recoverer or worker); nothing in that unit was changed.");
                    entries.push({
                        jobId: unit.jobId,
                        targetId: unit.targetId,
                        kind: unit.kind,
                        fromState: unit.fromState,
                        reset,
                    });
                    continue;
                }
            }
            if (unit.checkpointId) {
                bump("checkpoints", dryRun
                    ? Number(!!db.prepare("SELECT 1 FROM checkpoints WHERE checkpoint_id = ? AND state IN ('dead-letter','failed-visible','retry')")
                        .get(unit.checkpointId))
                    : db.prepare(`UPDATE checkpoints SET state = 'pending'
              WHERE checkpoint_id = ? AND state IN ('dead-letter','failed-visible','retry')`)
                        .run(unit.checkpointId).changes);
                if (tableExists(db, "capsule_checkpoint_state")) {
                    // Issue #71: a terminal skip stepped the frontier over one fragment.
                    // Recovery has to put that fragment back in the recovered job's input
                    // — clearing the page hint alone re-read everything AFTER the skip, so
                    // the fragment stayed lost however often the operator recovered. The
                    // pre-skip position is read from the checkpoint row and restored under
                    // a CAS on the skipped seq, so a frontier that has since moved on
                    // under a later successful commit is never rewound.
                    const hasSkipColumns = columnExists(db, "capsule_checkpoint_state", "frontier_before_skip");
                    const skip = hasSkipColumns
                        ? db.prepare(`SELECT workstream_id, skipped_seq, frontier_before_skip
                FROM capsule_checkpoint_state WHERE checkpoint_id = ?`)
                            .get(unit.checkpointId)
                        : undefined;
                    if (skip && skip.skipped_seq !== null && skip.frontier_before_skip !== null) {
                        bump("capsule_frontiers", dryRun
                            ? Number(!!db.prepare("SELECT 1 FROM capsule_frontiers WHERE workstream_id = ? AND through_seq = ?")
                                .get(skip.workstream_id, skip.skipped_seq))
                            : db.prepare(`UPDATE capsule_frontiers SET through_seq = ?
                  WHERE workstream_id = ? AND through_seq = ?`)
                                .run(skip.frontier_before_skip, skip.workstream_id, skip.skipped_seq).changes);
                    }
                    // Also clears the #33 page-shrink hint and the frozen target so the
                    // recovered job re-reads a full page against the current frontier.
                    bump("capsule_checkpoint_state", dryRun
                        ? Number(!!db.prepare("SELECT 1 FROM capsule_checkpoint_state WHERE checkpoint_id = ? AND state <> 'processed'")
                            .get(unit.checkpointId))
                        : db.prepare(`UPDATE capsule_checkpoint_state
                SET state = 'pending', last_error = NULL, updated_at = ?,
                    target_seq = NULL, target_revision = NULL,
                    page_items_hint = NULL, page_chars_hint = NULL${hasSkipColumns ? ", skipped_seq = NULL, frontier_before_skip = NULL" : ""}
                WHERE checkpoint_id = ? AND state <> 'processed'`)
                            .run(nowIso, unit.checkpointId).changes);
                }
            }
            if (unit.targetId) {
                bump("extraction_targets", dryRun
                    ? Number(!!db.prepare("SELECT 1 FROM extraction_targets WHERE target_id = ? AND state IN ('dead','retry')").get(unit.targetId))
                    : db.prepare(`UPDATE extraction_targets
              SET state = 'pending', attempts = 0, lease_owner = NULL, lease_until = NULL,
                  last_error = NULL, updated_at = ?
              WHERE target_id = ? AND state IN ('dead','retry')`)
                        .run(nowIso, unit.targetId).changes);
                const pendingItems = "state IN ('failed-visible','retry','processing')";
                bump("extraction_target_items", dryRun
                    ? db.prepare(`SELECT COUNT(*) AS c FROM extraction_target_items WHERE target_id = ? AND ${pendingItems}`)
                        .get(unit.targetId).c
                    : db.prepare(`UPDATE extraction_target_items SET state = 'pending'
              WHERE target_id = ? AND ${pendingItems}`).run(unit.targetId).changes);
                bump("exchange_extraction_state", dryRun
                    ? db.prepare(`SELECT COUNT(*) AS c FROM exchange_extraction_state WHERE target_id = ? AND ${pendingItems}`)
                        .get(unit.targetId).c
                    : db.prepare(`UPDATE exchange_extraction_state SET state = 'pending'
              WHERE target_id = ? AND ${pendingItems}`).run(unit.targetId).changes);
                if (tableExists(db, "extraction_failed_ranges")) {
                    // `extraction_failed_ranges.state` only admits retry|failed-visible,
                    // so the range record survives as `retry` — the failure is not erased.
                    bump("extraction_failed_ranges", dryRun
                        ? db.prepare("SELECT COUNT(*) AS c FROM extraction_failed_ranges WHERE target_id = ? AND state = 'failed-visible'")
                            .get(unit.targetId).c
                        : db.prepare(`UPDATE extraction_failed_ranges SET state = 'retry', updated_at = ?
                WHERE target_id = ? AND state = 'failed-visible'`).run(nowIso, unit.targetId).changes);
                }
            }
            entries.push({
                jobId: unit.jobId,
                targetId: unit.targetId,
                kind: unit.kind,
                fromState: unit.fromState,
                reset,
            });
        }
    };
    if (dryRun)
        run();
    else
        db.transaction(run).immediate();
    if (entries.some((entry) => entry.reset.extraction_failed_ranges)) {
        notes.push("extraction_failed_ranges rows were reopened as 'retry'; their error text is preserved.");
    }
    return { dryRun, entries, notes };
}
/** Metadata-only audit line; never conversation, fact, or command output text. */
function appendRecoveryAudit(event) {
    try {
        const dir = path.join(getMemexHome(), "logs");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const file = path.join(dir, "ui-audit.jsonl");
        const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
        if (stat?.isSymbolicLink())
            return null;
        if (stat && stat.size > 1024 * 1024) {
            try {
                fs.renameSync(file, `${file}.old`);
            }
            catch { /* rotation is best-effort */ }
        }
        fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), source: "memex-cli", ...event }) + "\n", { mode: 0o600 });
        return file;
    }
    catch {
        return null;
    }
}
/**
 * Retire a job the operator does not want retried (issue #20).
 *
 * `superseded` already means "past work that does not make current state
 * stale" (docs/CONTINUITY.md §2), so no CHECK-constraint migration is needed
 * and nothing is deleted: the cause stays in `last_error`.
 */
export function dismissMemoryJob(db, input) {
    ensureJobRecoverySchema(db);
    const reason = input.reason.trim();
    if (!reason)
        throw new Error("dismiss requires --reason \"<why>\"");
    const nowIso = (input.now ?? new Date()).toISOString();
    const row = db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(input.jobId);
    if (!row)
        throw new Error(`no memory job with id ${input.jobId}`);
    const fromState = String(row.state);
    if (!["dead", "retry", "pending"].includes(fromState)) {
        throw new Error(`job ${input.jobId} is '${fromState}'; only dead, retry, or pending work can be dismissed`);
    }
    const checkpointId = row.checkpoint_id == null ? null : String(row.checkpoint_id);
    const targetId = row.target_id == null ? null : String(row.target_id);
    const history = [
        ...parseRetryHistory(row.retry_history),
        { at: nowIso, fromState, attempts: Number(row.attempts), lastError: row.last_error == null ? null : String(row.last_error), action: "dismiss" },
    ].slice(-32);
    const reset = {};
    const bump = (table, changes) => {
        if (changes > 0)
            reset[table] = (reset[table] ?? 0) + changes;
    };
    db.transaction(() => {
        bump("memory_jobs", db.prepare(`
      UPDATE memory_jobs
      SET state = 'superseded', lease_owner = NULL, lease_until = NULL,
          last_error = ?, retry_history = ?, updated_at = ?
      WHERE job_id = ? AND state = ?
    `).run(`user dismissed: ${reason}`, JSON.stringify(history), nowIso, input.jobId, fromState).changes);
        if (checkpointId) {
            bump("checkpoints", db.prepare(`UPDATE checkpoints SET state = 'superseded'
        WHERE checkpoint_id = ? AND state IN ('dead-letter','failed-visible','retry','pending','captured')`)
                .run(checkpointId).changes);
        }
        if (targetId && tableExists(db, "extraction_targets")) {
            bump("extraction_targets", db.prepare(`UPDATE extraction_targets
        SET state = 'superseded', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE target_id = ? AND state IN ('dead','retry','pending')`).run(nowIso, targetId).changes);
            bump("extraction_target_items", db.prepare(`UPDATE extraction_target_items SET state = 'superseded'
        WHERE target_id = ? AND state IN ('failed-visible','retry','processing','pending')`).run(targetId).changes);
            bump("exchange_extraction_state", db.prepare(`UPDATE exchange_extraction_state SET state = 'superseded'
        WHERE target_id = ? AND state IN ('failed-visible','retry','processing','pending')`).run(targetId).changes);
        }
    }).immediate();
    const auditPath = appendRecoveryAudit({
        action: "jobs dismiss",
        status: "ok",
        id: input.jobId,
        operation: `${String(row.kind)}:${fromState}->superseded`,
        reason_length: reason.length,
    });
    return { jobId: input.jobId, fromState, reason, reset, auditPath };
}
/** Audit line for an operator recovery; metadata only. */
export function recordRecoveryAudit(result, source) {
    if (result.dryRun)
        return null;
    return appendRecoveryAudit({
        action: source,
        status: "ok",
        id: result.entries.length === 1 ? result.entries[0].jobId ?? result.entries[0].targetId : null,
        operation: `recovered=${result.entries.length}`,
    });
}
