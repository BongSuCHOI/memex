import { createHash, randomUUID } from "node:crypto";
export const CONTINUITY_SCHEMA_VERSION = 1;
export const FACT_EXTRACTION_POLICY_VERSION = "continuity-fact-v1";
class ContinuityCasRejected extends Error {
}
function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
function parseStoredJson(value) {
    if (!value)
        return null;
    try {
        return JSON.parse(value);
    }
    catch {
        return value;
    }
}
function nullableNumber(value) {
    return value === null || value === undefined ? null : Number(value);
}
export function exchangeContentHash(exchange) {
    const tools = (exchange.toolCalls ?? [])
        .map((tool) => ({
        id: tool.id,
        name: tool.toolName,
        input: tool.toolInput ?? null,
        result: tool.toolResult ?? null,
        error: tool.isError,
    }))
        .sort((left, right) => left.id.localeCompare(right.id));
    return sha256(JSON.stringify({
        user: exchange.userMessage,
        assistant: exchange.assistantMessage,
        lineEnd: exchange.lineEnd,
        tools,
    }));
}
function columnNames(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(({ name }) => name));
}
/**
 * Additive, idempotent Continuity v1 schema migration. Existing exchange rowids
 * and every fact/provenance row remain in place. The version is written only
 * after all DDL and deterministic exchange backfill finish successfully.
 */
