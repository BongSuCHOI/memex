import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { factMatchesReadScope, rowToFact } from './fact-db.js';
import { readScopeForSession } from './read-scope.js';
import { initDatabase, recordRecallEvent } from "./db.js";
import {
  fitsContextBudget,
  REHYDRATION_CONTEXT_LIMITS,
  wrapMemoryContext,
} from "./context-envelope.js";
import { getMemexHome, getSessionsRoot } from "./paths.js";
import { recordHookEvent } from "./observe-hook-event.js";
import { isConversationExcludedSession } from "./conversation-policy.js";
import { CAPSULE_POLICY_VERSION, capsulePageIsCurrent, commitCapsulePage, type CapsulePage } from "./continuity-evidence.js";
import {
  bindSessionWorkstream,
  commitHotEvidenceCursor,
  markSessionProjectRevisionSeen,
  projectRevision,
  readHotEvidence,
  resolveProjectWorkspace,
} from "./continuity-identity.js";

export const CONTINUITY_CAPTURE_POLICY_VERSION = "continuity-capture-v1";
export { CAPSULE_POLICY_VERSION } from "./continuity-evidence.js";
export const CONTINUITY_PARSER_VERSION = 2;
export const CAPTURE_CHUNK_BYTES = 4 * 1024 * 1024;
const SOURCE_PREFIX_GUARD_BYTES = 4 * 1024;
const MAX_CAPSULE_CHARS = 2_000;
const MAX_ARRAY_ITEMS = 8;

export type CaptureKind = "stop" | "interrupt" | "precompact" | "final";
export type LifecycleSource = "startup" | "resume" | "clear" | "compact";
export type ResidentFactRevision = [string, number, number];

export interface NormalizedHookPayload {
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  hookEventName: string;
  turnId: string | null;
  source: string | null;
  trigger: string | null;
  reason: string | null;
  permissionMode: string | null;
  stopHookActive: boolean;
  lastAssistantMessage: string | null;
  prompt: string | null;
  workstreamId: string | null;
}

export interface CaptureResult {
  checkpointId: string;
  captureIndexJobId: string;
  capsuleJobId: string | null;
  jobId: string;
  sessionId: string;
  streamEpoch: number;
  sourceFromByte: number;
  sourceThroughByte: number;
  fromLine: number;
  throughLine: number;
  segmentHash: string;
  prefixHash: string;
  appendedBytes: number;
  journalPath: string;
  created: boolean;
}

export interface CapsuleEvidenceItem {
  text: string;
  sourceExchangeIds: string[];
}

export interface WorkCapsulePatch {
  objective: string;
  currentState: string;
  verifiedProgress: CapsuleEvidenceItem[];
  hypotheses: CapsuleEvidenceItem[];
  blockers: string[];
  openQuestions: string[];
  nextActions: string[];
  touchedAreas: string[];
  carryFactRevisions: ResidentFactRevision[];
  sourceExchangeIds: string[];
}

const capsuleStringListSchema = { type: "array", items: { type: "string" } };
const capsuleEvidenceListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, sourceExchangeIds: capsuleStringListSchema },
    required: ["text", "sourceExchangeIds"],
    additionalProperties: false,
  },
};
const capsuleOutputProperties = {
  objective: { type: "string" },
  currentState: {
    type: "string",
    description: "Merged current state of the whole workstream. Carry forward still-applicable decisions and constraints from previousCapsule, including specific values needed for continuation; revise them when the current evidence changes or resolves them.",
  },
  verifiedProgress: capsuleEvidenceListSchema,
  hypotheses: capsuleEvidenceListSchema,
  blockers: capsuleStringListSchema,
  openQuestions: capsuleStringListSchema,
  nextActions: capsuleStringListSchema,
  touchedAreas: capsuleStringListSchema,
  // Encode member types here; exact [factId, semantic, lifecycle] tuple
  // positions and revision identity are still checked by the local validator.
  carryFactRevisions: {
    type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } },
  },
  sourceExchangeIds: capsuleStringListSchema,
} satisfies Record<keyof WorkCapsulePatch, object>;

/** Native generation shape only; provenance, bounds and CAS remain local. */
export const WORK_CAPSULE_OUTPUT_SCHEMA = {
  type: "object",
  properties: capsuleOutputProperties,
  required: Object.keys(capsuleOutputProperties),
  additionalProperties: false,
};

export interface WorkCapsule extends WorkCapsulePatch {
  workstreamId: string;
  generation: number;
  throughCheckpointId: string | null;
  throughSeq: number;
  authority: "context-only";
  sourceWorkspaceId: string | null;
  sourceSessionId: string | null;
  updatedAt: string;
}

export interface HandleHookResult {
  stdout: string;
  warning?: string;
  capture?: CaptureResult;
  /** Durable recall provenance is prepared before residency and emitted by the hook after stdout. */
  recallReceipt?: ContinuityRecallReceipt;
}

export interface ContinuityRecallReceipt {
  id: string;
  prompt: string;
  status: "prepared";
}

interface CapsuleRenderOptions {
  stale?: boolean;
  recentCorrections?: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: Array<string | number>): string {
  return sha256(`${prefix}\0${parts.join("\0")}`);
}

function cleanString(value: unknown, max = 4_096): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function optionalString(value: unknown, max = 4_096): string | null {
  const text = cleanString(value, max).trim();
  return text || null;
}

function parseJsonArray<T>(raw: unknown, fallback: T[] = []): T[] {
  if (typeof raw !== "string") return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

export function normalizeHookPayload(input: unknown): NormalizedHookPayload {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("hook payload must be a JSON object");
  }
  const value = input as Record<string, unknown>;
  const sessionId = cleanString(value.session_id ?? value.sessionId, 128).trim();
  if (!sessionId || !/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) {
    throw new Error("invalid session_id");
  }
  const cwd = cleanString(value.cwd, 8_192).trim();
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("cwd must be absolute");
  const hookEventName = cleanString(
    value.hook_event_name ?? value.hookEventName ?? value.event_name,
    64,
  ).trim();
  if (!hookEventName) throw new Error("missing hook_event_name");
  const transcriptPath = optionalString(
    value.transcript_path ?? value.transcriptPath,
    16_384,
  );
  return {
    sessionId,
    transcriptPath,
    cwd: path.resolve(cwd),
    hookEventName,
    turnId: optionalString(value.turn_id ?? value.turnId, 256),
    source: optionalString(value.source, 64),
    trigger: optionalString(value.trigger, 64),
    reason: optionalString(value.reason, 128),
    permissionMode: optionalString(
      value.permission_mode ?? value.permissionMode,
      128,
    ),
    stopHookActive: value.stop_hook_active === true || value.stopHookActive === true,
    lastAssistantMessage: optionalString(
      value.last_assistant_message ?? value.lastAssistantMessage,
      16_384,
    ),
    prompt: optionalString(value.prompt, 32_768),
    workstreamId: optionalString(
      value.workstream_id ?? value.workstreamId,
      128,
    ),
  };
}

function allowedTranscriptRoots(): string[] {
  const configured = process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  const roots = configured
    ? configured.split(path.delimiter).filter(Boolean)
    : [getSessionsRoot()];
  return roots.map((root) => {
    const resolved = path.resolve(root);
    try {
      return fs.realpathSync(resolved);
    } catch {
      return resolved;
    }
  });
}

export function validateTranscriptPath(candidate: string): {
  path: string;
  realpath: string;
  stat: fs.Stats;
} {
  if (!path.isAbsolute(candidate)) throw new Error("transcript_path must be absolute");
  const resolved = path.resolve(candidate);
  const lst = fs.lstatSync(resolved);
  if (lst.isSymbolicLink()) throw new Error("transcript_path symlink is not allowed");
  const realpath = fs.realpathSync(resolved);
  const stat = fs.statSync(realpath);
  if (!stat.isFile()) throw new Error("transcript_path is not a regular file");
  const allowed = allowedTranscriptRoots().some(
    (root) => realpath === root || realpath.startsWith(`${root}${path.sep}`),
  );
  if (!allowed) throw new Error("transcript_path is outside allowed session roots");
  return { path: resolved, realpath, stat };
}

