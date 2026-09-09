import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import type Database from "better-sqlite3";
import {
  claimMemoryJobById,
  failMemoryJob,
} from "./continuity-store.js";
import {
  applyLatestLifecycleClosure,
  CAPTURE_CHUNK_BYTES,
  WORK_CAPSULE_OUTPUT_SCHEMA,
  applyWorkCapsulePatch,
  completeEmptyCapsuleCheckpoint,
  readWorkCapsule,
  scheduleCapsuleBacklog,
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
import {
  appendSessionEvidence,
  readCapsulePage,
  shrinkCapsulePageHint,
  skipCapsuleEvidenceHead,
  type CapsulePage,
} from "./continuity-evidence.js";
import { indexHotEvidenceForSession } from "./continuity-identity.js";
import {
  deferMemoryJobForModelBudget,
  ensureModelBudgetSchema,
  findExhaustedModelBudgetForClaim,
  isModelBudgetExhausted,
  withResolvedModelWorkContext,
} from "./model-budget.js";

const CAPSULE_SYSTEM_PROMPT = `You update a bounded Work Capsule from one ordered workstream evidence page.
contiguousSegment can include multiple sessions and immutable content generations.
Long exchanges arrive as labeled parts; textOffset is a UTF-16 code-unit offset.
Do not assume a part is the whole exchange or that all parts arrive in this page.
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
  state: "completed" | "partial" | "retry" | "dead" | "stale" | "deferred";
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
        SELECT 1 FROM model_work_budgets mb
        WHERE mb.budget_id = j.budget_id AND mb.state IN ('exhausted','cancelled')
      )
      AND NOT EXISTS (
        SELECT 1 FROM memory_jobs earlier
        LEFT JOIN checkpoints ec ON ec.checkpoint_id = earlier.checkpoint_id
        WHERE earlier.partition_key = j.partition_key
          AND earlier.state IN ('pending','retry','running')
          AND (earlier.priority > j.priority
            OR (earlier.priority = j.priority
              AND (CASE WHEN earlier.kind = 'capsule_update' THEN earlier.rowid ELSE COALESCE(ec.ordinal, 0) END < CASE WHEN j.kind = 'capsule_update' THEN j.rowid ELSE COALESCE(c.ordinal, 0) END
                OR (CASE WHEN earlier.kind = 'capsule_update' THEN earlier.rowid ELSE COALESCE(ec.ordinal, 0) END = CASE WHEN j.kind = 'capsule_update' THEN j.rowid ELSE COALESCE(c.ordinal, 0) END
                  AND earlier.created_at < j.created_at))))
      )
    ORDER BY j.priority DESC, CASE WHEN j.kind = 'capsule_update' THEN j.rowid ELSE COALESCE(c.ordinal, 0) END, j.created_at, j.job_id
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
  const buffer = Buffer.alloc(CAPTURE_CHUNK_BYTES);
  let expectedOffset = 0;
  let prefixHash = "";
  try {
    for (const block of blocks) {
      if (block.journal_from_byte !== expectedOffset || block.journal_through_byte < expectedOffset) {
        throw new Error("journal block chain is not contiguous");
      }
      const segment = createHash("sha256");
      const prefix = createHash("sha256").update(prefixHash, "utf8").update(Buffer.from([0]));
      for (let offset = block.journal_from_byte; offset < block.journal_through_byte;) {
        const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, block.journal_through_byte - offset), offset);
        if (!read) throw new Error("journal segment hash mismatch");
        segment.update(buffer.subarray(0, read));
        prefix.update(buffer.subarray(0, read));
        offset += read;
      }
      if (segment.digest("hex") !== block.segment_hash) throw new Error("journal segment hash mismatch");
      prefixHash = prefix.digest("hex");
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
    ).map((exchange) => {
      if (checkpoint.stream_epoch === 0) return exchange;
      // A replaced transcript can reuse user-line positions with different or
      // shorter content. Give the new journal epoch its own immutable identity
      // instead of defeating insertExchange's monotonic old-prefix guard.
      const id = sha256(`${exchange.id}\0journal-epoch:${checkpoint.stream_epoch}`);
      return { ...exchange, id, toolCalls: exchange.toolCalls?.map((tool) => ({
        ...tool, exchangeId: id, id: sha256(`${tool.id}\0${id}`),
      })) };
    });
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
    const transition = failMemoryJob(db, {
      jobId,
      owner,
      leaseGeneration: claim.lease_generation,
      error: message,
      retry: true,
      now: new Date(),
    });
    // Issue #34: the queue's own transition is authoritative. Only a lost CAS
    // (null) has to fall back to reading the row someone else moved.
    const state = transition ?? (db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { state?: string } | undefined)?.state;
    return {
      jobId,
      kind: "capture_index",
      state: state === "dead" ? "dead" : "retry",
      detail: message,
    };
  }
}

async function processCapsule(
  db: Database.Database,
  jobId: string,
  owner: string,
  now: Date,
  model: ModelCall,
  budgeted: boolean,
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
  // Issue #12: a claim burns one attempt, so an already-dead budget must be
  // found before the claim, not inside the model call it can no longer make.
  const spentBudget = budgeted
    ? findExhaustedModelBudgetForClaim(db, {
        jobId,
        budgetId: process.env.MEMEX_MODEL_BUDGET_ID?.trim() || null,
        now,
      })
    : null;
  if (spentBudget) {
    return {
      jobId,
      kind: "capsule_update",
      state: "deferred",
      // Issue #14: name the exit, not just the wall. The pre-claim check has
      // just made the budget durably exhausted, so this command now works.
      detail:
        `model work budget exhausted: ${spentBudget.reason}` +
        ` — memex model-work resume ${spentBudget.budgetId} --new-run`,
    };
  }
  const claim = claimMemoryJobById(db, { jobId, owner, now, leaseMs: 5 * 60_000 });
  if (!claim || !claim.checkpoint_id) {
    return { jobId, kind: "capsule_update", state: "deferred", detail: "claim unavailable" };
  }
  // Issue #33: the failure path needs the exact page this attempt read, so the
  // frontier can record partial progress instead of freezing the workstream.
  let attemptPage: CapsulePage | null = null;
  let attemptWorkstreamId: string | null = null;
  try {
    const checkpoint = checkpointRow(db, claim.checkpoint_id);
    attemptWorkstreamId = checkpoint.workstream_id;
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
    // Existing exchanges can predate session binding. Backfill only that
    // session's missing immutable generations before freezing this job target.
    appendSessionEvidence(db, checkpoint.session_id);
    const page = db.transaction(() => readCapsulePage(db, checkpoint.checkpoint_id)).immediate();
    attemptPage = page;
    const evidence = page.evidence;
    if (evidence.length === 0) {
      if (!completeEmptyCapsuleCheckpoint(db, {
        checkpointId: checkpoint.checkpoint_id,
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
        evidencePage: page,
      })) {
        return { jobId, kind: "capsule_update", state: "stale", detail: "lease lost" };
      }
      return { jobId, kind: "capsule_update", state: "completed", detail: "empty segment" };
    }
    const modelInput = JSON.stringify({
      previousCapsule: previous,
      contiguousSegment: evidence,
    });
    const invoke = () => model(CAPSULE_SYSTEM_PROMPT, modelInput);
    const response = budgeted
      ? await withResolvedModelWorkContext(
          {
            db,
            parentWaveId:
              process.env.MEMEX_MAINTENANCE_WAVE_ID ||
              `continuity:${checkpoint.workstream_id}`,
            stage: "capsule",
            jobId,
            targetId: checkpoint.checkpoint_id,
          },
          invoke,
        )
      : await invoke();
    let parsed: Record<string, unknown> | null = null;
    try {
      const exact = JSON.parse(response);
      parsed = exact && typeof exact === "object" && !Array.isArray(exact)
        ? exact as Record<string, unknown>
        : null;
    } catch { /* exact JSON is mandatory */ }
    if (!parsed) throw new Error("capsule model returned invalid JSON");
    // Issue #17: validate/truncate exactly once, inside the write transaction,
    // so the Capsule row records what the truncation removed. Validating here
    // first would hand `applyWorkCapsulePatch` an already-fitted patch and its
    // `truncated` bookkeeping would read as "nothing was removed".
    const applied = applyWorkCapsulePatch(db, {
      workstreamId: checkpoint.workstream_id,
      expectedGeneration,
      throughCheckpointId: checkpoint.checkpoint_id,
      patch: parsed,
      evidencePage: page,
      jobLease: {
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
      },
    });
    if (!applied) {
      const transition = failMemoryJob(db, {
        jobId,
        owner,
        leaseGeneration: claim.lease_generation,
        error: "capsule generation changed during model call",
        retry: true,
        now: new Date(),
      });
      // Issue #34: only write 'retry' when the queue actually chose retry, and
      // never over a terminal row (same guard as model-budget's defer path).
      if (transition === "retry") {
        const currentGeneration = readWorkCapsule(db, checkpoint.workstream_id)?.generation ?? 0;
        db.prepare(`
          UPDATE capsule_checkpoint_state
          SET state = 'retry', expected_generation = ?,
              last_error = 'capsule generation changed during model call', updated_at = ?
          WHERE checkpoint_id = ? AND state IN ('processing','retry','pending')
        `).run(currentGeneration, new Date().toISOString(), checkpoint.checkpoint_id);
      }
      return { jobId, kind: "capsule_update", state: "stale", detail: "generation CAS rejected" };
    }
    return { jobId, kind: "capsule_update",
      state: page.throughSeq >= page.targetSeq ? "completed" : "partial",
      detail: `generation=${applied.generation} through_seq=${page.throughSeq} target_seq=${page.targetSeq}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isModelBudgetExhausted(error)) {
      deferMemoryJobForModelBudget(db, {
        jobId,
        budgetId: error.budgetId,
        parentWaveId: error.parentWaveId,
        owner,
        leaseGeneration: claim.lease_generation,
        reason: error.reason,
        now: new Date(),
        // Issue #12 safety net: refund the claim's attempt when the wall-clock
        // budget died without this claim ever reserving a provider call.
        claimedAt: now,
      });
      return {
        jobId,
        kind: "capsule_update",
        state: "deferred",
        detail: message,
      };
    }
    const transition = failMemoryJob(db, {
      jobId,
      owner,
      leaseGeneration: claim.lease_generation,
      error: message,
      retry: true,
      now: new Date(),
    });
    // Issue #34: branch on the transition the queue actually took. Treating
    // both as "deferred" is what overwrote the store's terminal
    // `failed-visible` with `retry` — the state the real data root was stuck in.
    const state = transition ?? (db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?")
      .get(jobId) as { state?: string } | undefined)?.state;
    let detail = message;
    if (transition === "retry") {
      // Issue #33: make the retry different from the attempt that just failed.
      // Halving the page is the only lever the worker holds over its own input.
      const shrunk = shrinkCapsulePageHint(db, claim.checkpoint_id);
      if (shrunk) detail = `${message} (next page items=${shrunk.items} chars=${shrunk.chars})`;
      db.prepare(`
        UPDATE capsule_checkpoint_state SET state = 'retry', last_error = ?, updated_at = ?
        WHERE checkpoint_id = ? AND state IN ('processing','retry','pending')
      `).run(detail.slice(0, 1_000), new Date().toISOString(), claim.checkpoint_id);
    } else if (transition === "dead" && attemptPage && attemptWorkstreamId) {
      // Terminal after shrinking: step the frontier over exactly the fragment
      // that could not be distilled so the workstream is not frozen at seq 0
      // forever (and its Capsule is not reported permanently stale).
      const skipped = skipCapsuleEvidenceHead(db, attemptWorkstreamId, attemptPage);
      if (skipped !== null) {
        detail = `${message} (skipped evidence seq ${skipped}; frontier advanced)`;
        db.prepare(`
          UPDATE capsule_checkpoint_state SET last_error = ?, updated_at = ?
          WHERE checkpoint_id = ?
        `).run(detail.slice(0, 1_000), new Date().toISOString(), claim.checkpoint_id);
      }
    }
    return {
      jobId,
      kind: "capsule_update",
      state: state === "dead" ? "dead" : "retry",
      detail,
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
  ensureModelBudgetSchema(db);
  const maxJobs = Math.max(1, Math.min(32, options.maxJobs ?? 8));
  const owner = options.owner ?? randomUUID();
  const budgeted = options.model === undefined;
  const model = options.model ?? ((system, user) => callMemoryModel(system, user, 2_048, {
    outputSchema: WORK_CAPSULE_OUTPUT_SCHEMA,
  }));
  const results: ContinuityWorkerResult[] = [];
  for (let index = 0; index < maxJobs; index++) {
    scheduleCapsuleBacklog(db);
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
      const result = await processCapsule(db, capsule.job_id, owner, now, model, budgeted);
      results.push(result);
      if (result.state === "deferred") break;
      continue;
    }
    break;
  }
  return results;
}