export function ensureContinuitySchema(db, options = {}) {
    const migrate = db.transaction(() => {
        const columns = columnNames(db, "exchanges");
        if (!columns.has("exchange_seq")) {
            db.exec("ALTER TABLE exchanges ADD COLUMN exchange_seq INTEGER NOT NULL DEFAULT 0");
            options.afterMigrationStage?.("exchange-seq-column");
        }
        if (!columns.has("content_hash")) {
            db.exec("ALTER TABLE exchanges ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
            options.afterMigrationStage?.("content-hash-column");
        }
        if (!columns.has("content_generation")) {
            db.exec("ALTER TABLE exchanges ADD COLUMN content_generation INTEGER NOT NULL DEFAULT 0");
            options.afterMigrationStage?.("content-generation-column");
        }
        if (!columns.has("closure_state")) {
            db.exec("ALTER TABLE exchanges ADD COLUMN closure_state TEXT NOT NULL DEFAULT 'closed' " +
                "CHECK(closure_state IN ('open','interrupted','closed','final'))");
            options.afterMigrationStage?.("closure-state-column");
        }
        if (!columns.has("parser_version")) {
            db.exec("ALTER TABLE exchanges ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1");
            options.afterMigrationStage?.("parser-version-column");
        }
        db.exec(`
      CREATE TABLE IF NOT EXISTS continuity_schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace_id TEXT,
        workstream_id TEXT,
        stream_epoch INTEGER NOT NULL DEFAULT 0,
        ordinal INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('stop','interrupt','precompact','final','extraction')),
        turn_id TEXT,
        from_byte INTEGER,
        through_byte INTEGER,
        from_line INTEGER,
        through_line INTEGER,
        from_cursor INTEGER,
        through_cursor INTEGER,
        segment_hash TEXT,
        prefix_hash TEXT,
        parser_version INTEGER NOT NULL DEFAULT 1,
        closure_state TEXT NOT NULL DEFAULT 'closed'
          CHECK(closure_state IN ('open','interrupted','closed','final')),
        context_epoch_before INTEGER,
        state TEXT NOT NULL DEFAULT 'captured'
          CHECK(state IN ('captured','pending','processing','processed','retry','superseded','failed-visible','dead-letter')),
        capture_gap_reason TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_jobs (
        job_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        partition_key TEXT NOT NULL,
        checkpoint_id TEXT REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE,
        target_id TEXT,
        from_cursor INTEGER,
        through_cursor INTEGER,
        policy_version TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','running','retry','completed','superseded','dead')),
        available_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        last_error TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extraction_targets (
        target_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        from_rowid INTEGER NOT NULL,
        through_rowid INTEGER NOT NULL,
        cursor_ordinal INTEGER NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','running','retry','completed','superseded','dead')),
        lease_owner TEXT,
        lease_until TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extraction_target_items (
        target_id TEXT NOT NULL REFERENCES extraction_targets(target_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        -- Keep immutable target identity if canonical reconciliation removes
        -- an exchange during async model work. Privacy purge deletes the
        -- target first, so this non-FK reference does not retain purged state.
        exchange_id TEXT NOT NULL,
        exchange_rowid INTEGER NOT NULL,
        content_generation INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','processing','processed','retry','superseded','failed-visible')),
        PRIMARY KEY(target_id, ordinal),
        UNIQUE(target_id, exchange_id, content_generation)
      );

      CREATE TABLE IF NOT EXISTS exchange_extraction_state (
        exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
        content_generation INTEGER NOT NULL,
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','processing','processed','retry','superseded','failed-visible')),
        target_id TEXT,
        processed_at TEXT,
        PRIMARY KEY(exchange_id, content_generation, policy_version)
      );

      CREATE TABLE IF NOT EXISTS extraction_failed_ranges (
        failure_id TEXT PRIMARY KEY,
        target_id TEXT NOT NULL REFERENCES extraction_targets(target_id) ON DELETE CASCADE,
        from_ordinal INTEGER NOT NULL,
        through_ordinal INTEGER NOT NULL,
        from_rowid INTEGER NOT NULL,
        through_rowid INTEGER NOT NULL,
        payload_fingerprint TEXT NOT NULL,
        error_kind TEXT NOT NULL,
        error_message TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('retry','failed-visible')),
        attempts INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(target_id, from_ordinal, through_ordinal, payload_fingerprint)
      );

    `);
        options.afterMigrationStage?.("continuity-tables");
        db.exec(`

      CREATE INDEX IF NOT EXISTS idx_memory_jobs_ready
        ON memory_jobs(state, available_at, priority DESC, created_at, job_id);
      CREATE INDEX IF NOT EXISTS idx_memory_jobs_partition
        ON memory_jobs(partition_key, state, lease_until);
      CREATE INDEX IF NOT EXISTS idx_extraction_targets_session
        ON extraction_targets(session_id, policy_version, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_extraction_items_state
        ON extraction_target_items(target_id, state, ordinal);
      CREATE INDEX IF NOT EXISTS idx_exchange_generation_pending
        ON exchange_extraction_state(policy_version, state, exchange_id);
    `);
        options.afterMigrationStage?.("continuity-indexes");
        options.afterStructuralDdl?.();
        const priorVersion = Number(db.prepare("SELECT value FROM continuity_schema_meta WHERE key = 'schema_version'").get()?.value ?? 0);
        const ftsExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exchanges_fts'").get();
        if (ftsExists && priorVersion < CONTINUITY_SCHEMA_VERSION) {
            // Released databases can contain exchange rows created before the FTS
            // virtual table existed. Populate its external-content shadow before
            // metadata UPDATE triggers emit delete/insert maintenance records.
            db.exec("INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild')");
            options.afterMigrationStage?.("fts-rebuild");
        }
        refreshExchangeMetadata(db);
        options.afterMigrationStage?.("exchange-metadata");
        const now = new Date().toISOString();
        db.prepare(`
      INSERT INTO continuity_schema_meta(key, value, updated_at)
      VALUES ('schema_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(CONTINUITY_SCHEMA_VERSION), now);
        options.afterMigrationStage?.("schema-meta");
        db.pragma(`user_version = ${CONTINUITY_SCHEMA_VERSION}`);
        options.afterMigrationStage?.("user-version");
    });
    migrate.immediate();
}
/** Backfill rows inserted by legacy readers or direct migration fixtures. */
export function refreshExchangeMetadata(db, sessionId) {
    const rows = db
        .prepare(`
      SELECT rowid, id, session_id, user_message, assistant_message, line_end,
             exchange_seq, content_hash, content_generation
      FROM exchanges
      ${sessionId ? "WHERE session_id = ?" : ""}
      ORDER BY session_id, timestamp, rowid
    `)
        .all(...(sessionId ? [sessionId] : []));
    const nextBySession = new Map();
    const update = db.prepare(`
    UPDATE exchanges
    SET exchange_seq = ?, content_hash = ?, content_generation = ?
    WHERE id = ?
  `);
    const selectTools = db.prepare(`
    SELECT id, tool_name, tool_input, tool_result, is_error
    FROM tool_calls WHERE exchange_id = ? ORDER BY id
  `);
    for (const row of rows) {
        const key = row.session_id ?? `__row__${row.rowid}`;
        const next = (nextBySession.get(key) ?? 0) + 1;
        nextBySession.set(key, Math.max(next, row.exchange_seq));
        const tools = selectTools.all(row.id);
        const hash = sha256(JSON.stringify({
            user: row.user_message,
            assistant: row.assistant_message,
            lineEnd: row.line_end,
            tools: tools.map((tool) => ({
                id: tool.id,
                name: tool.tool_name,
                input: parseStoredJson(tool.tool_input),
                result: tool.tool_result,
                error: !!tool.is_error,
            })),
        }));
        const changed = !!row.content_hash && row.content_hash !== hash;
        update.run(row.exchange_seq > 0 ? row.exchange_seq : next, hash, changed
            ? Math.max(1, row.content_generation) + 1
            : row.content_generation > 0 ? row.content_generation : 1, row.id);
    }
}
export function createCheckpointWithJob(db, input) {
    const now = input.now ?? new Date().toISOString();
    const tx = db.transaction(() => {
        const existingCheckpoint = db.prepare(`
      SELECT * FROM checkpoints
      WHERE checkpoint_id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(input.checkpoint.checkpointId, input.checkpoint.idempotencyKey);
        if (existingCheckpoint &&
            (String(existingCheckpoint.checkpoint_id) !== input.checkpoint.checkpointId ||
                String(existingCheckpoint.session_id) !== input.checkpoint.sessionId ||
                Number(existingCheckpoint.ordinal) !== input.checkpoint.ordinal ||
                String(existingCheckpoint.kind) !== input.checkpoint.kind ||
                nullableNumber(existingCheckpoint.from_cursor) !== (input.checkpoint.fromCursor ?? null) ||
                nullableNumber(existingCheckpoint.through_cursor) !== (input.checkpoint.throughCursor ?? null) ||
                Number(existingCheckpoint.parser_version) !== (input.checkpoint.parserVersion ?? 1) ||
                String(existingCheckpoint.closure_state) !== (input.checkpoint.closureState ?? "closed") ||
                String(existingCheckpoint.idempotency_key) !== input.checkpoint.idempotencyKey)) {
            throw new Error("checkpoint idempotency collision with different semantic target");
        }
        const checkpointResult = db.prepare(`
      INSERT OR IGNORE INTO checkpoints
        (checkpoint_id, session_id, ordinal, kind, from_cursor, through_cursor,
         parser_version, closure_state, state, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(input.checkpoint.checkpointId, input.checkpoint.sessionId, input.checkpoint.ordinal, input.checkpoint.kind, input.checkpoint.fromCursor ?? null, input.checkpoint.throughCursor ?? null, input.checkpoint.parserVersion ?? 1, input.checkpoint.closureState ?? "closed", input.checkpoint.idempotencyKey, now);
        input.afterCheckpoint?.();
        const jobId = sha256(`job\0${input.job.idempotencyKey}`);
        const existingJob = db.prepare(`
      SELECT * FROM memory_jobs
      WHERE job_id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(jobId, input.job.idempotencyKey);
        if (existingJob &&
            (String(existingJob.job_id) !== jobId ||
                String(existingJob.kind) !== input.job.kind ||
                String(existingJob.partition_key) !== input.job.partitionKey ||
                String(existingJob.checkpoint_id ?? "") !== input.checkpoint.checkpointId ||
                String(existingJob.target_id ?? "") !== (input.job.targetId ?? "") ||
                nullableNumber(existingJob.from_cursor) !== (input.checkpoint.fromCursor ?? null) ||
                nullableNumber(existingJob.through_cursor) !== (input.checkpoint.throughCursor ?? null) ||
                String(existingJob.policy_version) !== input.job.policyVersion ||
                Number(existingJob.priority) !== input.job.priority ||
                Number(existingJob.max_attempts) !== (input.job.maxAttempts ?? 5) ||
                String(existingJob.idempotency_key) !== input.job.idempotencyKey)) {
            throw new Error("job idempotency collision with different semantic target");
        }
        const jobResult = db.prepare(`
      INSERT OR IGNORE INTO memory_jobs
        (job_id, kind, partition_key, checkpoint_id, target_id, from_cursor,
         through_cursor, policy_version, priority, state, available_at,
         max_attempts, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(jobId, input.job.kind, input.job.partitionKey, input.checkpoint.checkpointId, input.job.targetId ?? null, input.checkpoint.fromCursor ?? null, input.checkpoint.throughCursor ?? null, input.job.policyVersion, input.job.priority, now, input.job.maxAttempts ?? 5, input.job.idempotencyKey, now, now);
        input.afterJob?.();
        const existing = db
            .prepare("SELECT job_id FROM memory_jobs WHERE idempotency_key = ?")
            .get(input.job.idempotencyKey);
        return {
            checkpointId: input.checkpoint.checkpointId,
            jobId: existing.job_id,
            created: checkpointResult.changes === 1 || jobResult.changes === 1,
        };
    });
    return tx.immediate();
}
export function claimMemoryJobById(db, input) {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30 * 60_000)).toISOString();
    const tx = db.transaction(() => {
        const row = db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(input.jobId);
        if (!row ||
            row.state === "completed" ||
            row.state === "superseded" ||
            row.state === "dead")
            return null;
        const expiredRunning = row.state === "running" && (!row.lease_until || row.lease_until <= nowIso);
        if (row.attempts >= row.max_attempts && (expiredRunning || row.state !== "running")) {
            const error = expiredRunning
                ? "lease expired after maximum attempts"
                : "maximum attempts exhausted";
            const remaining = row.target_id
                ? db.prepare(`
            SELECT MIN(ordinal) AS from_ordinal, MAX(ordinal) AS through_ordinal,
                   MIN(exchange_rowid) AS from_rowid, MAX(exchange_rowid) AS through_rowid
            FROM extraction_target_items
            WHERE target_id = ? AND state <> 'processed'
          `).get(row.target_id)
                : undefined;
            if (row.target_id && remaining?.from_ordinal != null) {
                const fingerprint = sha256(`${row.target_id}\0lease-expired\0${remaining.from_ordinal}\0${remaining.through_ordinal}`);
                const failureId = sha256(`${row.target_id}\0${remaining.from_ordinal}\0${remaining.through_ordinal}\0${fingerprint}`);
                db.prepare(`
          INSERT INTO extraction_failed_ranges
            (failure_id, target_id, from_ordinal, through_ordinal, from_rowid,
             through_rowid, payload_fingerprint, error_kind, error_message,
             state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'lease_expired', ?, 'failed-visible', ?, ?)
          ON CONFLICT(target_id, from_ordinal, through_ordinal, payload_fingerprint)
          DO UPDATE SET attempts = attempts + 1, error_message = excluded.error_message,
                        state = 'failed-visible', updated_at = excluded.updated_at
        `).run(failureId, row.target_id, remaining.from_ordinal, remaining.through_ordinal, remaining.from_rowid, remaining.through_rowid, fingerprint, error, nowIso, nowIso);
                db.prepare(`
          UPDATE extraction_target_items SET state = 'failed-visible'
          WHERE target_id = ? AND state <> 'processed'
        `).run(row.target_id);
                db.prepare(`
          UPDATE exchange_extraction_state SET state = 'failed-visible'
          WHERE target_id = ? AND state <> 'processed'
        `).run(row.target_id);
                db.prepare(`
          UPDATE extraction_targets
          SET state = 'dead', lease_owner = NULL, lease_until = NULL,
              last_error = ?, updated_at = ?
          WHERE target_id = ?
        `).run(error, nowIso, row.target_id);
            }
            db.prepare(`
        UPDATE checkpoints
        SET state = ?
        WHERE checkpoint_id = ?
      `).run(row.target_id ? "failed-visible" : "dead-letter", row.checkpoint_id);
            db.prepare(`
        UPDATE memory_jobs
        SET state = 'dead', lease_owner = NULL, lease_until = NULL,
            last_error = ?, updated_at = ?
        WHERE job_id = ?
      `).run(error, nowIso, row.job_id);
            return null;
        }
        const firstOutstanding = db.prepare(`
      SELECT j.job_id
      FROM memory_jobs j
      LEFT JOIN checkpoints c ON c.checkpoint_id = j.checkpoint_id
      WHERE j.partition_key = ? AND j.state NOT IN ('completed','superseded','dead')
      ORDER BY CASE WHEN c.ordinal IS NULL THEN 1 ELSE 0 END,
               c.ordinal, j.created_at, j.job_id
      LIMIT 1
    `).get(row.partition_key);
        if (firstOutstanding?.job_id !== row.job_id)
            return null;
        const partitionBusy = db.prepare(`
      SELECT 1 FROM memory_jobs
      WHERE partition_key = ? AND job_id <> ? AND state = 'running'
        AND lease_until > ? LIMIT 1
    `).get(row.partition_key, row.job_id, nowIso);
        if (partitionBusy)
            return null;
        const reclaimable = (row.state === "pending" || row.state === "retry") &&
            row.available_at <= nowIso ||
            (row.state === "running" && (!row.lease_until || row.lease_until <= nowIso));
        if (!reclaimable || row.attempts >= row.max_attempts)
            return null;
        const generation = row.lease_generation + 1;
        const changed = db.prepare(`
      UPDATE memory_jobs
      SET state = 'running', lease_owner = ?, lease_until = ?,
          lease_generation = ?, attempts = attempts + 1, updated_at = ?
      WHERE job_id = ? AND lease_generation = ? AND state = ?
    `).run(input.owner, leaseUntil, generation, nowIso, row.job_id, row.lease_generation, row.state).changes;
        if (changed !== 1)
            return null;
        return db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(row.job_id);
    });
    return tx.immediate();
}
export function renewMemoryJobLease(db, input) {
    const now = input.now ?? new Date();
    const until = new Date(now.getTime() + (input.leaseMs ?? 30 * 60_000)).toISOString();
    return db.prepare(`
    UPDATE memory_jobs SET lease_until = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).run(until, now.toISOString(), input.jobId, input.owner, input.leaseGeneration, now.toISOString()).changes === 1;
}
export function completeMemoryJob(db, input) {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    return db.prepare(`
    UPDATE memory_jobs
    SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).run(nowIso, input.jobId, input.owner, input.leaseGeneration, nowIso).changes === 1;
}
export function failMemoryJob(db, input) {
    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const row = db.prepare(`
    SELECT attempts, max_attempts FROM memory_jobs
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).get(input.jobId, input.owner, input.leaseGeneration, nowIso);
    if (!row)
        return false;
    const retry = input.retry && row.attempts < row.max_attempts;
    const state = retry ? "retry" : "dead";
    const defaultBackoffMs = Math.min(60 * 60_000, 1000 * 2 ** Math.max(0, row.attempts - 1));
    const availableAt = input.availableAt ?? new Date(now.getTime() + defaultBackoffMs);
    return db.prepare(`
    UPDATE memory_jobs
    SET state = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
        last_error = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).run(state, availableAt.toISOString(), input.error, nowIso, input.jobId, input.owner, input.leaseGeneration, nowIso).changes === 1;
}
/** Create one immutable target from a claim-time snapshot, never live completion MAX. */
export function ensureExtractionTarget(db, input) {
    const ensure = db.transaction(() => {
        const policy = input.policyVersion ?? FACT_EXTRACTION_POLICY_VERSION;
        refreshExchangeMetadata(db, input.sessionId);
        const active = db.prepare(`
    SELECT t.*, j.job_id
    FROM extraction_targets t
    JOIN memory_jobs j ON j.target_id = t.target_id
    WHERE t.session_id = ? AND t.policy_version = ?
      AND t.state IN ('pending','running','retry')
    ORDER BY t.created_at, t.target_id LIMIT 1
  `).get(input.sessionId, policy);
        if (active)
            return targetFromRow(active);
        // A legacy session watermark is only a reporting/scheduling hint. Older
        // extractors used sampling and seed/permanent markers, so it cannot prove
        // that every generation below it was presented. Only an exact current
        // exchange_extraction_state='processed' row is completion authority.
        const firstOpen = db.prepare(`
    SELECT MIN(rowid) AS rowid FROM exchanges
    WHERE session_id = ? AND closure_state IN ('open','interrupted')
  `).get(input.sessionId).rowid;
        const items = db.prepare(`
    SELECT e.rowid AS exchange_rowid, e.id AS exchange_id,
           e.content_generation, e.content_hash
    FROM exchanges e
    LEFT JOIN exchange_extraction_state s
      ON s.exchange_id = e.id
     AND s.content_generation = e.content_generation
     AND s.policy_version = ?
     AND s.state = 'processed'
    WHERE e.session_id = ? AND e.closure_state IN ('closed','final')
      AND e.rowid < ?
      AND s.exchange_id IS NULL
    ORDER BY e.rowid
  `).all(policy, input.sessionId, firstOpen ?? Number.MAX_SAFE_INTEGER);
        if (items.length === 0)
            return null;
        // The immutable item snapshot is the exact cursor authority. Keep the rowid
        // fence contiguous around those items even when a legacy live-MAX marker
        // crossed unseen rows; the compatibility watermark is never used to skip a
        // missing generation.
        const fromRowid = Math.max(0, items[0].exchange_rowid - 1);
        const throughRowid = items[items.length - 1].exchange_rowid;
        const identity = items.map((item) => `${item.exchange_id}:${item.content_generation}:${item.content_hash}`).join("|");
        const targetId = sha256(`extract\0${input.sessionId}\0${fromRowid}\0${throughRowid}\0${policy}\0${identity}`);
        const identical = db.prepare(`
    SELECT t.*, j.job_id FROM extraction_targets t
    JOIN memory_jobs j ON j.target_id = t.target_id
    WHERE t.target_id = ?
  `).get(targetId);
        if (identical)
            return targetFromRow(identical);
        const now = input.now ?? new Date().toISOString();
        const checkpointId = sha256(`checkpoint\0${targetId}`);
        const tx = db.transaction(() => {
            db.prepare(`
      INSERT OR IGNORE INTO extraction_targets
        (target_id, session_id, project, from_rowid, through_rowid,
         item_count, policy_version, state, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(targetId, input.sessionId, input.project, fromRowid, throughRowid, items.length, policy, targetId, now, now);
            const insertItem = db.prepare(`
      INSERT OR IGNORE INTO extraction_target_items
        (target_id, ordinal, exchange_id, exchange_rowid, content_generation, content_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
            const pendingGeneration = db.prepare(`
      INSERT INTO exchange_extraction_state
        (exchange_id, content_generation, policy_version, state, target_id)
      VALUES (?, ?, ?, 'pending', ?)
      ON CONFLICT(exchange_id, content_generation, policy_version) DO UPDATE SET
        state = CASE WHEN exchange_extraction_state.state = 'processed'
                     THEN 'processed' ELSE 'pending' END,
        target_id = CASE WHEN exchange_extraction_state.state = 'processed'
                         THEN exchange_extraction_state.target_id ELSE excluded.target_id END
    `);
            items.forEach((item, index) => {
                insertItem.run(targetId, index + 1, item.exchange_id, item.exchange_rowid, item.content_generation, item.content_hash);
                pendingGeneration.run(item.exchange_id, item.content_generation, policy, targetId);
            });
            return createCheckpointWithJob(db, {
                checkpoint: {
                    checkpointId,
                    sessionId: input.sessionId,
                    ordinal: throughRowid,
                    kind: "extraction",
                    idempotencyKey: `checkpoint:${targetId}`,
                    fromCursor: fromRowid,
                    throughCursor: throughRowid,
                },
                job: {
                    kind: "fact_extract",
                    partitionKey: `session:${input.sessionId}`,
                    targetId,
                    policyVersion: policy,
                    priority: 20,
                    idempotencyKey: `fact_extract:${targetId}`,
                },
                now,
            });
        });
        const created = tx.immediate();
        return {
            targetId,
            jobId: created.jobId,
            sessionId: input.sessionId,
            fromRowid,
            throughRowid,
            cursorOrdinal: 0,
            itemCount: items.length,
            policyVersion: policy,
            state: "pending",
        };
    });
    return ensure.immediate();
}
function targetFromRow(row) {
    return {
        targetId: String(row.target_id),
        jobId: String(row.job_id),
        sessionId: String(row.session_id),
        fromRowid: Number(row.from_rowid),
        throughRowid: Number(row.through_rowid),
        cursorOrdinal: Number(row.cursor_ordinal),
        itemCount: Number(row.item_count),
        policyVersion: String(row.policy_version),
        state: row.state,
    };
}
export function readExtractionTargetItems(db, targetId, afterOrdinal, limit) {
    return db.prepare(`
    SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
    FROM extraction_target_items
    WHERE target_id = ? AND ordinal > ?
    ORDER BY ordinal LIMIT ?
  `).all(targetId, afterOrdinal, Math.max(1, Math.trunc(limit)));
}
export function recordExtractionFailure(db, input) {
    if (input.items.length === 0)
        return false;
    const now = input.now ?? new Date().toISOString();
    const first = input.items[0];
    const last = input.items[input.items.length - 1];
    if (input.items.some((item, index) => item.ordinal !== first.ordinal + index))
        return false;
    const tx = db.transaction(() => {
        const job = db.prepare(`
      SELECT job_id, attempts, max_attempts FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
        if (!job)
            return false;
        const targetOwned = db.prepare(`
      SELECT 1 FROM extraction_targets
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
        if (!targetOwned)
            return false;
        const exact = db.prepare(`
      SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
      FROM extraction_target_items
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(input.targetId, first.ordinal, last.ordinal);
        if (exact.length !== input.items.length ||
            exact.some((item, index) => item.ordinal !== input.items[index].ordinal ||
                item.exchange_id !== input.items[index].exchange_id ||
                item.exchange_rowid !== input.items[index].exchange_rowid ||
                item.content_generation !== input.items[index].content_generation ||
                item.content_hash !== input.items[index].content_hash))
            return false;
        const retry = input.retry && job.attempts < job.max_attempts;
        const state = retry ? "retry" : "failed-visible";
        const failureId = sha256(`${input.targetId}\0${first.ordinal}\0${last.ordinal}\0${input.payloadFingerprint}`);
        db.prepare(`
      INSERT INTO extraction_failed_ranges
        (failure_id, target_id, from_ordinal, through_ordinal, from_rowid,
         through_rowid, payload_fingerprint, error_kind, error_message,
         state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id, from_ordinal, through_ordinal, payload_fingerprint)
      DO UPDATE SET attempts = attempts + 1, error_kind = excluded.error_kind,
                    error_message = excluded.error_message, state = excluded.state,
                    updated_at = excluded.updated_at
    `).run(failureId, input.targetId, first.ordinal, last.ordinal, first.exchange_rowid, last.exchange_rowid, input.payloadFingerprint, input.errorKind, input.errorMessage, state, now, now);
        db.prepare(`
      UPDATE extraction_target_items SET state = ?
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
    `).run(state, input.targetId, first.ordinal, last.ordinal);
        db.prepare(`
      UPDATE exchange_extraction_state SET state = ?
      WHERE target_id = ? AND exchange_id IN (
        SELECT exchange_id FROM extraction_target_items
        WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      )
    `).run(state, input.targetId, input.targetId, first.ordinal, last.ordinal);
        const targetChanged = db.prepare(`
      UPDATE extraction_targets
      SET state = ?, lease_owner = NULL, lease_until = NULL,
          last_error = ?, attempts = attempts + 1, updated_at = ?
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(retry ? "retry" : "dead", input.errorMessage, now, input.targetId, input.owner, input.leaseGeneration, now).changes;
        if (targetChanged !== 1)
            throw new ContinuityCasRejected();
        db.prepare(`
      UPDATE checkpoints SET state = ?
      WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)
    `).run(retry ? "retry" : "failed-visible", job.job_id);
        if (!failMemoryJob(db, {
            jobId: job.job_id,
            owner: input.owner,
            leaseGeneration: input.leaseGeneration,
            error: input.errorMessage,
            retry: input.retry,
            now: new Date(now),
        }))
            throw new ContinuityCasRejected();
        return true;
    });
    try {
        return tx.immediate();
    }
    catch (error) {
        if (error instanceof ContinuityCasRejected)
            return false;
        throw error;
    }
}
/**
 * Retire a claim whose immutable exchange generation changed while async work
 * was running. This is not a failed-visible extraction: the captured
 * generation is obsolete, and the current generation must form a new target.
 */
export function supersedeStaleExtractionTarget(db, input) {
    const now = input.now ?? new Date().toISOString();
    const supersede = db.transaction(() => {
        const job = db.prepare(`
      SELECT job_id, checkpoint_id FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
        if (!job)
            return false;
        const targetOwned = db.prepare(`
      SELECT 1 FROM extraction_targets
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
        if (!targetOwned)
            return false;
        const stale = db.prepare(`
      SELECT 1 FROM extraction_target_items i
      LEFT JOIN exchanges e ON e.id = i.exchange_id
      WHERE i.target_id = ? AND i.state <> 'processed'
        AND (e.id IS NULL OR e.content_generation <> i.content_generation
          OR e.content_hash <> i.content_hash
          OR e.closure_state NOT IN ('closed','final'))
      LIMIT 1
    `).get(input.targetId);
        if (!stale)
            return false;
        db.prepare(`
      UPDATE extraction_target_items SET state = 'superseded'
      WHERE target_id = ? AND state <> 'processed'
    `).run(input.targetId);
        db.prepare(`
      UPDATE exchange_extraction_state SET state = 'superseded'
      WHERE target_id = ? AND state <> 'processed'
    `).run(input.targetId);
        const targetChanges = db.prepare(`
      UPDATE extraction_targets
      SET state = 'superseded', lease_owner = NULL, lease_until = NULL,
          last_error = 'exchange generation changed during extraction', updated_at = ?
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(now, input.targetId, input.owner, input.leaseGeneration, now).changes;
        if (targetChanges !== 1)
            throw new ContinuityCasRejected();
        const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'superseded'
      WHERE checkpoint_id = ?
    `).run(job.checkpoint_id).changes;
        if (checkpointChanges !== 1)
            throw new ContinuityCasRejected();
        const jobChanges = db.prepare(`
      UPDATE memory_jobs
      SET state = 'superseded', lease_owner = NULL, lease_until = NULL,
          last_error = 'exchange generation changed during extraction', updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(now, job.job_id, input.owner, input.leaseGeneration, now).changes;
        if (jobChanges !== 1)
            throw new ContinuityCasRejected();
        return true;
    });
    try {
        return supersede.immediate();
    }
    catch (error) {
        if (error instanceof ContinuityCasRejected)
            return false;
        throw error;
    }
}
export function commitExtractionPage(db, input) {
    if (input.items.length === 0)
        return false;
    const first = input.items[0];
    const last = input.items[input.items.length - 1];
    if (input.items.some((item, index) => item.ordinal !== first.ordinal + index))
        return false;
    const commit = db.transaction(() => {
        const now = input.now ?? new Date().toISOString();
        const target = db.prepare(`
      SELECT session_id, from_rowid, through_rowid, cursor_ordinal, item_count,
             state, lease_owner, lease_until, lease_generation
      FROM extraction_targets WHERE target_id = ?
    `).get(input.target.targetId);
        if (!target ||
            target.session_id !== input.target.sessionId ||
            target.from_rowid !== input.target.fromRowid ||
            target.through_rowid !== input.target.throughRowid ||
            target.item_count !== input.target.itemCount ||
            target.cursor_ordinal !== input.target.cursorOrdinal ||
            target.state !== "running" ||
            target.lease_owner !== input.owner ||
            target.lease_generation !== input.leaseGeneration ||
            !target.lease_until ||
            target.lease_until <= now ||
            first.ordinal !== target.cursor_ordinal + 1 ||
            last.ordinal > target.item_count)
            return false;
        const exact = db.prepare(`
      SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
      FROM extraction_target_items
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(input.target.targetId, first.ordinal, last.ordinal);
        if (exact.length !== input.items.length ||
            exact.some((item, index) => item.ordinal !== input.items[index].ordinal ||
                item.exchange_id !== input.items[index].exchange_id ||
                item.exchange_rowid !== input.items[index].exchange_rowid ||
                item.content_generation !== input.items[index].content_generation ||
                item.content_hash !== input.items[index].content_hash))
            return false;
        const current = db.prepare(`
      SELECT COUNT(*) AS n FROM extraction_target_items i
      JOIN exchanges e ON e.id = i.exchange_id
      WHERE i.target_id = ? AND i.ordinal BETWEEN ? AND ?
        AND e.content_generation = i.content_generation
        AND e.content_hash = i.content_hash
        AND e.closure_state IN ('closed','final')
    `).get(input.target.targetId, first.ordinal, last.ordinal);
        if (current.n !== input.items.length)
            return false;
        const owned = db.prepare(`
      SELECT job_id FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.target.targetId, input.owner, input.leaseGeneration, now);
        if (!owned)
            return false;
        const itemChanges = db.prepare(`
      UPDATE extraction_target_items SET state = 'processed'
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
        AND state IN ('pending','processing','retry')
    `).run(input.target.targetId, first.ordinal, last.ordinal).changes;
        if (itemChanges !== input.items.length)
            throw new ContinuityCasRejected();
        input.afterWrite?.("target-items");
        const generationChanges = db.prepare(`
      UPDATE exchange_extraction_state
      SET state = 'processed', processed_at = ?
      WHERE target_id = ? AND exchange_id IN (
        SELECT exchange_id FROM extraction_target_items
        WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ) AND state IN ('pending','processing','retry')
    `).run(now, input.target.targetId, input.target.targetId, first.ordinal, last.ordinal).changes;
        if (generationChanges !== input.items.length)
            throw new ContinuityCasRejected();
        input.afterWrite?.("generation-state");
        const completed = last.ordinal === target.item_count;
        const targetChanges = db.prepare(`
      UPDATE extraction_targets
      SET cursor_ordinal = ?, state = ?, lease_owner = NULL, lease_until = NULL,
          updated_at = ?
      WHERE target_id = ? AND cursor_ordinal = ? AND state = 'running'
        AND lease_owner = ? AND lease_generation = ? AND lease_until > ?
    `).run(last.ordinal, completed ? "completed" : "pending", now, input.target.targetId, input.target.cursorOrdinal, input.owner, input.leaseGeneration, now).changes;
        if (targetChanges !== 1)
            throw new ContinuityCasRejected();
        input.afterWrite?.("target-cursor");
        const contiguousWatermark = completed
            ? target.through_rowid
            : Math.max(target.from_rowid, last.exchange_rowid);
        db.prepare(`
      INSERT INTO extraction_log
        (session_id, processed_at, extracted, saved, dropped_batches,
         claim_owner, last_exchange_rowid)
      VALUES (?, ?, ?, ?, 0, NULL, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        processed_at = excluded.processed_at,
        extracted = CASE WHEN extraction_log.extracted < 0 THEN excluded.extracted
                         ELSE extraction_log.extracted + excluded.extracted END,
        saved = CASE WHEN extraction_log.saved < 0 THEN excluded.saved
                     ELSE extraction_log.saved + excluded.saved END,
        dropped_batches = 0,
        claim_owner = NULL,
        last_exchange_rowid = MAX(extraction_log.last_exchange_rowid,
                                  excluded.last_exchange_rowid)
    `).run(target.session_id, now, input.extracted, input.saved, contiguousWatermark);
        input.afterWrite?.("compatibility-watermark");
        if (completed) {
            const checkpointChanges = db.prepare(`
        UPDATE checkpoints SET state = 'processed'
        WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)
      `).run(owned.job_id).changes;
            if (checkpointChanges !== 1)
                throw new ContinuityCasRejected();
            input.afterWrite?.("checkpoint");
            if (!completeMemoryJob(db, {
                jobId: owned.job_id,
                owner: input.owner,
                leaseGeneration: input.leaseGeneration,
                now: new Date(now),
            }))
                throw new ContinuityCasRejected();
            input.afterWrite?.("job");
            return true;
        }
        const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'pending'
      WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)
    `).run(owned.job_id).changes;
        if (checkpointChanges !== 1)
            throw new ContinuityCasRejected();
        input.afterWrite?.("checkpoint");
        const jobChanges = db.prepare(`
      UPDATE memory_jobs
      SET state = 'pending', from_cursor = ?, attempts = 0,
          lease_owner = NULL, lease_until = NULL,
          updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(contiguousWatermark, now, owned.job_id, input.owner, input.leaseGeneration, now).changes;
        if (jobChanges !== 1)
            throw new ContinuityCasRejected();
        input.afterWrite?.("job");
        return true;
    });
    try {
        return commit.immediate();
    }
    catch (error) {
        if (error instanceof ContinuityCasRejected)
            return false;
        throw error;
    }
}
export function claimExtractionTarget(db, target, owner = randomUUID(), now = new Date()) {
    const claim = db.transaction(() => {
        const job = claimMemoryJobById(db, { jobId: target.jobId, owner, now });
        if (!job)
            return null;
        const changed = db.prepare(`
      UPDATE extraction_targets
      SET state = 'running', lease_owner = ?, lease_until = ?,
          lease_generation = ?, attempts = attempts + 1, updated_at = ?
      WHERE target_id = ? AND state IN ('pending','retry','running')
        AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)
    `).run(owner, job.lease_until, job.lease_generation, now.toISOString(), target.targetId, now.toISOString(), owner).changes;
        if (changed !== 1)
            throw new ContinuityCasRejected();
        const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'processing'
      WHERE checkpoint_id = ?
    `).run(job.checkpoint_id).changes;
        if (checkpointChanges !== 1)
            throw new ContinuityCasRejected();
        const row = db.prepare(`
      SELECT t.*, j.job_id FROM extraction_targets t
      JOIN memory_jobs j ON j.target_id = t.target_id WHERE t.target_id = ?
    `).get(target.targetId);
        return { target: targetFromRow(row), owner, leaseGeneration: job.lease_generation };
    });
    try {
        return claim.immediate();
    }
    catch (error) {
        if (error instanceof ContinuityCasRejected)
            return null;
        throw error;
    }
}