function readCanonicalSessionMeta(
  transcriptPath: string,
): { sessionId: string; project: string; branch: string | null } {
  // Codex currently writes session_meta at the start of the rollout. Bound the
  // compatibility probe so project identity resolution never becomes a full
  // transcript read on the hook path.
  const fd = fs.openSync(transcriptPath, "r");
  const bytes = Buffer.alloc(256 * 1024);
  let read = 0;
  try {
    read = fs.readSync(fd, bytes, 0, bytes.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  for (const raw of bytes.subarray(0, read).toString("utf8").split("\n").slice(0, 64)) {
    if (!raw.trim()) continue;
    try {
      const record = JSON.parse(raw) as {
        type?: unknown;
        payload?: { id?: unknown; cwd?: unknown; git_branch?: unknown; git?: { branch?: unknown } };
      };
      if (record.type !== "session_meta" || !record.payload) continue;
      const sessionId = cleanString(record.payload.id, 128).trim();
      const cwd = cleanString(record.payload.cwd, 8_192).trim();
      if (!sessionId || !/^[A-Za-z0-9_-]{4,128}$/.test(sessionId)) {
        throw new Error("session_meta has invalid session id");
      }
      if (!cwd || !path.isAbsolute(cwd)) {
        throw new Error("session_meta cwd must be absolute");
      }
      return {
        sessionId,
        project: path.resolve(cwd),
        branch: optionalString(record.payload.git_branch ?? record.payload.git?.branch, 512),
      };
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  throw new Error("canonical session_meta was not found in transcript prefix");
}

function journalFile(sessionId: string, streamEpoch: number): string {
  return path.join(
    getMemexHome(),
    "journals",
    sessionId,
    `${streamEpoch}.jsonl`,
  );
}

function recordCaptureGap(
  db: Database.Database,
  input: {
    sessionId: string;
    streamEpoch?: number | null;
    sourcePath?: string | null;
    eventKind: string;
    reason: string;
    now?: string;
  },
): string {
  const now = input.now ?? new Date().toISOString();
  const gapId = stableId(
    "capture-gap",
    input.sessionId,
    input.streamEpoch ?? "",
    input.sourcePath ?? "",
    input.eventKind,
    input.reason,
  );
  db.prepare(`
    INSERT OR IGNORE INTO capture_gaps
      (gap_id, session_id, stream_epoch, source_path, event_kind, reason, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    gapId,
    input.sessionId,
    input.streamEpoch ?? null,
    input.sourcePath ?? null,
    input.eventKind,
    input.reason.slice(0, 1_000),
    now,
  );
  return gapId;
}

function recoverContinuitySession(
  db: Database.Database,
  sessionId: string,
): string | undefined {
  const stream = db.prepare(`
    SELECT stream_epoch, source_realpath, journal_path, journal_byte_end
    FROM journal_streams
    WHERE session_id = ? AND state = 'active'
    ORDER BY stream_epoch DESC LIMIT 1
  `).get(sessionId) as {
    stream_epoch: number;
    source_realpath: string;
    journal_path: string;
    journal_byte_end: number;
  } | undefined;
  if (stream) {
    try {
      const current = fs.statSync(stream.journal_path).size;
      if (current > stream.journal_byte_end) {
        const fd = fs.openSync(stream.journal_path, "r+");
        try {
          fs.ftruncateSync(fd, stream.journal_byte_end);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } else if (current < stream.journal_byte_end) {
        recordCaptureGap(db, {
          sessionId,
          streamEpoch: stream.stream_epoch,
          sourcePath: stream.source_realpath,
          eventKind: "recovery",
          reason: "journal file is shorter than committed boundary",
        });
      }
    } catch (error) {
      recordCaptureGap(db, {
        sessionId,
        streamEpoch: stream.stream_epoch,
        sourcePath: stream.source_realpath,
        eventKind: "recovery",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const open = (db.prepare(`
    SELECT COUNT(*) AS n FROM capture_gaps WHERE session_id = ? AND state = 'open'
  `).get(sessionId) as { n: number }).n;
  return open > 0 ? `${open} open capture gap(s) require recovery` : undefined;
}

export function ensureSessionMemoryState(
  db: Database.Database,
  input: {
    sessionId: string;
    project: string;
    explicitWorkstreamId?: string | null;
    branch?: string | null;
    prompt?: string | null;
    source?: string | null;
    now?: string;
  },
): { workstreamId: string; contextEpoch: number; projectId: string; workspaceId: string } {
  const now = input.now ?? new Date().toISOString();
  const identity = resolveProjectWorkspace(db, {
    cwd: input.project,
    branch: input.branch,
    now,
  });
  const existing = db.prepare(`
    SELECT workstream_id, context_epoch, project, project_id, workspace_id
    FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as
    | { workstream_id: string; context_epoch: number; project: string; project_id: string | null; workspace_id: string | null }
    | undefined;
  if (existing) {
    if (existing.project_id && existing.project_id !== identity.projectId) {
      throw new Error("session project identity does not match resolved logical project");
    }
    db.prepare(`
      UPDATE session_memory_state
      SET project = ?, project_id = ?, workspace_id = ?, last_source = ?, updated_at = ?
      WHERE session_id = ?
    `).run(input.project, identity.projectId, identity.workspaceId, input.source ?? null, now, input.sessionId);
    db.prepare(`
      INSERT INTO workstream_sessions
        (session_id, workstream_id, workspace_id, binding_reason, binding_confidence, bound_at)
      VALUES (?, ?, ?, 'resume-exact', 1.0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        binding_reason = 'resume-exact',
        binding_confidence = 1.0,
        bound_at = excluded.bound_at
    `).run(input.sessionId, existing.workstream_id, identity.workspaceId, now);
    return {
      workstreamId: existing.workstream_id,
      contextEpoch: existing.context_epoch,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
    };
  }
  const binding = bindSessionWorkstream(db, {
    sessionId: input.sessionId,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    projectPath: input.project,
    explicitWorkstreamId: input.explicitWorkstreamId,
    branch: input.branch,
    prompt: input.prompt,
    now,
  });
  db.prepare("UPDATE session_memory_state SET last_source = ? WHERE session_id = ?")
    .run(input.source ?? null, input.sessionId);
  return {
    workstreamId: binding.workstreamId,
    contextEpoch: 0,
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
  };
}

function checkpointOrdinal(streamEpoch: number, throughByte: number): number {
  const ordinal = streamEpoch * 1_000_000_000_000 + throughByte;
  if (!Number.isSafeInteger(ordinal)) throw new Error("checkpoint ordinal overflow");
  return ordinal;
}

/** Preserve Stop/byte coalescing using database capture order, never session ordinals. */
export function scheduleCapsuleForCheckpoint(
  db: Database.Database, checkpointId: string, now = new Date().toISOString(), force = false,
): void {
  const tx = db.transaction(() => {
    const checkpoint = db.prepare("SELECT workstream_id, kind FROM checkpoints WHERE checkpoint_id = ?")
      .get(checkpointId) as { workstream_id: string; kind: string } | undefined;
    if (!checkpoint?.workstream_id || checkpoint.kind === "extraction") return;
    const capsuleJobId = stableId("capsule-job", checkpointId);
    const lastCapsuleBoundary = db.prepare(`
      SELECT c.rowid AS capture_order
      FROM capsule_checkpoint_state s
      JOIN checkpoints c ON c.checkpoint_id = s.checkpoint_id
      WHERE s.workstream_id = ?
      ORDER BY c.rowid DESC LIMIT 1
    `).get(checkpoint.workstream_id) as { capture_order: number } | undefined;
    const pendingCapsule = db.prepare(`
      SELECT 1 FROM memory_jobs
      WHERE kind = 'capsule_update' AND partition_key = ?
        AND state IN ('pending','running','retry')
      LIMIT 1
    `).get(`workstream:${checkpoint.workstream_id}`);
    const accumulated = db.prepare(`
      SELECT COUNT(*) AS boundaries,
             COALESCE(SUM(CASE
               WHEN through_byte > from_byte THEN through_byte - from_byte ELSE 0 END), 0) AS bytes
      FROM checkpoints
      WHERE workstream_id = ? AND rowid > ?
        AND rowid <= (SELECT rowid FROM checkpoints WHERE checkpoint_id = ?)
        AND kind IN ('stop','interrupt')
    `).get(
      checkpoint.workstream_id,
      lastCapsuleBoundary?.capture_order ?? -1,
      checkpointId,
    ) as { boundaries: number; bytes: number };
    const forceCapsule = force || checkpoint.kind === "precompact" || checkpoint.kind === "final";
    const pendingFence = db.prepare(`SELECT 1 FROM checkpoints
      WHERE workstream_id = ? AND rowid > ? AND kind IN ('precompact','final')
        AND rowid <= (SELECT rowid FROM checkpoints WHERE checkpoint_id = ?) LIMIT 1`)
      .get(checkpoint.workstream_id, lastCapsuleBoundary?.capture_order ?? -1, checkpointId);
    const scheduleCapsule = !pendingCapsule && (forceCapsule || pendingFence || (
      accumulated.boundaries >= 6 || accumulated.bytes >= 8 * 1024
    ));
    if (scheduleCapsule) {
      db.prepare("INSERT OR IGNORE INTO capsule_frontiers(workstream_id) VALUES (?)").run(checkpoint.workstream_id);
      const currentGeneration = (db.prepare(`
        SELECT generation FROM work_capsules WHERE workstream_id = ?
      `).get(checkpoint.workstream_id) as { generation: number } | undefined)?.generation ?? 0;
      db.prepare(`
        INSERT OR IGNORE INTO capsule_checkpoint_state
          (checkpoint_id, workstream_id, state, expected_generation, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(checkpointId, checkpoint.workstream_id, currentGeneration, now);
      db.prepare(`
        INSERT OR IGNORE INTO memory_jobs
          (job_id, kind, partition_key, checkpoint_id, policy_version, priority,
           state, available_at, max_attempts, idempotency_key, created_at, updated_at)
        VALUES (?, 'capsule_update', ?, ?, ?, 80, 'pending', ?, 5, ?, ?, ?)
      `).run(
        capsuleJobId,
        `workstream:${checkpoint.workstream_id}`,
        checkpointId,
        CAPSULE_POLICY_VERSION,
        now,
        `capsule:${checkpointId}`,
        now,
        now,
      );
      // A migrated or invalidated projection can require a new bounded drain
      // even when its last trigger checkpoint already completed. Dead jobs stay
      // failed-visible; this is not an unbounded retry path.
      const reopened = db.prepare(`UPDATE memory_jobs
        SET state = 'pending', attempts = 0, available_at = ?, updated_at = ?
        WHERE job_id = ? AND state = 'completed' AND EXISTS (
          SELECT 1 FROM workstream_evidence e JOIN capsule_frontiers f USING(workstream_id)
          WHERE e.workstream_id = ? AND e.seq > f.through_seq
        )`).run(now, now, capsuleJobId, checkpoint.workstream_id);
      if (reopened.changes) db.prepare(`UPDATE capsule_checkpoint_state
        SET state = 'pending', target_seq = NULL, target_revision = NULL, updated_at = ?
        WHERE checkpoint_id = ?`).run(now, checkpointId);
    }
  });
  db.inTransaction ? tx() : tx.immediate();
}

export function scheduleCapsuleBacklog(db: Database.Database): void {
  const streams = db.prepare(`
    SELECT f.workstream_id, f.revision, f.through_seq,
      EXISTS (SELECT 1 FROM work_capsules w WHERE w.workstream_id = f.workstream_id) AS has_capsule,
      (SELECT c.checkpoint_id FROM checkpoints c WHERE c.workstream_id = f.workstream_id
        AND c.kind <> 'extraction' ORDER BY c.rowid DESC LIMIT 1) AS checkpoint_id
    FROM capsule_frontiers f
    WHERE EXISTS (SELECT 1 FROM workstream_evidence e
      WHERE e.workstream_id = f.workstream_id AND e.seq > f.through_seq)
      AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.partition_key = 'workstream:' || f.workstream_id
        AND j.kind = 'capsule_update' AND j.state IN ('pending','running','retry'))
    ORDER BY f.workstream_id LIMIT 32
  `).all() as Array<{ checkpoint_id: string | null; revision: number; through_seq: number; has_capsule: number }>;
  for (const stream of streams) {
    if (stream.checkpoint_id) scheduleCapsuleForCheckpoint(db, stream.checkpoint_id, undefined,
      stream.through_seq === 0 && (stream.revision > 0 || !!stream.has_capsule));
  }
}

export function captureTranscriptPrefix(
  db: Database.Database,
  input: {
    sessionId: string;
    project: string;
    transcriptPath: string;
    kind: CaptureKind;
    turnId?: string | null;
    workstreamId?: string | null;
    now?: string;
    afterJournalChunk?: (bytesCopied: number) => void;
    afterJournalFsync?: () => void;
    afterCheckpoint?: () => void;
    afterJob?: () => void;
  },
): CaptureResult {
  const capture = db.transaction(() => captureTranscriptPrefixInTransaction(db, input));
  try {
    return db.inTransaction ? capture() : capture.immediate();
  } catch (error) {
    // File bytes can be fsynced before a transaction aborts. Keep the failure
    // visible in a separate transaction; the next serialized capture trims the
    // orphan tail and replays the exact source delta.
    try {
      recordCaptureGap(db, {
        sessionId: input.sessionId,
        sourcePath: input.transcriptPath,
        eventKind: input.kind,
        reason: error instanceof Error ? error.message : String(error),
        now: input.now,
      });
    } catch { /* the caller still receives the original capture failure */ }
    throw error;
  }
}

function captureTranscriptPrefixInTransaction(
  db: Database.Database,
  input: {
    sessionId: string;
    project: string;
    transcriptPath: string;
    kind: CaptureKind;
    turnId?: string | null;
    workstreamId?: string | null;
    now?: string;
    afterJournalChunk?: (bytesCopied: number) => void;
    afterJournalFsync?: () => void;
    afterCheckpoint?: () => void;
    afterJob?: () => void;
  },
): CaptureResult {
  const now = input.now ?? new Date().toISOString();
  const source = validateTranscriptPath(input.transcriptPath);
  const meta = readCanonicalSessionMeta(source.realpath);
  if (meta.sessionId !== input.sessionId) {
    throw new Error("hook session_id does not match transcript session_meta id");
  }
  const sourceDev = String(source.stat.dev);
  const sourceIno = String(source.stat.ino);
  const session = ensureSessionMemoryState(db, {
    sessionId: input.sessionId,
    project: meta.project,
    explicitWorkstreamId: input.workstreamId,
    branch: meta.branch,
    source: input.kind,
    now,
  });
  const previous = db.prepare(`
    SELECT * FROM journal_streams
    WHERE session_id = ? ORDER BY stream_epoch DESC LIMIT 1
  `).get(input.sessionId) as Record<string, unknown> | undefined;
  const sameSourceIdentity = !!previous &&
    String(previous.source_realpath) === source.realpath &&
    String(previous.source_dev) === sourceDev &&
    String(previous.source_ino) === sourceIno;
  let guardedPrefixChanged = false;
  if (
    previous && sameSourceIdentity &&
    source.stat.size >= Number(previous.copied_byte_end) &&
    Number(previous.copied_byte_end) > 0 &&
    String(previous.source_guard_hash ?? "")
  ) {
    const guardStart = Number(previous.source_guard_start ?? 0);
    const guardEnd = Number(previous.copied_byte_end);
    const guardLength = guardEnd - guardStart;
    if (guardStart < 0 || guardLength < 0 || guardLength > SOURCE_PREFIX_GUARD_BYTES) {
      guardedPrefixChanged = true;
    } else {
      const guard = Buffer.alloc(guardLength);
      const guardFd = fs.openSync(source.realpath, "r");
      try {
        const read = fs.readSync(guardFd, guard, 0, guard.length, guardStart);
        guardedPrefixChanged = read !== guard.length ||
          sha256(guard) !== String(previous.source_guard_hash);
      } finally {
        fs.closeSync(guardFd);
      }
    }
  }
  let journalDamaged = false;
  if (previous && sameSourceIdentity) {
    try {
      journalDamaged = fs.statSync(String(previous.journal_path)).size <
        Number(previous.journal_byte_end);
    } catch {
      journalDamaged = Number(previous.journal_byte_end) > 0;
    }
  }
  const replaced = !!previous && (
    String(previous.source_realpath) !== source.realpath ||
    String(previous.source_dev) !== sourceDev ||
    String(previous.source_ino) !== sourceIno ||
    source.stat.size < Number(previous.copied_byte_end) ||
    guardedPrefixChanged ||
    journalDamaged ||
    (source.stat.size === Number(previous.copied_byte_end) &&
      Number(previous.source_mtime_ms) > 0 &&
      source.stat.mtimeMs !== Number(previous.source_mtime_ms))
  );
  const streamEpoch = previous
    ? Number(previous.stream_epoch) + (replaced ? 1 : 0)
    : 0;
  const copiedByteEnd = previous && !replaced ? Number(previous.copied_byte_end) : 0;
  const copiedLineEnd = previous && !replaced ? Number(previous.copied_line_end) : 0;
  const journalByteEnd = previous && !replaced ? Number(previous.journal_byte_end) : 0;
  const priorPrefixHash = previous && !replaced ? String(previous.prefix_hash) : "";
  const deltaSize = source.stat.size - copiedByteEnd;
  if (deltaSize < 0) throw new Error("source transcript rewound unexpectedly");
  if (journalDamaged) {
    recordCaptureGap(db, {
      sessionId: input.sessionId,
      streamEpoch: Number(previous?.stream_epoch ?? 0),
      sourcePath: source.realpath,
      eventKind: input.kind,
      reason: "journal file is shorter than committed boundary",
      now,
    });
  }
  const journalPath = journalFile(input.sessionId, streamEpoch);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const fd = fs.openSync(source.realpath, "r");
  let sourceThroughByte = copiedByteEnd;
  let sourceGuardStart = 0;
  let sourceGuardHash = sha256(Buffer.alloc(0));
  let addedLines = 0;
  const segmentDigest = createHash("sha256");
  const prefixDigest = createHash("sha256").update(priorPrefixHash, "utf8").update(Buffer.from([0]));
  try {
    const buffer = Buffer.alloc(Math.min(CAPTURE_CHUNK_BYTES, Math.max(1, deltaSize)));
    // Find the fixed fence's last complete JSONL line without retaining a
    // potentially enormous incomplete record in memory.
    for (let end = source.stat.size; end > copiedByteEnd;) {
      const start = Math.max(copiedByteEnd, end - buffer.length);
      const length = end - start;
      if (fs.readSync(fd, buffer, 0, length, start) !== length) throw new Error("source transcript changed during capture");
      const newline = buffer.subarray(0, length).lastIndexOf(0x0a);
      if (newline >= 0) { sourceThroughByte = start + newline + 1; break; }
      end = start;
    }
    const journalFd = fs.openSync(journalPath, "a+");
    try {
      const currentSize = fs.fstatSync(journalFd).size;
      if (currentSize < journalByteEnd) throw new Error("journal file is shorter than committed boundary");
      // Only the uncommitted tail is disposable. A failure anywhere below
      // leaves the committed DB boundary intact for an exact retry.
      if (currentSize > journalByteEnd) fs.ftruncateSync(journalFd, journalByteEnd);
      let copied = 0;
      while (copiedByteEnd + copied < sourceThroughByte) {
        const length = Math.min(buffer.length, sourceThroughByte - copiedByteEnd - copied);
        const read = fs.readSync(fd, buffer, 0, length, copiedByteEnd + copied);
        if (!read) throw new Error("source transcript changed during capture");
        const chunk = buffer.subarray(0, read);
        segmentDigest.update(chunk);
        prefixDigest.update(chunk);
        for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) addedLines++;
        let written = 0;
        while (written < read) {
          const count = fs.writeSync(journalFd, chunk, written, read - written, journalByteEnd + copied + written);
          if (!count) throw new Error("journal append made no progress");
          written += count;
        }
        copied += read;
        input.afterJournalChunk?.(copied);
      }
      sourceGuardStart = Math.max(0, sourceThroughByte - SOURCE_PREFIX_GUARD_BYTES);
      const guard = Buffer.alloc(sourceThroughByte - sourceGuardStart);
      if (fs.readSync(fd, guard, 0, guard.length, sourceGuardStart) !== guard.length) {
        throw new Error("source transcript changed before guard capture");
      }
      sourceGuardHash = sha256(guard);
      // Validate both the open handle and its path: replacement can leave an
      // unchanged old inode open while the path already names a new source.
      for (const observed of [fs.fstatSync(fd), fs.statSync(source.realpath)]) {
        if (String(observed.dev) !== sourceDev || String(observed.ino) !== sourceIno ||
            observed.size !== source.stat.size || observed.mtimeMs !== source.stat.mtimeMs) {
          throw new Error("source transcript changed during capture");
        }
      }
      fs.fsyncSync(journalFd);
    } finally {
      fs.closeSync(journalFd);
    }
  } finally {
    fs.closeSync(fd);
  }
  const completeBytes = sourceThroughByte - copiedByteEnd;
  const throughLine = copiedLineEnd + addedLines;
  const segmentHash = segmentDigest.digest("hex");
  const prefixHash = completeBytes > 0 ? prefixDigest.digest("hex") : priorPrefixHash || sha256(Buffer.alloc(0));
  input.afterJournalFsync?.();

  const journalThroughByte = journalByteEnd + completeBytes;
  const blockId = stableId(
    "journal-block",
    input.sessionId,
    streamEpoch,
    sourceThroughByte,
    prefixHash,
  );
  const checkpointId = stableId(
    "checkpoint",
    input.sessionId,
    streamEpoch,
    sourceThroughByte,
    prefixHash,
    input.kind,
  );
  const capsuleJobId = stableId("capsule-job", checkpointId);
  const captureIndexJobId = stableId("capture-index-job", checkpointId);
  const closureState = input.kind === "interrupt" || input.kind === "precompact"
    ? "interrupted"
    : input.kind === "final" ? "final" : "closed";
  const ordinal = checkpointOrdinal(streamEpoch, sourceThroughByte);
  const commit = db.transaction(() => {
    if (replaced && previous) {
      db.prepare(`
        UPDATE journal_streams SET state = 'replaced', updated_at = ?
        WHERE session_id = ? AND stream_epoch = ? AND state = 'active'
      `).run(now, input.sessionId, Number(previous.stream_epoch));
    }
    db.prepare(`
      INSERT INTO journal_streams
        (session_id, stream_epoch, source_path, source_realpath, source_dev, source_ino, source_mtime_ms,
         source_guard_start, source_guard_hash,
         copied_byte_end, copied_line_end, journal_byte_end, journal_path, prefix_hash,
         parser_version, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(session_id, stream_epoch) DO UPDATE SET
        source_path = excluded.source_path,
        source_realpath = excluded.source_realpath,
        source_dev = excluded.source_dev,
        source_ino = excluded.source_ino,
        source_mtime_ms = excluded.source_mtime_ms,
        source_guard_start = excluded.source_guard_start,
        source_guard_hash = excluded.source_guard_hash,
        copied_byte_end = MAX(journal_streams.copied_byte_end, excluded.copied_byte_end),
        copied_line_end = MAX(journal_streams.copied_line_end, excluded.copied_line_end),
        journal_byte_end = MAX(journal_streams.journal_byte_end, excluded.journal_byte_end),
        prefix_hash = CASE
          WHEN excluded.copied_byte_end >= journal_streams.copied_byte_end THEN excluded.prefix_hash
          ELSE journal_streams.prefix_hash END,
        parser_version = excluded.parser_version,
        state = 'active', updated_at = excluded.updated_at
    `).run(
      input.sessionId,
      streamEpoch,
      source.path,
      source.realpath,
      sourceDev,
      sourceIno,
      source.stat.mtimeMs,
      sourceGuardStart,
      sourceGuardHash,
      sourceThroughByte,
      throughLine,
      journalThroughByte,
      journalPath,
      prefixHash,
      CONTINUITY_PARSER_VERSION,
      now,
      now,
    );
    if (completeBytes > 0) {
      const blockOrdinal = (db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS n FROM journal_blocks
        WHERE session_id = ? AND stream_epoch = ?
      `).get(input.sessionId, streamEpoch) as { n: number }).n;
      db.prepare(`
        INSERT OR IGNORE INTO journal_blocks
          (block_id, session_id, stream_epoch, ordinal, source_from_byte,
           source_through_byte, journal_from_byte, journal_through_byte, from_line,
           through_line, segment_hash, prefix_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        blockId,
        input.sessionId,
        streamEpoch,
        blockOrdinal,
        copiedByteEnd,
        sourceThroughByte,
        journalByteEnd,
        journalThroughByte,
        copiedLineEnd + 1,
        throughLine,
        segmentHash,
        prefixHash,
        now,
      );
    }
    const checkpointResult = db.prepare(`
      INSERT OR IGNORE INTO checkpoints
        (checkpoint_id, session_id, workspace_id, workstream_id, stream_epoch,
         ordinal, kind, turn_id, from_byte, through_byte, from_line, through_line,
         segment_hash, prefix_hash, parser_version, closure_state,
         context_epoch_before, state, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT context_epoch FROM session_memory_state WHERE session_id = ?),
        'pending', ?, ?)
    `).run(
      checkpointId,
      input.sessionId,
      session.workspaceId,
      session.workstreamId,
      streamEpoch,
      ordinal,
      input.kind,
      input.turnId ?? null,
      copiedByteEnd,
      sourceThroughByte,
      copiedLineEnd + (completeBytes > 0 ? 1 : 0),
      throughLine,
      segmentHash,
      prefixHash,
      CONTINUITY_PARSER_VERSION,
      closureState,
      input.sessionId,
      `capture:${checkpointId}`,
      now,
    );
    input.afterCheckpoint?.();
    db.prepare(`
      INSERT OR IGNORE INTO memory_jobs
        (job_id, kind, partition_key, checkpoint_id, policy_version, priority,
         state, available_at, max_attempts, idempotency_key, created_at, updated_at)
      VALUES (?, 'capture_index', ?, ?, ?, 100, 'pending', ?, 5, ?, ?, ?)
    `).run(
      captureIndexJobId,
      `session:${input.sessionId}`,
      checkpointId,
      CONTINUITY_CAPTURE_POLICY_VERSION,
      now,
      `capture-index:${checkpointId}`,
      now,
      now,
    );
    scheduleCapsuleForCheckpoint(db, checkpointId, now);
    input.afterJob?.();
    db.prepare(`
      UPDATE session_memory_state
      SET latest_checkpoint_id = ?,
          carry_fact_revisions_json = CASE WHEN ? = 'precompact'
            THEN resident_fact_revisions_json ELSE carry_fact_revisions_json END,
          updated_at = ?
      WHERE session_id = ?
    `).run(checkpointId, input.kind, now, input.sessionId);
    db.prepare(`
      UPDATE capture_gaps SET state = 'recovered', recovered_at = ?
      WHERE session_id = ? AND state = 'open'
    `).run(now, input.sessionId);
    return checkpointResult.changes === 1;
  });
  let created: boolean;
  try {
    created = db.inTransaction ? commit() : commit.immediate();
  } catch (error) {
    // The fsynced bytes have no committed DB boundary. A retry truncates only
    // this orphan tail back to journalByteEnd and replays the same delta.
    throw error;
  }
  return {
    checkpointId,
    captureIndexJobId,
    capsuleJobId: db.prepare(
      "SELECT job_id FROM memory_jobs WHERE job_id = ?",
    ).get(capsuleJobId) ? capsuleJobId : null,
    jobId: captureIndexJobId,
    sessionId: input.sessionId,
    streamEpoch,
    sourceFromByte: copiedByteEnd,
    sourceThroughByte,
    fromLine: copiedLineEnd + (completeBytes > 0 ? 1 : 0),
    throughLine,
    segmentHash,
    prefixHash,
    appendedBytes: completeBytes,
    journalPath,
    created,
  };
}

export function advanceContextEpoch(
  db: Database.Database,
  input: {
    sessionId: string;
    source: "compact" | "clear";
    turnId?: string | null;
    now?: string;
  },
): number {
  const now = input.now ?? new Date().toISOString();
  const state = db.prepare(`
    SELECT context_epoch, epoch_token, latest_checkpoint_id,
           resident_fact_revisions_json, carry_fact_revisions_json
    FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as Record<string, unknown> | undefined;
  if (!state) throw new Error("session memory state is missing");
  const token = input.source === "compact"
    ? `compact:${String(state.latest_checkpoint_id ?? input.turnId ?? "unknown")}`
    : `clear:${input.turnId ?? now}`;
  if (String(state.epoch_token) === token) return Number(state.context_epoch);
  const next = Number(state.context_epoch) + 1;
  db.prepare(`
    UPDATE session_memory_state
    SET context_epoch = ?, epoch_token = ?,
        carry_fact_revisions_json = CASE WHEN ? = 'compact'
          THEN CASE WHEN carry_fact_revisions_json = '[]'
            THEN resident_fact_revisions_json ELSE carry_fact_revisions_json END
          ELSE '[]' END,
        resident_fact_revisions_json = '[]',
        capsule_generation_seen = 0,
        last_retrieval_at = NULL,
        hot_evidence_cursor = 0,
        last_source = ?, updated_at = ?
    WHERE session_id = ? AND context_epoch = ?
  `).run(next, token, input.source, input.source, now, input.sessionId, state.context_epoch);
  return next;
}

export function readResidentFactRevisions(
  db: Database.Database,
  sessionId: string,
): { contextEpoch: number; resident: ResidentFactRevision[]; carry: ResidentFactRevision[] } {
  const row = db.prepare(`
    SELECT context_epoch, resident_fact_revisions_json, carry_fact_revisions_json
    FROM session_memory_state WHERE session_id = ?
  `).get(sessionId) as Record<string, unknown> | undefined;
  return {
    contextEpoch: Number(row?.context_epoch ?? 0),
    resident: parseJsonArray<ResidentFactRevision>(row?.resident_fact_revisions_json),
    carry: parseJsonArray<ResidentFactRevision>(row?.carry_fact_revisions_json),
  };
}

export function recordResidentFactRevisions(
  db: Database.Database,
  sessionId: string,
  contextEpoch: number,
  revisions: ResidentFactRevision[],
  now = new Date().toISOString(),
): boolean {
  const current = readResidentFactRevisions(db, sessionId);
  if (current.contextEpoch !== contextEpoch) return false;
  const map = new Map(current.resident.map((entry) => [entry[0], entry]));
  const scope = readScopeForSession(db, sessionId);
  for (const entry of revisions) {
    if (
      !Array.isArray(entry) || entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      !Number.isInteger(entry[1]) || !Number.isInteger(entry[2])
    ) continue;
    const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(entry[0]) as Record<string, unknown> | undefined;
    if (scope && row && !factMatchesReadScope(db, rowToFact(row), scope)) map.delete(entry[0]);
    else map.set(entry[0], entry);
  }
  const bounded = [...map.values()].slice(-400);
  return db.prepare(`
    UPDATE session_memory_state
    SET resident_fact_revisions_json = ?, updated_at = ?
    WHERE session_id = ? AND context_epoch = ?
  `).run(JSON.stringify(bounded), now, sessionId, contextEpoch).changes === 1;
}

export interface ResidentRevisionCorrection {
  scope_revoked?: boolean;
  id: string;
  fact: string;
  category: string;
  semantic_generation: number;
  lifecycle_generation: number;
  is_active: number;
  /** Statement the resident revision carried, from the Chronicle, when known. */
  previous_fact: string | null;
}

/**
 * Resident fact revisions whose current row differs (new semantic/lifecycle
 * generation or deactivated): exactly the facts whose earlier statement is
 * now stale in the model's context (RFC §12.4/§12.6). Purged rows are skipped
 * so a correction never resurrects removed text. Never-resident facts are not
 * corrections; they reach the context only through relevance retrieval.
 */
export function readResidentRevisionCorrections(
  db: Database.Database,
  sessionId: string,
): ResidentRevisionCorrection[] {
  const { resident } = readResidentFactRevisions(db, sessionId);
  if (resident.length === 0) return [];
  const scope = readScopeForSession(db, sessionId);
  if (!scope) return [];
  const rows = db.prepare(`
    SELECT *
    FROM facts WHERE id IN (${resident.map(() => "?").join(",")})
  `).all(...resident.map(([id]) => id)) as Array<Omit<ResidentRevisionCorrection, "previous_fact">>;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const previous = db.prepare(`
    SELECT previous_fact FROM fact_revisions
    WHERE fact_id = ? AND previous_fact IS NOT NULL AND previous_fact <> ''
    ORDER BY chronicle_seq DESC LIMIT 1
  `);
  const corrections: ResidentRevisionCorrection[] = [];
  for (const [id, semantic, lifecycle] of resident) {
    const row = byId.get(id);
    if (!row) continue;
    if (!factMatchesReadScope(db, rowToFact(row as unknown as Record<string, unknown>), scope)) {
      corrections.push({ id, fact: 'Memory is no longer available in this scope', category: 'knowledge',
        semantic_generation: Number(row.semantic_generation), lifecycle_generation: Number(row.lifecycle_generation),
        is_active: 0, previous_fact: null, scope_revoked: true });
      continue;
    }
    if (Number(row.semantic_generation) === semantic && Number(row.lifecycle_generation) === lifecycle) continue;
    const prior = row.is_active === 1
      ? (previous.get(id) as { previous_fact: string } | undefined)?.previous_fact ?? null
      : null;
    corrections.push({
      ...row,
      semantic_generation: Number(row.semantic_generation),
      lifecycle_generation: Number(row.lifecycle_generation),
      is_active: Number(row.is_active),
      previous_fact: prior,
    });
  }
  corrections.sort((a, b) => a.id.localeCompare(b.id));
  return corrections;
}

function cleanList(values: unknown, field: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  if (values.length > MAX_ARRAY_ITEMS) throw new Error(`${field} exceeds ${MAX_ARRAY_ITEMS} items`);
  return values.map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${field} contains invalid text`);
    const text = value.trim();
    if (text.length > 500) throw new Error(`${field} contains overlong text`);
    return text;
  });
}

function cleanEvidence(values: unknown, field: string): CapsuleEvidenceItem[] {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  if (values.length > MAX_ARRAY_ITEMS) throw new Error(`${field} exceeds ${MAX_ARRAY_ITEMS} items`);
  return values.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${field} contains invalid item`);
    }
    const item = value as Record<string, unknown>;
    if (typeof item.text !== "string") {
      throw new Error(`${field} contains invalid text type`);
    }
    if (item.text.trim().length > 500) {
      throw new Error(`${field} contains overlong text (${item.text.trim().length} characters)`);
    }
    const text = item.text.trim();
    if (!Array.isArray(item.sourceExchangeIds) ||
      item.sourceExchangeIds.some((id) => typeof id !== "string" || !id)) {
      throw new Error(`${field} contains invalid sources`);
    }
    const sources = item.sourceExchangeIds as string[];
    if (!text || sources.length === 0) throw new Error(`${field} requires text and sources`);
    return { text, sourceExchangeIds: [...new Set(sources)].slice(0, 16) };
  });
}

export function validateWorkCapsulePatch(value: unknown): WorkCapsulePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("capsule patch must be an object");
  }
  const input = value as Record<string, unknown>;
  const fields = WORK_CAPSULE_OUTPUT_SCHEMA.required;
  const keys = Object.keys(input);
  if (keys.length !== fields.length ||
    fields.some((field) => !Object.prototype.hasOwnProperty.call(input, field)) ||
    keys.some((key) => !fields.includes(key))) {
    throw new Error("capsule patch must have the exact required fields");
  }
  if (!Array.isArray(input.carryFactRevisions) || input.carryFactRevisions.length > 64 ||
    input.carryFactRevisions.some((entry) =>
      !Array.isArray(entry) || entry.length !== 3 || typeof entry[0] !== "string" ||
      !entry[0] || !Number.isInteger(entry[1]) || !Number.isInteger(entry[2]) ||
      Number(entry[1]) < 1 || Number(entry[2]) < 1)) {
    throw new Error("carryFactRevisions contains invalid revision identity");
  }
  const carry = input.carryFactRevisions as ResidentFactRevision[];
  if (!Array.isArray(input.sourceExchangeIds) || input.sourceExchangeIds.length > 64 ||
    input.sourceExchangeIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("sourceExchangeIds contains invalid sources");
  }
  const sources = [...new Set(input.sourceExchangeIds as string[])];
  const strictScalar = (field: "objective" | "currentState"): string => {
    const raw = input[field];
    if (typeof raw !== "string" || raw.length > 500) {
      throw new Error(`${field} must be text of at most 500 characters`);
    }
    return raw.trim();
  };
  const patch: WorkCapsulePatch = {
    objective: strictScalar("objective"),
    currentState: strictScalar("currentState"),
    verifiedProgress: cleanEvidence(input.verifiedProgress ?? [], "verifiedProgress"),
    hypotheses: cleanEvidence(input.hypotheses ?? [], "hypotheses"),
    blockers: cleanList(input.blockers ?? [], "blockers"),
    openQuestions: cleanList(input.openQuestions ?? [], "openQuestions"),
    nextActions: cleanList(input.nextActions ?? [], "nextActions"),
    touchedAreas: cleanList(input.touchedAreas ?? [], "touchedAreas"),
    carryFactRevisions: carry.slice(0, 64),
    sourceExchangeIds: sources,
  };
  const evidenceSources = new Set([
    ...patch.verifiedProgress.flatMap((item) => item.sourceExchangeIds),
    ...patch.hypotheses.flatMap((item) => item.sourceExchangeIds),
  ]);
  if ([...evidenceSources].some((id) => !sources.includes(id))) {
    throw new Error("capsule evidence sources must be declared in sourceExchangeIds");
  }
  const verifiedText = new Set(patch.verifiedProgress.map((item) => item.text.toLowerCase()));
  if (patch.hypotheses.some((item) => verifiedText.has(item.text.toLowerCase()))) {
    throw new Error("capsule text cannot be both verified progress and hypothesis");
  }
  if (JSON.stringify(patch).length > MAX_CAPSULE_CHARS) {
    throw new Error("capsule patch exceeds bounded storage size");
  }
  return patch;
}

function assertVerifiedSources(
  db: Database.Database,
  verified: CapsuleEvidenceItem[],
  page?: CapsulePage,
): void {
  const ids = [...new Set(verified.flatMap((item) => item.sourceExchangeIds))];
  if (ids.length === 0) return;
  if (page) {
    // Authority belongs to the immutable generation/part actually presented,
    // not to the exchange's possibly newer live row or an unseen fragment.
    for (const id of ids) {
      if (!page.evidence.some((item) => item.exchangeId === id && (
        (typeof item.human === "string" && item.human.trim().length > 0) ||
        (Array.isArray(item.trustedTools) && item.trustedTools.length > 0)
      ))) throw new Error(`verified progress source is not authoritative in this page: ${id}`);
    }
    return;
  }
  const select = db.prepare(`
    SELECT e.id,
      CASE WHEN length(trim(e.user_message)) > 0 OR EXISTS (
        SELECT 1 FROM tool_calls t WHERE t.exchange_id = e.id AND t.learnable = 1
      ) THEN 1 ELSE 0 END AS authoritative
    FROM exchanges e WHERE e.id = ?
  `);
  for (const id of ids) {
    const row = select.get(id) as { authoritative: number } | undefined;
    if (!row?.authoritative) throw new Error(`verified progress source is not authoritative: ${id}`);
  }
}

function assertCapsuleSourcesExist(
  db: Database.Database,
  patch: WorkCapsulePatch,
  workstreamId: string,
): void {
  const select = db.prepare(`SELECT 1 FROM exchanges e
    JOIN minimal_workstreams w ON w.workstream_id = ?
    LEFT JOIN session_memory_state s ON s.session_id = e.session_id
    WHERE e.id = ? AND e.project_id = w.project_id
      AND COALESCE(e.workstream_id, s.workstream_id) = w.workstream_id
      AND NOT EXISTS (SELECT 1 FROM conversation_exclusions x WHERE x.session_id = e.session_id)`);
  for (const id of patch.sourceExchangeIds) {
    if (!select.get(workstreamId, id)) throw new Error(`capsule source exchange is missing or outside workstream: ${id}`);
  }
}

export function applyWorkCapsulePatch(
  db: Database.Database,
  input: {
    workstreamId: string;
    expectedGeneration: number;
    throughCheckpointId: string;
    patch: unknown;
    evidencePage?: CapsulePage;
    jobLease?: {
      jobId: string;
      owner: string;
      leaseGeneration: number;
    };
    now?: string;
  },
): WorkCapsule | null {
  const patch = validateWorkCapsulePatch(input.patch);
  const now = input.now ?? new Date().toISOString();
  const tx = db.transaction(() => {
    if (input.evidencePage && !capsulePageIsCurrent(db, input.workstreamId, input.evidencePage)) return null;
    if (input.jobLease) {
      const owned = db.prepare(`
        SELECT 1 FROM memory_jobs
        WHERE job_id = ? AND kind = 'capsule_update' AND checkpoint_id = ?
          AND state = 'running' AND lease_owner = ? AND lease_generation = ?
          AND lease_until > ?
      `).get(
        input.jobLease.jobId,
        input.throughCheckpointId,
        input.jobLease.owner,
        input.jobLease.leaseGeneration,
        now,
      );
      if (!owned) return null;
    }
    const workstream = db.prepare(`
      SELECT 1 FROM minimal_workstreams WHERE workstream_id = ?
    `).get(input.workstreamId);
    if (!workstream) throw new Error("unknown workstream");
    const checkpoint = db.prepare(`
      SELECT session_id, workspace_id FROM checkpoints
      WHERE checkpoint_id = ? AND workstream_id = ?
    `).get(input.throughCheckpointId, input.workstreamId) as
      | { session_id: string; workspace_id: string | null }
      | undefined;
    if (!checkpoint) throw new Error("checkpoint does not belong to workstream");
    assertCapsuleSourcesExist(db, patch, input.workstreamId);
    if (input.evidencePage) {
      const presented = new Set(input.evidencePage.evidence.map((item) => item.exchangeId));
      if (patch.sourceExchangeIds.some((id) => !presented.has(id))) {
        throw new Error("capsule source was not present in the fixed evidence page");
      }
    }
    assertVerifiedSources(db, patch.verifiedProgress, input.evidencePage);
    const current = db.prepare(`
      SELECT generation FROM work_capsules WHERE workstream_id = ?
    `).get(input.workstreamId) as { generation: number } | undefined;
    const generation = current?.generation ?? 0;
    if (generation !== input.expectedGeneration) return null;
    const next = generation + 1;
    const result = db.prepare(`
      INSERT INTO work_capsules
        (workstream_id, generation, objective, current_state,
         verified_progress_json, hypotheses_json, blockers_json,
         open_questions_json, next_actions_json, touched_areas_json,
         carry_fact_revisions_json, source_exchange_ids_json,
         through_checkpoint_id, authority, source_workspace_id, source_session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'context-only', ?, ?, ?)
      ON CONFLICT(workstream_id) DO UPDATE SET
        generation = excluded.generation,
        objective = excluded.objective,
        current_state = excluded.current_state,
        verified_progress_json = excluded.verified_progress_json,
        hypotheses_json = excluded.hypotheses_json,
        blockers_json = excluded.blockers_json,
        open_questions_json = excluded.open_questions_json,
        next_actions_json = excluded.next_actions_json,
        touched_areas_json = excluded.touched_areas_json,
        carry_fact_revisions_json = excluded.carry_fact_revisions_json,
        source_exchange_ids_json = excluded.source_exchange_ids_json,
        through_checkpoint_id = excluded.through_checkpoint_id,
        source_workspace_id = excluded.source_workspace_id,
        source_session_id = excluded.source_session_id,
        updated_at = excluded.updated_at
      WHERE work_capsules.generation = ?
    `).run(
      input.workstreamId,
      next,
      patch.objective,
      patch.currentState,
      JSON.stringify(patch.verifiedProgress),
      JSON.stringify(patch.hypotheses),
      JSON.stringify(patch.blockers),
      JSON.stringify(patch.openQuestions),
      JSON.stringify(patch.nextActions),
      JSON.stringify(patch.touchedAreas),
      JSON.stringify(patch.carryFactRevisions),
      JSON.stringify(patch.sourceExchangeIds),
      input.throughCheckpointId,
      checkpoint.workspace_id,
      checkpoint.session_id,
      now,
      input.expectedGeneration,
    );
    if (result.changes !== 1) return null;
    if (input.evidencePage && !commitCapsulePage(db, input.workstreamId, input.evidencePage)) {
      throw new Error("Capsule frontier changed during atomic completion");
    }
    const drained = !input.evidencePage || input.evidencePage.throughSeq >= input.evidencePage.targetSeq;
    db.prepare(`
      UPDATE capsule_checkpoint_state
      SET state = ?, updated_at = ? WHERE checkpoint_id = ?
    `).run(drained ? "processed" : "pending", now, input.throughCheckpointId);
    if (input.jobLease) {
      const completed = db.prepare(`
        UPDATE memory_jobs
        SET state = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?,
            attempts = CASE WHEN ? THEN attempts ELSE 0 END
        WHERE job_id = ? AND state = 'running' AND lease_owner = ?
          AND lease_generation = ? AND lease_until > ?
      `).run(
        drained ? "completed" : "pending",
        now,
        drained ? 1 : 0,
        input.jobLease.jobId,
        input.jobLease.owner,
        input.jobLease.leaseGeneration,
        now,
      );
      if (completed.changes !== 1) {
        throw new Error("capsule job lease changed during atomic completion");
      }
      db.prepare(`
        UPDATE checkpoints SET state = ? WHERE checkpoint_id = ?
      `).run(drained ? "processed" : "processing", input.throughCheckpointId);
    }
    return readWorkCapsule(db, input.workstreamId);
  });
  return tx.immediate();
}

export function completeEmptyCapsuleCheckpoint(
  db: Database.Database,
  input: {
    checkpointId: string;
    jobId: string;
    owner: string;
    leaseGeneration: number;
    evidencePage?: CapsulePage;
    now?: string;
  },
): boolean {
  const now = input.now ?? new Date().toISOString();
  const tx = db.transaction(() => {
    const workstream = db.prepare("SELECT workstream_id FROM capsule_checkpoint_state WHERE checkpoint_id = ?")
      .get(input.checkpointId) as { workstream_id: string } | undefined;
    if (input.evidencePage && (!workstream || !capsulePageIsCurrent(db, workstream.workstream_id, input.evidencePage))) return false;
    const completed = db.prepare(`
      UPDATE memory_jobs
      SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE job_id = ? AND kind = 'capsule_update' AND checkpoint_id = ?
        AND state = 'running' AND lease_owner = ? AND lease_generation = ?
        AND lease_until > ?
    `).run(
      now,
      input.jobId,
      input.checkpointId,
      input.owner,
      input.leaseGeneration,
      now,
    );
    if (completed.changes !== 1) return false;
    if (input.evidencePage && !commitCapsulePage(db, workstream!.workstream_id, input.evidencePage)) {
      throw new Error("empty Capsule frontier changed during atomic completion");
    }
    db.prepare(`
      UPDATE capsule_checkpoint_state SET state = 'processed', updated_at = ?
      WHERE checkpoint_id = ?
    `).run(now, input.checkpointId);
    db.prepare("UPDATE checkpoints SET state = 'processed' WHERE checkpoint_id = ?")
      .run(input.checkpointId);
    return true;
  });
  return tx.immediate();
}

export function readWorkCapsule(
  db: Database.Database,
  workstreamId: string,
): WorkCapsule | null {
  const row = db.prepare(`
    SELECT w.*, COALESCE(f.through_seq, 0) AS through_seq
    FROM work_capsules w LEFT JOIN capsule_frontiers f USING(workstream_id) WHERE w.workstream_id = ?
  `).get(workstreamId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    workstreamId,
    generation: Number(row.generation),
    objective: String(row.objective),
    currentState: String(row.current_state),
    verifiedProgress: parseJsonArray<CapsuleEvidenceItem>(row.verified_progress_json),
    hypotheses: parseJsonArray<CapsuleEvidenceItem>(row.hypotheses_json),
    blockers: parseJsonArray<string>(row.blockers_json),
    openQuestions: parseJsonArray<string>(row.open_questions_json),
    nextActions: parseJsonArray<string>(row.next_actions_json),
    touchedAreas: parseJsonArray<string>(row.touched_areas_json),
    carryFactRevisions: parseJsonArray<ResidentFactRevision>(row.carry_fact_revisions_json),
    sourceExchangeIds: parseJsonArray<string>(row.source_exchange_ids_json),
    throughCheckpointId: row.through_checkpoint_id ? String(row.through_checkpoint_id) : null,
    throughSeq: Number(row.through_seq),
    authority: "context-only",
    sourceWorkspaceId: row.source_workspace_id ? String(row.source_workspace_id) : null,
    sourceSessionId: row.source_session_id ? String(row.source_session_id) : null,
    updatedAt: String(row.updated_at),
  };
}

function extractPlanLine(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:next|다음|todo|계속|해야)/i.test(line)) ?? null;
}

