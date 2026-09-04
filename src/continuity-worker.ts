import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type Database from "better-sqlite3";
import {
  claimMemoryJobById,
  failMemoryJob,
} from "./continuity-store.js";
import {
  applyLatestLifecycleClosure,
  applyWorkCapsulePatch,
  completeEmptyCapsuleCheckpoint,
  readWorkCapsule,
  validateWorkCapsulePatch,
  type WorkCapsulePatch,
} from "./continuity-core.js";
import { parseConversation } from "./codex-rollout.js";
import { ingestPrefixExchanges } from "./archive-ingestion.js";
import { callMemoryModel } from "./llm.js";
import type { ConversationExchange } from "./types.js";
import {
  isUserExcludedConversation,
  isConversationExcludedSession,
  purgeConversationFromIndex,
} from "./conversation-policy.js";
import { indexHotEvidenceForSession } from "./continuity-identity.js";

const CAPSULE_SYSTEM_PROMPT = `You update a bounded Work Capsule from one contiguous transcript segment.
Return exactly one JSON object and no markdown. It must have exactly these keys:
{"objective":"","currentState":"","verifiedProgress":[],"hypotheses":[],"blockers":[],"openQuestions":[],"nextActions":[],"touchedAreas":[],"carryFactRevisions":[],"sourceExchangeIds":[]}
Each verifiedProgress/hypotheses item must be exactly
{"text":"short claim","sourceExchangeIds":["exact contiguousSegment.exchangeId"]}.
Use only exchange IDs present in contiguousSegment, and declare every used ID
in the top-level sourceExchangeIds. verifiedProgress may use only human
assertions or trusted repo/git/test tool evidence. Assistant prose is context
only; if it suggests an unverified possibility, place it under hypotheses.
All other list items are short strings; carryFactRevisions may only preserve
exact triples already present in previousCapsule. Never invent results, causes,
file changes, completion, IDs, or revisions. Keep the JSON under 1500
characters, each text under 500 characters, and every list at eight items.`;

export interface ContinuityWorkerResult {
  jobId: string;
  kind: "capture_index" | "capsule_update";
  state: "completed" | "retry" | "dead" | "stale" | "deferred";
  detail: string;
}

type ModelCall = (system: string, user: string) => Promise<string>;

function nextJob(
  db: Database.Database,
  kind: "capture_index" | "capsule_update",
  now: string,
): { job_id: string } | null {
  return db.prepare(`
    SELECT j.job_id
    FROM memory_jobs j
    LEFT JOIN checkpoints c ON c.checkpoint_id = j.checkpoint_id
    WHERE j.kind = ? AND j.state IN ('pending','retry') AND j.available_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM memory_jobs earlier
        LEFT JOIN checkpoints ec ON ec.checkpoint_id = earlier.checkpoint_id
        WHERE earlier.partition_key = j.partition_key
          AND earlier.state IN ('pending','retry','running')
          AND (earlier.priority > j.priority
            OR (earlier.priority = j.priority
              AND (COALESCE(ec.ordinal, 0) < COALESCE(c.ordinal, 0)
                OR (COALESCE(ec.ordinal, 0) = COALESCE(c.ordinal, 0)
                  AND earlier.created_at < j.created_at))))
      )
    ORDER BY j.priority DESC, COALESCE(c.ordinal, 0), j.created_at, j.job_id
    LIMIT 1
  `).get(kind, now) as { job_id: string } | undefined ?? null;
}

function checkpointRow(db: Database.Database, checkpointId: string): {
  checkpoint_id: string;
  session_id: string;
  workstream_id: string;
  stream_epoch: number;
  from_line: number;
  through_line: number;
  through_byte: number;
  journal_through_byte: number;
  prefix_hash: string;
  journal_path: string;
  project: string;
} {
  const row = db.prepare(`
    SELECT c.checkpoint_id, c.session_id, c.workstream_id, c.stream_epoch,
           c.from_line, c.through_line, c.through_byte, c.prefix_hash,
           COALESCE((
             SELECT MAX(b.journal_through_byte) FROM journal_blocks b
             WHERE b.session_id = c.session_id AND b.stream_epoch = c.stream_epoch
               AND b.source_through_byte <= c.through_byte
           ), 0) AS journal_through_byte,
           s.journal_path, m.project
    FROM checkpoints c
    JOIN journal_streams s
      ON s.session_id = c.session_id AND s.stream_epoch = c.stream_epoch
    JOIN session_memory_state m ON m.session_id = c.session_id
    WHERE c.checkpoint_id = ?
  `).get(checkpointId) as ReturnType<typeof checkpointRow> | undefined;
  if (!row) throw new Error("continuity checkpoint or journal stream is missing");
  return row;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyCheckpointJournal(
  db: Database.Database,
  checkpoint: ReturnType<typeof checkpointRow>,
): void {
  const stat = fs.statSync(checkpoint.journal_path);
  if (stat.size < checkpoint.journal_through_byte) {
    throw new Error("journal is shorter than checkpoint boundary");
  }
  const blocks = db.prepare(`
    SELECT journal_from_byte, journal_through_byte, segment_hash, prefix_hash
    FROM journal_blocks
    WHERE session_id = ? AND stream_epoch = ? AND source_through_byte <= ?
    ORDER BY ordinal
  `).all(
    checkpoint.session_id,
    checkpoint.stream_epoch,
    checkpoint.through_byte,
  ) as Array<{
    journal_from_byte: number;
    journal_through_byte: number;
    segment_hash: string;
    prefix_hash: string;
  }>;
  const fd = fs.openSync(checkpoint.journal_path, "r");
  let expectedOffset = 0;
  let prefixHash = "";
  try {
    for (const block of blocks) {
      if (block.journal_from_byte !== expectedOffset || block.journal_through_byte < expectedOffset) {
        throw new Error("journal block chain is not contiguous");
      }
      const bytes = Buffer.alloc(block.journal_through_byte - block.journal_from_byte);
      const read = fs.readSync(fd, bytes, 0, bytes.length, block.journal_from_byte);
      if (read !== bytes.length || sha256(bytes) !== block.segment_hash) {
        throw new Error("journal segment hash mismatch");
      }
      prefixHash = sha256(Buffer.concat([
        Buffer.from(prefixHash, "utf8"),
        Buffer.from([0]),
        bytes,
      ]));
      if (prefixHash !== block.prefix_hash) throw new Error("journal prefix hash mismatch");
      expectedOffset = block.journal_through_byte;
    }
  } finally {
    fs.closeSync(fd);
  }
  const expectedPrefix = prefixHash || sha256(Buffer.alloc(0));
  if (
    expectedOffset !== checkpoint.journal_through_byte ||
    expectedPrefix !== checkpoint.prefix_hash
  ) {
    throw new Error("checkpoint journal boundary or prefix hash mismatch");
  }
}

function completeCaptureIndexJob(
  db: Database.Database,
  input: { jobId: string; checkpointId: string; owner: string; leaseGeneration: number; now: string },
): boolean {
  const tx = db.transaction(() => {
    const completed = db.prepare(`
      UPDATE memory_jobs
      SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE job_id = ? AND kind = 'capture_index' AND checkpoint_id = ?
        AND state = 'running' AND lease_owner = ? AND lease_generation = ?
        AND lease_until > ?
    `).run(
      input.now,
      input.jobId,
      input.checkpointId,
      input.owner,
      input.leaseGeneration,
      input.now,
    );
    if (completed.changes !== 1) return false;
    const capsulePending = db.prepare(`
      SELECT 1 FROM memory_jobs
      WHERE checkpoint_id = ? AND kind = 'capsule_update'
        AND state NOT IN ('completed','superseded','dead')
      LIMIT 1
    `).get(input.checkpointId);
    if (!capsulePending) {
      db.prepare("UPDATE checkpoints SET state = 'processed' WHERE checkpoint_id = ?")
        .run(input.checkpointId);
    }
    return true;
  });
  return tx.immediate();
}

async function processCaptureIndex(
  db: Database.Database,
  jobId: string,
  owner: string,
  now: Date,
  beforePrefixIngest?: () => void,
): Promise<ContinuityWorkerResult> {
  const claim = claimMemoryJobById(db, { jobId, owner, now, leaseMs: 5 * 60_000 });
  if (!claim || !claim.checkpoint_id) {
    return { jobId, kind: "capture_index", state: "deferred", detail: "claim unavailable" };
  }
  try {
    const checkpoint = checkpointRow(db, claim.checkpoint_id);
    if (!fs.existsSync(checkpoint.journal_path)) throw new Error("journal file is missing");
    verifyCheckpointJournal(db, checkpoint);
    if (
      isConversationExcludedSession(db, checkpoint.session_id) ||
      await isUserExcludedConversation(checkpoint.journal_path)
    ) {
      purgeConversationFromIndex(db, {
        archivePath: checkpoint.journal_path,
        sessionId: checkpoint.session_id,
      });
      return {
        jobId,
        kind: "capture_index",
        state: "completed",
        detail: "purged user-excluded conversation",
      };
    }
    const parsed = await parseConversation(
      checkpoint.journal_path,
      checkpoint.project,
      checkpoint.journal_path,
      checkpoint.journal_through_byte,
    ) as unknown as ConversationExchange[];
    const prefix = parsed.filter(
      (exchange) => exchange.sessionId === checkpoint.session_id &&
        exchange.lineEnd <= checkpoint.through_line,
    );
    beforePrefixIngest?.();
    if (isConversationExcludedSession(db, checkpoint.session_id)) {
      purgeConversationFromIndex(db, {
        archivePath: checkpoint.journal_path,
        sessionId: checkpoint.session_id,
      });
      return {
        jobId,
        kind: "capture_index",
        state: "completed",
        detail: "purged user-excluded conversation",
      };
    }
    const result = await ingestPrefixExchanges(db, prefix);
    if (isConversationExcludedSession(db, checkpoint.session_id)) {
      purgeConversationFromIndex(db, {
        archivePath: checkpoint.journal_path,
        sessionId: checkpoint.session_id,
      });
      return {
        jobId,
        kind: "capture_index",
        state: "completed",
        detail: "purged user-excluded conversation",
      };
    }
    applyLatestLifecycleClosure(db, checkpoint.session_id);
    const hotEvidence = indexHotEvidenceForSession(db, checkpoint.session_id);
    if (isConversationExcludedSession(db, checkpoint.session_id)) {
      purgeConversationFromIndex(db, {
        archivePath: checkpoint.journal_path,
        sessionId: checkpoint.session_id,
      });
      return {
        jobId,
        kind: "capture_index",
        state: "completed",
        detail: "purged user-excluded conversation",
      };
    }
    if (!completeCaptureIndexJob(db, {
      jobId,
      checkpointId: checkpoint.checkpoint_id,
      owner,
      leaseGeneration: claim.lease_generation,
      now: new Date().toISOString(),
    })) {
      return { jobId, kind: "capture_index", state: "stale", detail: "lease lost before completion" };
    }
    return {
      jobId,
      kind: "capture_index",
      state: "completed",
      detail: `indexed=${result.indexed} ignored=${result.ignoredRegressions} hot=${hotEvidence}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failMemoryJob(db, {
      jobId,
      owner,
      leaseGeneration: claim.lease_generation,
      error: message,
      retry: true,
      now: new Date(),
    });
    const state = (db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { state?: string } | undefined)?.state;
    return {
      jobId,
      kind: "capture_index",
      state: state === "dead" ? "dead" : "retry",
      detail: message,
    };
  }
}

function capsuleEvidence(
  db: Database.Database,
  checkpoint: ReturnType<typeof checkpointRow>,
  previousCheckpointId: string | null,
): Array<Record<string, unknown>> {
  const previous = previousCheckpointId
    ? db.prepare(`
        SELECT session_id, stream_epoch, through_line
        FROM checkpoints WHERE checkpoint_id = ?
      `).get(previousCheckpointId) as {
        session_id: string;
        stream_epoch: number;
        through_line: number;
      } | undefined
    : undefined;
  const fromLine = previous &&
      previous.session_id === checkpoint.session_id &&
      previous.stream_epoch === checkpoint.stream_epoch
    ? previous.through_line + 1
    : 0;
  const rows = db.prepare(`
    SELECT id, user_message, assistant_message, line_start, line_end
    FROM exchanges
    WHERE session_id = ? AND line_end >= ? AND line_start <= ?
    ORDER BY exchange_seq, rowid
  `).all(
    checkpoint.session_id,
    fromLine,
    checkpoint.through_line,
  ) as Array<{
    id: string;
    user_message: string;
    assistant_message: string;
    line_start: number;
    line_end: number;
  }>;
  const trustedTools = db.prepare(`
    SELECT id, tool_name, tool_result, source_type
    FROM tool_calls
    WHERE exchange_id = ? AND learnable = 1
      AND source_type IN ('repo_file','git_history','test_execution')
    ORDER BY timestamp, id
  `);
  return rows.map((row) => ({
    exchangeId: row.id,
    lines: [row.line_start, row.line_end],
    human: row.user_message,
    assistantContextOnly: row.assistant_message,
    trustedTools: trustedTools.all(row.id),
  }));
}

async function processCapsule(
  db: Database.Database,
  jobId: string,
  owner: string,
  now: Date,
  model: ModelCall,
): Promise<ContinuityWorkerResult> {
  const pending = db.prepare(`
    SELECT j.checkpoint_id FROM memory_jobs j
    WHERE j.job_id = ? AND EXISTS (
      SELECT 1 FROM memory_jobs capture
      WHERE capture.checkpoint_id = j.checkpoint_id
        AND capture.kind = 'capture_index' AND capture.state <> 'completed'
    )
  `).get(jobId);
  if (pending) {
    return { jobId, kind: "capsule_update", state: "deferred", detail: "capture index not complete" };
  }
  const claim = claimMemoryJobById(db, { jobId, owner, now, leaseMs: 5 * 60_000 });
  if (!claim || !claim.checkpoint_id) {
    return { jobId, kind: "capsule_update", state: "deferred", detail: "claim unavailable" };
  }
  try {
    const checkpoint = checkpointRow(db, claim.checkpoint_id);
    const state = db.prepare(`
      SELECT expected_generation FROM capsule_checkpoint_state WHERE checkpoint_id = ?
    `).get(checkpoint.checkpoint_id) as { expected_generation: number } | undefined;
    if (!state) throw new Error("capsule checkpoint state is missing");
    const previous = readWorkCapsule(db, checkpoint.workstream_id);
    const expectedGeneration = previous?.generation ?? 0;
    db.prepare(`
      UPDATE capsule_checkpoint_state
      SET state = 'processing', expected_generation = ?, last_error = NULL, updated_at = ?
      WHERE checkpoint_id = ?
    `).run(expectedGeneration, new Date().toISOString(), checkpoint.checkpoint_id);
    const evidence = capsuleEvidence(db, checkpoint, previous?.throughCheckpointId ?? null);
    if (evidence.length === 0) {
      if (!completeEmptyCapsuleCheckpoint(db, {
        checkpointId: checkpoint.checkpoint_id,
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
      })) {
        return { jobId, kind: "capsule_update", state: "stale", detail: "lease lost" };
      }
      return { jobId, kind: "capsule_update", state: "completed", detail: "empty segment" };
    }
    const response = await model(
      CAPSULE_SYSTEM_PROMPT,
      JSON.stringify({
        previousCapsule: previous,
        contiguousSegment: evidence,
      }),
    );
    let parsed: Record<string, unknown> | null = null;
    try {
      const exact = JSON.parse(response);
      parsed = exact && typeof exact === "object" && !Array.isArray(exact)
        ? exact as Record<string, unknown>
        : null;
    } catch { /* exact JSON is mandatory */ }
    if (!parsed) throw new Error("capsule model returned invalid JSON");
    const patch: WorkCapsulePatch = validateWorkCapsulePatch(parsed);
    const applied = applyWorkCapsulePatch(db, {
      workstreamId: checkpoint.workstream_id,
      expectedGeneration,
      throughCheckpointId: checkpoint.checkpoint_id,
      patch,
      jobLease: {
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
      },
    });
    if (!applied) {
      const deferred = failMemoryJob(db, {
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
        error: "capsule generation changed during model call",
        retry: true,
        now: new Date(),
      });
      if (deferred) {
        const currentGeneration = readWorkCapsule(db, checkpoint.workstream_id)?.generation ?? 0;
        db.prepare(`
          UPDATE capsule_checkpoint_state
          SET state = 'retry', expected_generation = ?,
              last_error = 'capsule generation changed during model call', updated_at = ?
          WHERE checkpoint_id = ?
        `).run(currentGeneration, new Date().toISOString(), checkpoint.checkpoint_id);
      }
      return { jobId, kind: "capsule_update", state: "stale", detail: "generation CAS rejected" };
    }
    return { jobId, kind: "capsule_update", state: "completed", detail: `generation=${applied.generation}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const deferred = failMemoryJob(db, {
      jobId,
      owner,
      leaseGeneration: claim.lease_generation,
      error: message,
      retry: true,
      now: new Date(),
    });
    if (deferred) {
      db.prepare(`
        UPDATE capsule_checkpoint_state SET state = 'retry', last_error = ?, updated_at = ?
        WHERE checkpoint_id = ?
      `).run(message.slice(0, 1_000), new Date().toISOString(), claim.checkpoint_id);
    }
    const state = (db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { state?: string } | undefined)?.state;
    return {
      jobId,
      kind: "capsule_update",
      state: state === "dead" ? "dead" : "retry",
      detail: message,
    };
  }
}

export async function runContinuityWorker(
  db: Database.Database,
  options: {
    maxJobs?: number;
    owner?: string;
    now?: Date;
    model?: ModelCall;
    beforePrefixIngest?: () => void;
  } = {},
): Promise<ContinuityWorkerResult[]> {
  const maxJobs = Math.max(1, Math.min(32, options.maxJobs ?? 8));
  const owner = options.owner ?? randomUUID();
  const model = options.model ?? ((system, user) => callMemoryModel(system, user, 2_048));
  const results: ContinuityWorkerResult[] = [];
  for (let index = 0; index < maxJobs; index++) {
    const now = options.now ?? new Date();
    const capture = nextJob(db, "capture_index", now.toISOString());
    if (capture) {
      results.push(await processCaptureIndex(
        db,
        capture.job_id,
        owner,
        now,
        options.beforePrefixIngest,
      ));
      continue;
    }
    const capsule = nextJob(db, "capsule_update", now.toISOString());
    if (capsule) {
      const result = await processCapsule(db, capsule.job_id, owner, now, model);
      results.push(result);
      if (result.state === "deferred") break;
      continue;
    }
    break;
  }
  return results;
}