/** Flatten memory data before placing it beside structural context headings. */
function contextData(value: unknown, max = 500): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function compactField(values: string[], fallback: string): string {
  const items = values.map((value) => contextData(value)).filter(Boolean);
  return items.length > 0 ? items.join("; ") : fallback;
}

export function buildDeterministicTailBaton(
  db: Database.Database,
  input: { sessionId: string; maxChars?: number; pending?: string[] },
): string {
  const maxChars = Math.max(0, Math.min(1_500, input.maxChars ?? 1_200));
  const exchanges = db.prepare(`
    SELECT id, user_message, assistant_message FROM exchanges
    WHERE session_id = ? ORDER BY exchange_seq DESC, rowid DESC LIMIT 8
  `).all(input.sessionId) as Array<{
    id: string;
    user_message: string;
    assistant_message: string;
  }>;
  const latestUser = exchanges.find((row) => row.user_message.trim())?.user_message.trim() ?? "";
  const plan = exchanges.map((row) => extractPlanLine(row.assistant_message)).find(Boolean) ?? null;
  const tools = db.prepare(`
    SELECT t.tool_name, t.tool_result, t.is_error, t.source_type
    FROM tool_calls t JOIN exchanges e ON e.id = t.exchange_id
    WHERE e.session_id = ? AND t.source_type IN ('repo_file','git_history','test_execution')
    ORDER BY e.exchange_seq DESC, e.rowid DESC, t.timestamp DESC LIMIT 12
  `).all(input.sessionId) as Array<{
    tool_name: string;
    tool_result: string | null;
    is_error: number;
    source_type: string;
  }>;
  const touched = [...new Set(tools.flatMap((tool) =>
    (tool.tool_result ?? "").match(/(?:^|\s)([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/g) ?? []))]
    .map((item) => contextData(item.trim())).slice(0, 5);
  const trustedTest = tools.find((tool) => tool.source_type === "test_execution" && !tool.is_error);
  const unresolved = tools.find((tool) => tool.is_error);
  const lines = ["[WORK NOW — DETERMINISTIC TAIL BATON]"];
  lines.push(input.pending?.length ? "Status: stale/context-only" : "Status: context-only");
  for (const pending of input.pending ?? []) {
    const text = contextData(pending, 300);
    if (text) lines.push(`Pending: ${text}`);
  }
  if (latestUser) lines.push(`Request: ${contextData(latestUser)}`);
  if (plan) lines.push(`Next: ${contextData(plan, 300)}`);
  if (touched.length) lines.push(`Touched: ${touched.join(", ")}`);
  if (trustedTest?.tool_result) {
    lines.push(`Observed test evidence (verify): ${contextData(trustedTest.tool_result, 300)}`);
  }
  if (unresolved?.tool_result) {
    lines.push(`Observed error (verification pending): ${contextData(unresolved.tool_result, 300)}`);
  }
  return lines.join("\n").slice(0, maxChars);
}

function renderCapsule(
  capsule: WorkCapsule,
  maxChars: number,
  options: CapsuleRenderOptions = {},
): string {
  const hasWorkContent = [
    capsule.objective,
    capsule.currentState,
    ...capsule.verifiedProgress.map((item) => item.text),
    ...capsule.hypotheses.map((item) => item.text),
    ...capsule.blockers,
    ...capsule.nextActions,
    ...capsule.touchedAreas,
    ...capsule.sourceExchangeIds,
  ].some((value) => contextData(value).length > 0);
  if (!hasWorkContent) return "";

  const verified = capsule.verifiedProgress.map((item) => item.text);
  const hypotheses = capsule.hypotheses.map((item) => item.text);
  const corrections = options.recentCorrections ?? [];
  const evidenceLocations = [
    ...capsule.touchedAreas.map((area) => `area ${area}`),
    ...capsule.sourceExchangeIds.map((id) => `exchange ${id}`),
    ...capsule.verifiedProgress.flatMap((item) => item.sourceExchangeIds.map((id) => `exchange ${id}`)),
    ...capsule.hypotheses.flatMap((item) => item.sourceExchangeIds.map((id) => `exchange ${id}`)),
  ];
  const fields: Array<[string, string]> = [
    ["Current goal", compactField([
      capsule.objective ? `Objective: ${capsule.objective}` : "",
      capsule.currentState ? `State: ${capsule.currentState}` : "",
    ], "unknown/unrecorded")],
    ["Verified results", compactField(verified, "unknown/unverified")],
    ["Unverified hypotheses", compactField(hypotheses, "none recorded (unverified/unknown)")],
    ["Recent corrections", compactField(corrections, "none observed in bounded rehydration")],
    ["Blockers", compactField(capsule.blockers.map((item) => `Blocker: ${item}`), "none recorded")],
    ["Next actions", compactField(capsule.nextActions.map((item) => `Next: ${item}`), "unknown/unrecorded")],
    ["Evidence locations", compactField(evidenceLocations, "unknown/unrecorded")],
  ];
  let block = "[WORK NOW]";
  block += options.stale ? "\nStatus: stale/context-only" : "\nStatus: context-only";

  // A stale Capsule shares a small slot with the tail baton. Preserve the two
  // highest-signal handoff fields under that tight budget before filling the
  // richer seven-field view used at the normal budget.
  if (options.stale && maxChars < 700) {
    const compactFields: Array<[string, string]> = [
      ["Current goal", capsule.objective ? `Objective: ${contextData(capsule.objective, 48)}` : ""],
      ["Next", capsule.nextActions[0] ?? ""],
      ["Current state", capsule.currentState ? `State: ${capsule.currentState}` : ""],
    ].filter((entry): entry is [string, string] => !!entry[1]);
    for (const [label, value] of compactFields) {
      const prefix = `\n${label}: `;
      const valueBudget = Math.max(0, maxChars - block.length - prefix.length);
      if (valueBudget <= 0) break;
      const text = contextData(value, valueBudget);
      if (!text) break;
      block += `${prefix}${text}`;
    }
    return block.slice(0, maxChars);
  }
  if (maxChars < 300) {
    const compactFields: Array<[string, string]> = [
      ["Current goal", capsule.objective
        ? `Objective: ${capsule.objective}`
        : capsule.currentState ? `State: ${capsule.currentState}` : ""],
      ["Next actions", capsule.nextActions[0] ? `Next: ${capsule.nextActions[0]}` : ""],
    ].filter((entry): entry is [string, string] => !!entry[1]);
    const fixed = compactFields.reduce((sum, [label]) => sum + label.length + 2, 0) + compactFields.length;
    const valueBudget = Math.floor(Math.max(0, maxChars - block.length - fixed) / Math.max(1, compactFields.length));
    for (const [label, value] of compactFields) {
      const text = contextData(value, valueBudget);
      if (text) block += `\n${label}: ${text}`;
    }
    return block.slice(0, maxChars);
  }
  for (const [index, [label, value]] of fields.entries()) {
    const allowance = Math.floor((maxChars - block.length) / (fields.length - index));
    const text = contextData(value, Math.max(0, allowance - label.length - 2));
    if (text) block += `\n${label}: ${text}`;
  }
  return block === "[WORK NOW]" ? "" : block.slice(0, maxChars);
}

export function buildRehydrationContext(
  db: Database.Database,
  input: { sessionId: string; maxChars?: number },
): {
  context: string;
  factRevisions: ResidentFactRevision[];
  capsuleGeneration: number;
  projectRevisionComplete: boolean;
  projectMemoryRevision: number;
  contextEpoch: number;
  projectId: string | null;
  workstreamId: string | null;
  hotEvidenceCursor: number;
  hotEvidenceSeqs: number[];
} {
  if (!db.inTransaction) {
    const readSnapshot = db.transaction(() => buildRehydrationContext(db, input));
    return readSnapshot();
  }
  const state = db.prepare(`
    SELECT workstream_id, context_epoch, carry_fact_revisions_json,
           resident_fact_revisions_json, latest_checkpoint_id, project_id,
           workspace_id, memory_revision_seen, hot_evidence_cursor
    FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as Record<string, unknown> | undefined;
  if (!state) {
    return {
      context: "",
      factRevisions: [],
      capsuleGeneration: 0,
      projectRevisionComplete: true,
      projectMemoryRevision: 0,
      contextEpoch: 0, projectId: null, workstreamId: null, hotEvidenceCursor: 0, hotEvidenceSeqs: [],
    };
  }
  const capsule = readWorkCapsule(db, String(state.workstream_id));
  const carry = parseJsonArray<ResidentFactRevision>(state.carry_fact_revisions_json);
  const resident = parseJsonArray<ResidentFactRevision>(state.resident_fact_revisions_json);
  type CorrectionFact = {
    id: string;
    fact: string;
    semantic_generation: number;
    lifecycle_generation: number;
    is_active: number;
  };
  const validFacts: Array<{ revision: ResidentFactRevision; text: string }> = [];
  const carryCorrections: CorrectionFact[] = [];
  const selectFact = db.prepare(`
    SELECT id, fact, semantic_generation, lifecycle_generation, is_active FROM facts
    WHERE id = ? AND is_active = 1
  `);
  for (const revision of carry) {
    const row = selectFact.get(revision[0]) as {
      fact: string;
      semantic_generation: number;
      lifecycle_generation: number;
    } | undefined;
    if (!row) continue;
    const current: ResidentFactRevision = [revision[0], row.semantic_generation, row.lifecycle_generation];
    if (current[1] === revision[1] && current[2] === revision[2]) {
      validFacts.push({ revision: current, text: row.fact });
    } else {
      carryCorrections.push({
        id: revision[0],
        fact: row.fact,
        semantic_generation: row.semantic_generation,
        lifecycle_generation: row.lifecycle_generation,
        is_active: 1,
      });
    }
  }
  const maxChars = Math.max(
    500,
    Math.min(REHYDRATION_CONTEXT_LIMITS.maxChars, input.maxChars ?? REHYDRATION_CONTEXT_LIMITS.maxChars),
  );
  const contextBudget = {
    maxChars,
    maxEstimatedTokens: REHYDRATION_CONTEXT_LIMITS.maxEstimatedTokens,
  };
  const joinBlocks = (blocks: string[]): string => blocks.filter(Boolean).join("\n\n");
  const fitsRehydrationBudget = (blocks: string[] | string): boolean => {
    const candidate = typeof blocks === "string" ? blocks : joinBlocks(blocks);
    return !candidate || fitsContextBudget(candidate, contextBudget);
  };
  const capsuleStaleReasons: string[] = [];
  if (capsule) {
    if (db.prepare(`SELECT 1 FROM workstream_evidence
        WHERE workstream_id = ? AND seq > ? LIMIT 1`).get(state.workstream_id, capsule.throughSeq)) {
      capsuleStaleReasons.push("newer workstream evidence awaits Capsule distillation");
    }
    const captureJob = db.prepare(`SELECT state FROM memory_jobs
      WHERE checkpoint_id = ? AND kind = 'capture_index' AND state <> 'completed' LIMIT 1`)
      .get(state.latest_checkpoint_id ?? null) as { state: string } | undefined;
    if (captureJob) capsuleStaleReasons.push(`capture/index job is ${captureJob.state}`);
    const capsuleJob = db.prepare(`SELECT j.state
      FROM memory_jobs j
      LEFT JOIN checkpoints c ON c.checkpoint_id = j.checkpoint_id
      WHERE j.partition_key = ? AND j.kind = 'capsule_update'
        AND (
          j.state IN ('pending','running','retry')
          OR (
            j.state = 'dead'
            AND ? IS NOT NULL
            AND c.rowid > COALESCE((
              SELECT rowid FROM checkpoints WHERE checkpoint_id = ?
            ), -1)
          )
        )
        AND (c.checkpoint_id IS NULL OR c.workstream_id = ?)
      ORDER BY j.updated_at DESC, j.rowid DESC LIMIT 1`).get(
        `workstream:${state.workstream_id}`,
        capsule.throughCheckpointId,
        capsule.throughCheckpointId,
        state.workstream_id,
      ) as { state: string } | undefined;
    if (capsuleJob) capsuleStaleReasons.push(`Capsule update job is ${capsuleJob.state}`);
    // Legacy/manual projections have no sequence coverage yet.
    if (capsule.throughSeq === 0 && state.latest_checkpoint_id &&
        capsule.throughCheckpointId !== String(state.latest_checkpoint_id)) {
      capsuleStaleReasons.push("latest checkpoint is outside the Capsule coverage");
    }
  }
  const capsuleIsStale = capsuleStaleReasons.length > 0;
  const projectId = state.project_id ? String(state.project_id) : null;
  const currentProjectRevision = projectId ? projectRevision(db, projectId) : 0;
  let freshCorrections: CorrectionFact[] = carryCorrections;
  if (projectId && currentProjectRevision > Number(state.memory_revision_seen ?? 0)) {
    const priorRevisions = [
      ...carry,
      ...resident,
      ...validFacts.map(({ revision }) => revision),
    ];
    const residentKeys = new Set(priorRevisions.map(([id, semantic, lifecycle]) =>
      `${id}:${semantic}:${lifecycle}`));
    const residentIds = new Set(priorRevisions.map(([id]) => id));
    const corrections = db.prepare(`
      SELECT id, fact, semantic_generation, lifecycle_generation, is_active
      FROM facts
      WHERE project_id = ? AND (
        promotion_state IN ('decision','project-current','legacy-project') OR
        (promotion_state = 'workspace' AND workspace_id = ?) OR
        (promotion_state = 'workstream' AND workstream_id = ?)
      )
      ORDER BY updated_at DESC, id
    `).all(projectId, state.workspace_id ?? null, state.workstream_id) as Array<{
      id: string; fact: string; semantic_generation: number; lifecycle_generation: number;
      is_active: number;
    }>;
    const projectCorrections = corrections.filter((fact) => {
      const changed = !residentKeys.has(
        `${fact.id}:${fact.semantic_generation}:${fact.lifecycle_generation}`,
      );
      return changed && (fact.is_active === 1 || residentIds.has(fact.id));
    });
    const byId = new Map(freshCorrections.map((fact) => [fact.id, fact]));
    for (const fact of projectCorrections) byId.set(fact.id, fact);
    freshCorrections = [...byId.values()];
  }
  const sections: string[] = [];
  const emittedRevisions: ResidentFactRevision[] = [];
  // Reserve actual rendered work context before corrections can consume the
  // bundle. A stale Capsule shares its slot with the session's latest baton.
  const workBudget = Math.floor(maxChars * 0.6);
  const capsuleRenderOptions: CapsuleRenderOptions = {
    stale: capsuleIsStale,
    recentCorrections: freshCorrections.map((fact) => fact.is_active === 1
      ? `Updated (supersedes earlier context): ${fact.fact}`
      : `No longer active: ${fact.fact}`),
  };
  let capsuleBlock = "";
  if (capsule) {
    const capsuleBudget = capsuleIsStale ? Math.floor(workBudget / 2) : workBudget;
    // A character budget alone is insufficient for CJK/emoji-heavy Capsules.
    // Re-render progressively smaller candidates so the complete host envelope
    // fits before any residency or receipt metadata can acknowledge it.
    for (let candidateChars = capsuleBudget; candidateChars >= 0; candidateChars--) {
      const candidate = renderCapsule(capsule, candidateChars, capsuleRenderOptions);
      if (candidate && fitsRehydrationBudget(candidate)) {
        capsuleBlock = candidate;
        break;
      }
    }
  }
  const baton = (!capsuleBlock || capsuleIsStale)
    ? buildDeterministicTailBaton(db, {
        sessionId: input.sessionId,
        maxChars: workBudget - capsuleBlock.length - (capsuleBlock ? 2 : 0),
        pending: capsuleIsStale ? capsuleStaleReasons : [],
      })
    : "";
  // Prefer the complete work handoff, then retain the Capsule or baton alone
  // if the combined candidate exceeds the final wrapped budget.
  const workBlock = [
    joinBlocks([capsuleBlock, baton]),
    capsuleBlock,
    baton,
  ].find((candidate) => candidate && fitsRehydrationBudget(candidate)) ?? "";
  let sectionBudget = maxChars - workBlock.length - (workBlock ? 2 : 0);
  let used = 0;
  let workAppended = false;
  const appendSection = (
    heading: string,
    items: Array<{ text: string; revision?: ResidentFactRevision }>,
  ): number => {
    if (items.length === 0) return 0;
    const accepted: string[] = [];
    const acceptedRevisions: ResidentFactRevision[] = [];
    for (const item of items) {
      const reservedWork = !workAppended && workBlock ? [workBlock] : [];
      const fitsLine = (limit: number): string | null => {
        const line = `- ${contextData(item.text, limit)}`;
        const prospective = `${heading}\n${[...accepted, line].join("\n")}`;
        const separator = sections.length > 0 ? 2 : 0;
        if (used + separator + prospective.length > sectionBudget) return null;
        return fitsRehydrationBudget([...sections, prospective, ...reservedWork]) ? line : null;
      };
      let low = 1;
      let high = 260;
      let line: string | null = null;
      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        const candidate = fitsLine(midpoint);
        if (candidate) {
          line = candidate;
          low = midpoint + 1;
        } else {
          high = midpoint - 1;
        }
      }
      if (!line) break;
      accepted.push(line);
      if (item.revision) acceptedRevisions.push(item.revision);
    }
    if (accepted.length === 0) return 0;
    const block = `${heading}\n${accepted.join("\n")}`;
    used += (sections.length > 0 ? 2 : 0) + block.length;
    sections.push(block);
    emittedRevisions.push(...acceptedRevisions);
    return accepted.length;
  };
  const emittedCorrectionCount = appendSection("[MEMEX CORRECTION]", freshCorrections.map((fact) => ({
    text: fact.is_active === 1 ? fact.fact : `No longer active: ${fact.fact}`,
    revision: [fact.id, fact.semantic_generation, fact.lifecycle_generation],
  })));
  appendSection("[CURRENT TRUTH]", validFacts.slice(0, 4).map(({ text, revision }) => ({ text, revision })));

  const capsuleGeneration = capsuleBlock && capsule ? capsule.generation : 0;
  if (workBlock) {
    used += (sections.length ? 2 : 0) + workBlock.length;
    sections.push(workBlock);
    workAppended = true;
  }
  sectionBudget = maxChars;
  const hotEvidenceCursor = Number(state.hot_evidence_cursor ?? 0);
  let hotEvidenceSeqs: number[] = [];
  if (projectId) {
    const recent = readHotEvidence(db, {
      projectId,
      workstreamId: String(state.workstream_id),
      excludeSessionId: input.sessionId,
      afterSeq: hotEvidenceCursor,
      limit: 3,
    });
    const emitted = appendSection("[RECENT EVIDENCE — NOT YET DISTILLED]", recent.map((item) => ({
      text: String(item.evidence_text),
    })));
    hotEvidenceSeqs = recent.slice(0, emitted).map((item) => Number(item.seq));
  }
  const context = joinBlocks(sections);
  if (!fitsRehydrationBudget(context)) {
    throw new Error("rehydration context exceeded the host budget after candidate selection");
  }
  return {
    context,
    factRevisions: emittedRevisions,
    capsuleGeneration,
    projectRevisionComplete: emittedCorrectionCount === freshCorrections.length,
    projectMemoryRevision: currentProjectRevision,
    contextEpoch: Number(state.context_epoch), projectId, workstreamId: String(state.workstream_id),
    hotEvidenceCursor, hotEvidenceSeqs,
  };
}

function emitAdditionalContext(event: "SessionStart" | "UserPromptSubmit", context: string): string {
  if (!context) return "";
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: wrapMemoryContext(context),
    },
  }) + "\n";
}

function captureKind(event: string): CaptureKind | null {
  if (event === "Stop") return "stop";
  if (event === "Interrupt") return "interrupt";
  if (event === "PreCompact") return "precompact";
  if (event === "SessionEnd") return "final";
  return null;
}

export function handleContinuityHook(
  payloadValue: unknown,
  options: { db?: Database.Database; strictCapture?: boolean } = {},
): HandleHookResult {
  const payload = normalizeHookPayload(payloadValue);
  const ownDb = !options.db;
  const db = options.db ?? initDatabase();
  try {
    recordHookEvent(payload.hookEventName, {
      sessionId: payload.sessionId,
      cwd: payload.cwd,
    });
    if (isConversationExcludedSession(db, payload.sessionId)) {
      // Conversation exclusion is terminal privacy state. Do not recreate a
      // journal/checkpoint/session projection after a prior purge.
      return { stdout: "" };
    }
    const kind = captureKind(payload.hookEventName);
    if (kind) {
      if (!payload.transcriptPath) throw new Error("capture hook requires transcript_path");
      try {
        const capture = captureTranscriptPrefix(db, {
          sessionId: payload.sessionId,
          project: payload.cwd,
          transcriptPath: payload.transcriptPath,
          kind,
          turnId: payload.turnId,
          workstreamId: payload.workstreamId,
        });
        return { stdout: "", capture };
      } catch (error) {
        const warning = error instanceof Error ? error.message : String(error);
        try {
          recordCaptureGap(db, {
            sessionId: payload.sessionId,
            sourcePath: payload.transcriptPath,
            eventKind: kind,
            reason: warning,
          });
        } catch {
          // If even the gap record cannot persist, strict capture must fail.
        }
        if (options.strictCapture ?? process.env.MEMEX_STRICT_CAPTURE === "1") throw error;
        return { stdout: "", warning };
      }
    }
    if (payload.hookEventName === "PostCompact") {
      // Optional telemetry only. No correctness transition is allowed here.
      return { stdout: "" };
    }
    let canonicalProject = payload.cwd;
    let canonicalBranch: string | null = null;
    if (payload.transcriptPath) {
      const source = validateTranscriptPath(payload.transcriptPath);
      const meta = readCanonicalSessionMeta(source.realpath);
      if (meta.sessionId !== payload.sessionId) {
        throw new Error("hook session_id does not match transcript session_meta id");
      }
      canonicalProject = meta.project;
      canonicalBranch = meta.branch;
    } else if (payload.hookEventName === "SessionStart") {
      const existing = db.prepare(
        "SELECT project FROM session_memory_state WHERE session_id = ?",
      ).get(payload.sessionId) as { project: string } | undefined;
      if (!existing) {
        throw new Error("SessionStart requires transcript_path until canonical session state exists");
      }
      canonicalProject = existing.project;
    }
    ensureSessionMemoryState(db, {
      sessionId: payload.sessionId,
      project: canonicalProject,
      explicitWorkstreamId: payload.workstreamId,
      prompt: payload.hookEventName === "UserPromptSubmit" ? payload.prompt : null,
      branch: canonicalBranch,
      source: payload.source ?? payload.hookEventName,
    });
    if (payload.hookEventName === "SessionStart") {
      const source = payload.source as LifecycleSource | null;
      if (!source || !["startup", "resume", "clear", "compact"].includes(source)) {
        throw new Error("invalid SessionStart source");
      }
      const recoveryWarning = recoverContinuitySession(db, payload.sessionId);
      if (source === "clear" || source === "compact") {
        advanceContextEpoch(db, {
          sessionId: payload.sessionId,
          source,
          turnId: payload.turnId,
        });
      }
      if (source === "resume" || source === "compact") {
        const rehydrated = buildRehydrationContext(db, { sessionId: payload.sessionId });
        const epoch = rehydrated.contextEpoch;
        let recallReceipt: ContinuityRecallReceipt | undefined;
        const commitRehydration = db.transaction(() => {
          if (rehydrated.context.trim()) {
            // Keep continuity rehydration provenance in the same transaction
            // as residency. The hook marks it emitted only after stdout is
            // written to stdout; a failed write remains prepared, not emitted.
            const prompt = JSON.stringify({
              kind: "continuity_rehydration",
              sessionId: payload.sessionId,
              source,
              contextEpoch: epoch,
              turnId: payload.turnId,
              workstreamId: rehydrated.workstreamId,
            });
            const id = recordRecallEvent(db, {
              sessionId: payload.sessionId,
              project: canonicalProject,
              prompt,
              factIds: rehydrated.factRevisions.map(([factId]) => factId),
              context: rehydrated.context,
              projectId: rehydrated.projectId,
              workstreamId: rehydrated.workstreamId,
              contextEpoch: epoch,
              projectMemoryRevision: rehydrated.projectMemoryRevision,
            });
            if (!id) throw new Error("failed to prepare continuity recall receipt");
            recallReceipt = { id, prompt, status: "prepared" };
          }
          if (rehydrated.factRevisions.length &&
              !recordResidentFactRevisions(db, payload.sessionId, epoch, rehydrated.factRevisions)) {
            throw new Error("context epoch changed before rehydration residency commit");
          }
          if (rehydrated.projectRevisionComplete &&
              !markSessionProjectRevisionSeen(
                db,
                payload.sessionId,
                rehydrated.projectMemoryRevision,
              )) {
            throw new Error("project memory revision changed before rehydration commit");
          }
          if (rehydrated.capsuleGeneration > 0) {
            const updated = db.prepare(`
              UPDATE session_memory_state SET capsule_generation_seen = ?, updated_at = ?
              WHERE session_id = ? AND context_epoch = ?
            `).run(rehydrated.capsuleGeneration, new Date().toISOString(), payload.sessionId, epoch);
            if (updated.changes !== 1) {
              throw new Error("context epoch changed before Capsule residency commit");
            }
          }
          if (rehydrated.projectId && rehydrated.workstreamId) {
            commitHotEvidenceCursor(db, {
              sessionId: payload.sessionId, projectId: rehydrated.projectId,
              workstreamId: rehydrated.workstreamId, contextEpoch: epoch,
              fromSeq: rehydrated.hotEvidenceCursor, emittedSeqs: rehydrated.hotEvidenceSeqs,
            });
          }
        });
        commitRehydration.immediate();
        return {
          stdout: emitAdditionalContext("SessionStart", rehydrated.context),
          warning: recoveryWarning,
          ...(recallReceipt ? { recallReceipt } : {}),
        };
      }
      return { stdout: "", warning: recoveryWarning };
    }
    throw new Error(`unsupported continuity hook event: ${payload.hookEventName}`);
  } finally {
    if (ownDb) db.close();
  }
}

export function runtimePlatformSummary(): string {
  return `${process.platform}/${process.arch} node=${process.version} host=${os.hostname()}`;
}

/**
 * Apply the latest event-grounded closure fence after a transcript prefix has
 * been parsed. Raw EOF is not authoritative for final vs interrupted; the
 * lifecycle checkpoint is. A changed closure receives a new generation so an
 * already-running result for the parser-only state cannot become current.
 */
export function applyLatestLifecycleClosure(
  db: Database.Database,
  sessionId: string,
): boolean {
  const tx = db.transaction(() => {
    const checkpoint = db.prepare(`
      SELECT closure_state, through_line FROM checkpoints
      WHERE session_id = ? AND kind IN ('stop','interrupt','precompact','final')
        AND through_line IS NOT NULL
      ORDER BY stream_epoch DESC, through_byte DESC,
        CASE kind WHEN 'final' THEN 4 WHEN 'stop' THEN 3
          WHEN 'interrupt' THEN 2 ELSE 1 END DESC,
        created_at DESC
      LIMIT 1
    `).get(sessionId) as
      | { closure_state: string; through_line: number }
      | undefined;
    if (!checkpoint) return false;
    const exchange = db.prepare(`
      SELECT id, closure_state FROM exchanges
      WHERE session_id = ? AND line_end <= ?
      ORDER BY line_end DESC, exchange_seq DESC, rowid DESC LIMIT 1
    `).get(sessionId, checkpoint.through_line) as
      | { id: string; closure_state: string }
      | undefined;
    if (!exchange || exchange.closure_state === checkpoint.closure_state) return false;
    db.prepare(`
      UPDATE exchange_extraction_state SET state = 'superseded'
      WHERE exchange_id = ? AND state <> 'processed'
    `).run(exchange.id);
    return db.prepare(`
      UPDATE exchanges
      SET closure_state = ?, content_generation = content_generation + 1
      WHERE id = ? AND closure_state = ?
    `).run(
      checkpoint.closure_state,
      exchange.id,
      exchange.closure_state,
    ).changes === 1;
  });
  return db.inTransaction ? tx() : tx.immediate();
}
