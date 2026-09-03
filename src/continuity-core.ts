import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase } from "./db.js";
import { getMemexHome, getSessionsRoot } from "./paths.js";
import { recordHookEvent } from "./observe-hook-event.js";
import { isConversationExcludedSession } from "./conversation-policy.js";

export const CONTINUITY_CAPTURE_POLICY_VERSION = "continuity-capture-v1";
export const CAPSULE_POLICY_VERSION = "continuity-capsule-v1";
export const CONTINUITY_PARSER_VERSION = 2;
const MAX_CAPTURE_DELTA_BYTES = 64 * 1024 * 1024;
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

export interface WorkCapsule extends WorkCapsulePatch {
  workstreamId: string;
  generation: number;
  throughCheckpointId: string | null;
  authority: "context-only";
  updatedAt: string;
}

export interface HandleHookResult {
  stdout: string;
  warning?: string;
  capture?: CaptureResult;
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
): { sessionId: string; project: string } {
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
        payload?: { id?: unknown; cwd?: unknown };
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
      return { sessionId, project: path.resolve(cwd) };
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

function sessionWorkstreamId(project: string, sessionId: string): string {
  return `ws-${stableId("session-workstream", project, sessionId).slice(0, 32)}`;
}

export function ensureSessionMemoryState(
  db: Database.Database,
  input: {
    sessionId: string;
    project: string;
    explicitWorkstreamId?: string | null;
    source?: string | null;
    now?: string;
  },
): { workstreamId: string; contextEpoch: number } {
  const now = input.now ?? new Date().toISOString();
  const existing = db.prepare(`
    SELECT workstream_id, context_epoch, project FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as
    | { workstream_id: string; context_epoch: number; project: string }
    | undefined;
  if (existing) {
    if (existing.project !== input.project) {
      throw new Error("session project identity does not match canonical session_meta cwd");
    }
    db.prepare(`
      UPDATE session_memory_state SET last_source = ?, updated_at = ? WHERE session_id = ?
    `).run(input.source ?? null, now, input.sessionId);
    return {
      workstreamId: existing.workstream_id,
      contextEpoch: existing.context_epoch,
    };
  }
  const explicit = input.explicitWorkstreamId?.trim();
  const workstreamId = explicit && /^[A-Za-z0-9_-]{4,128}$/.test(explicit)
    ? explicit
    : sessionWorkstreamId(input.project, input.sessionId);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO minimal_workstreams
        (workstream_id, project, session_id, binding_reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      workstreamId,
      input.project,
      input.sessionId,
      explicit ? "explicit" : "session-local",
      now,
      now,
    );
    db.prepare(`
      INSERT OR IGNORE INTO session_memory_state
        (session_id, project, workstream_id, context_epoch, last_source, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(
      input.sessionId,
      input.project,
      workstreamId,
      input.source ?? null,
      now,
      now,
    );
  });
  if (db.inTransaction) tx();
  else tx.immediate();
  return { workstreamId, contextEpoch: 0 };
}

function checkpointOrdinal(streamEpoch: number, throughByte: number): number {
  const ordinal = streamEpoch * 1_000_000_000_000 + throughByte;
  if (!Number.isSafeInteger(ordinal)) throw new Error("checkpoint ordinal overflow");
  return ordinal;
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
  if (deltaSize < 0 || deltaSize > MAX_CAPTURE_DELTA_BYTES) {
    const reason = deltaSize < 0
      ? "source transcript rewound unexpectedly"
      : `capture delta exceeds ${MAX_CAPTURE_DELTA_BYTES} bytes`;
    recordCaptureGap(db, {
      sessionId: input.sessionId,
      streamEpoch,
      sourcePath: source.realpath,
      eventKind: input.kind,
      reason,
      now,
    });
    throw new Error(reason);
  }
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
  const fd = fs.openSync(source.realpath, "r");
  let delta = Buffer.alloc(deltaSize);
  let sourceAfterRead: fs.Stats;
  let sourceGuardStart = 0;
  let sourceGuardHash = sha256(Buffer.alloc(0));
  try {
    let offset = 0;
    while (offset < delta.length) {
      const read = fs.readSync(fd, delta, offset, delta.length - offset, copiedByteEnd + offset);
      if (read === 0) break;
      offset += read;
    }
    delta = delta.subarray(0, offset);
    sourceAfterRead = fs.fstatSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (
    String(sourceAfterRead!.dev) !== sourceDev ||
    String(sourceAfterRead!.ino) !== sourceIno ||
    sourceAfterRead!.size !== source.stat.size ||
    sourceAfterRead!.mtimeMs !== source.stat.mtimeMs
  ) {
    throw new Error("source transcript changed during capture");
  }
  const finalNewline = delta.lastIndexOf(0x0a);
  const complete = finalNewline >= 0 ? delta.subarray(0, finalNewline + 1) : Buffer.alloc(0);
  const sourceThroughByte = copiedByteEnd + complete.length;
  sourceGuardStart = Math.max(0, sourceThroughByte - SOURCE_PREFIX_GUARD_BYTES);
  const guardLength = sourceThroughByte - sourceGuardStart;
  if (guardLength > 0) {
    const guard = Buffer.alloc(guardLength);
    const guardFd = fs.openSync(source.realpath, "r");
    try {
      const read = fs.readSync(guardFd, guard, 0, guard.length, sourceGuardStart);
      if (read !== guard.length) throw new Error("source transcript changed before guard capture");
      sourceGuardHash = sha256(guard);
    } finally {
      fs.closeSync(guardFd);
    }
  }
  const sourceAfterGuard = fs.statSync(source.realpath);
  if (
    String(sourceAfterGuard.dev) !== sourceDev ||
    String(sourceAfterGuard.ino) !== sourceIno ||
    sourceAfterGuard.size !== source.stat.size ||
    sourceAfterGuard.mtimeMs !== source.stat.mtimeMs
  ) {
    throw new Error("source transcript changed before journal append");
  }
  const addedLines = complete.length === 0
    ? 0
    : complete.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
  const throughLine = copiedLineEnd + addedLines;
  const segmentHash = sha256(complete);
  const prefixHash = complete.length > 0
    ? sha256(Buffer.concat([Buffer.from(priorPrefixHash, "utf8"), Buffer.from([0]), complete]))
    : priorPrefixHash || sha256(Buffer.alloc(0));
  const journalPath = journalFile(input.sessionId, streamEpoch);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const journalFd = fs.openSync(journalPath, "a+");
  try {
    const currentSize = fs.fstatSync(journalFd).size;
    if (currentSize < journalByteEnd) {
      const reason = "journal file is shorter than committed boundary";
      recordCaptureGap(db, {
        sessionId: input.sessionId,
        streamEpoch,
        sourcePath: source.realpath,
        eventKind: input.kind,
        reason,
        now,
      });
      throw new Error(reason);
    }
    if (currentSize > journalByteEnd) {
      // Bytes beyond the committed DB boundary are an orphan from a crash
      // after fsync and before the transaction. They were never a checkpointed
      // journal prefix, so deterministically discard only that uncommitted tail.
      fs.ftruncateSync(journalFd, journalByteEnd);
    }
    if (complete.length > 0) fs.writeSync(journalFd, complete, 0, complete.length, journalByteEnd);
    fs.fsyncSync(journalFd);
  } finally {
    fs.closeSync(journalFd);
  }
  input.afterJournalFsync?.();

  const journalThroughByte = journalByteEnd + complete.length;
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
    if (complete.length > 0) {
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
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        (SELECT context_epoch FROM session_memory_state WHERE session_id = ?),
        'pending', ?, ?)
    `).run(
      checkpointId,
      input.sessionId,
      session.workstreamId,
      streamEpoch,
      ordinal,
      input.kind,
      input.turnId ?? null,
      copiedByteEnd,
      sourceThroughByte,
      copiedLineEnd + (complete.length > 0 ? 1 : 0),
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
    const lastCapsuleBoundary = db.prepare(`
      SELECT c.ordinal, c.through_byte
      FROM capsule_checkpoint_state s
      JOIN checkpoints c ON c.checkpoint_id = s.checkpoint_id
      WHERE s.workstream_id = ?
      ORDER BY c.ordinal DESC LIMIT 1
    `).get(session.workstreamId) as { ordinal: number; through_byte: number | null } | undefined;
    const pendingCapsule = db.prepare(`
      SELECT 1 FROM memory_jobs
      WHERE kind = 'capsule_update' AND partition_key = ?
        AND state IN ('pending','running','retry')
      LIMIT 1
    `).get(`workstream:${session.workstreamId}`);
    const accumulated = db.prepare(`
      SELECT COUNT(*) AS boundaries,
             COALESCE(SUM(CASE
               WHEN through_byte > from_byte THEN through_byte - from_byte ELSE 0 END), 0) AS bytes
      FROM checkpoints
      WHERE workstream_id = ? AND ordinal > ? AND ordinal <= ?
        AND kind IN ('stop','interrupt')
    `).get(
      session.workstreamId,
      lastCapsuleBoundary?.ordinal ?? -1,
      ordinal,
    ) as { boundaries: number; bytes: number };
    const forceCapsule = input.kind === "precompact" || input.kind === "final";
    const scheduleCapsule = forceCapsule || (!pendingCapsule && (
      accumulated.boundaries >= 6 || accumulated.bytes >= 8 * 1024
    ));
    if (scheduleCapsule) {
      const currentGeneration = (db.prepare(`
        SELECT generation FROM work_capsules WHERE workstream_id = ?
      `).get(session.workstreamId) as { generation: number } | undefined)?.generation ?? 0;
      db.prepare(`
        INSERT OR IGNORE INTO capsule_checkpoint_state
          (checkpoint_id, workstream_id, state, expected_generation, updated_at)
        VALUES (?, ?, 'pending', ?, ?)
      `).run(checkpointId, session.workstreamId, currentGeneration, now);
      db.prepare(`
        INSERT OR IGNORE INTO memory_jobs
          (job_id, kind, partition_key, checkpoint_id, policy_version, priority,
           state, available_at, max_attempts, idempotency_key, created_at, updated_at)
        VALUES (?, 'capsule_update', ?, ?, ?, 80, 'pending', ?, 5, ?, ?, ?)
      `).run(
        capsuleJobId,
        `workstream:${session.workstreamId}`,
        checkpointId,
        CAPSULE_POLICY_VERSION,
        now,
        `capsule:${checkpointId}`,
        now,
        now,
      );
    }
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
    fromLine: copiedLineEnd + (complete.length > 0 ? 1 : 0),
    throughLine,
    segmentHash,
    prefixHash,
    appendedBytes: complete.length,
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
  for (const entry of revisions) {
    if (
      !Array.isArray(entry) || entry.length !== 3 ||
      typeof entry[0] !== "string" ||
      !Number.isInteger(entry[1]) || !Number.isInteger(entry[2])
    ) continue;
    map.set(entry[0], entry);
  }
  const bounded = [...map.values()].slice(-400);
  return db.prepare(`
    UPDATE session_memory_state
    SET resident_fact_revisions_json = ?, updated_at = ?
    WHERE session_id = ? AND context_epoch = ?
  `).run(JSON.stringify(bounded), now, sessionId, contextEpoch).changes === 1;
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
  const fields = [
    "objective", "currentState", "verifiedProgress", "hypotheses", "blockers",
    "openQuestions", "nextActions", "touchedAreas", "carryFactRevisions",
    "sourceExchangeIds",
  ];
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
): void {
  const ids = [...new Set(verified.flatMap((item) => item.sourceExchangeIds))];
  if (ids.length === 0) return;
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
): void {
  const select = db.prepare("SELECT 1 FROM exchanges WHERE id = ?");
  for (const id of patch.sourceExchangeIds) {
    if (!select.get(id)) throw new Error(`capsule source exchange does not exist: ${id}`);
  }
}

export function applyWorkCapsulePatch(
  db: Database.Database,
  input: {
    workstreamId: string;
    expectedGeneration: number;
    throughCheckpointId: string;
    patch: unknown;
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
      SELECT 1 FROM checkpoints WHERE checkpoint_id = ? AND workstream_id = ?
    `).get(input.throughCheckpointId, input.workstreamId);
    if (!checkpoint) throw new Error("checkpoint does not belong to workstream");
    assertCapsuleSourcesExist(db, patch);
    assertVerifiedSources(db, patch.verifiedProgress);
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
         through_checkpoint_id, authority, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'context-only', ?)
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
      now,
      input.expectedGeneration,
    );
    if (result.changes !== 1) return null;
    db.prepare(`
      UPDATE capsule_checkpoint_state
      SET state = 'processed', updated_at = ? WHERE checkpoint_id = ?
    `).run(now, input.throughCheckpointId);
    if (input.jobLease) {
      const completed = db.prepare(`
        UPDATE memory_jobs
        SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ?
          AND lease_generation = ? AND lease_until > ?
      `).run(
        now,
        input.jobLease.jobId,
        input.jobLease.owner,
        input.jobLease.leaseGeneration,
        now,
      );
      if (completed.changes !== 1) {
        throw new Error("capsule job lease changed during atomic completion");
      }
      db.prepare(`
        UPDATE checkpoints SET state = 'processed' WHERE checkpoint_id = ?
      `).run(input.throughCheckpointId);
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
    now?: string;
  },
): boolean {
  const now = input.now ?? new Date().toISOString();
  const tx = db.transaction(() => {
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
    SELECT * FROM work_capsules WHERE workstream_id = ?
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
    authority: "context-only",
    updatedAt: String(row.updated_at),
  };
}

function extractPlanLine(text: string): string | null {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /(?:next|다음|todo|계속|해야)/i.test(line)) ?? null;
}

export function buildDeterministicTailBaton(
  db: Database.Database,
  input: { sessionId: string; maxChars?: number },
): string {
  const maxChars = Math.max(200, Math.min(1_500, input.maxChars ?? 1_200));
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
    .map((item) => item.trim()).slice(0, 5);
  const trustedTest = tools.find((tool) => tool.source_type === "test_execution" && !tool.is_error);
  const unresolved = tools.find((tool) => tool.is_error);
  const lines = ["[WORK NOW — DETERMINISTIC TAIL BATON]"];
  if (latestUser) lines.push(`Request: ${latestUser.replace(/\s+/g, " ").slice(0, 500)}`);
  if (plan) lines.push(`Next: ${plan.replace(/\s+/g, " ").slice(0, 300)}`);
  if (touched.length) lines.push(`Touched: ${touched.join(", ")}`);
  if (trustedTest?.tool_result) lines.push(`Trusted test: ${trustedTest.tool_result.replace(/\s+/g, " ").slice(0, 300)}`);
  if (unresolved?.tool_result) lines.push(`Unresolved: ${unresolved.tool_result.replace(/\s+/g, " ").slice(0, 300)}`);
  return lines.join("\n").slice(0, maxChars);
}

function renderCapsule(capsule: WorkCapsule): string {
  const lines = ["[WORK NOW]"];
  if (capsule.objective) lines.push(`Objective: ${capsule.objective}`);
  if (capsule.currentState) lines.push(`State: ${capsule.currentState}`);
  if (capsule.blockers[0]) lines.push(`Blocker: ${capsule.blockers[0]}`);
  if (capsule.nextActions[0]) lines.push(`Next: ${capsule.nextActions[0]}`);
  return lines.join("\n");
}

export function buildRehydrationContext(
  db: Database.Database,
  input: { sessionId: string; maxChars?: number },
): { context: string; factRevisions: ResidentFactRevision[]; capsuleGeneration: number } {
  const state = db.prepare(`
    SELECT workstream_id, context_epoch, carry_fact_revisions_json,
           latest_checkpoint_id
    FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as Record<string, unknown> | undefined;
  if (!state) return { context: "", factRevisions: [], capsuleGeneration: 0 };
  const capsule = readWorkCapsule(db, String(state.workstream_id));
  const carry = parseJsonArray<ResidentFactRevision>(state.carry_fact_revisions_json);
  const validFacts: Array<{ revision: ResidentFactRevision; text: string }> = [];
  const selectFact = db.prepare(`
    SELECT fact, semantic_generation, lifecycle_generation FROM facts
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
    validFacts.push({ revision: current, text: row.fact });
  }
  const sections: string[] = [];
  const capsuleIsStale = !!capsule &&
    !!state.latest_checkpoint_id &&
    capsule.throughCheckpointId !== String(state.latest_checkpoint_id);
  if (capsule) sections.push(renderCapsule(capsule));
  if (!capsule || capsuleIsStale) {
    const baton = buildDeterministicTailBaton(db, { sessionId: input.sessionId });
    if (baton) sections.push(baton);
  }
  if (validFacts.length) {
    sections.push("[CURRENT TRUTH]\n" + validFacts.slice(0, 4).map(({ text }) => `- ${text}`).join("\n"));
  }
  const maxChars = Math.max(500, Math.min(2_000, input.maxChars ?? 2_000));
  return {
    context: sections.join("\n\n").slice(0, maxChars),
    factRevisions: validFacts.map(({ revision }) => revision),
    capsuleGeneration: capsule?.generation ?? 0,
  };
}

function emitAdditionalContext(event: "SessionStart" | "UserPromptSubmit", context: string): string {
  if (!context) return "";
  return JSON.stringify({
    continue: true,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: context,
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
    if (payload.transcriptPath) {
      const source = validateTranscriptPath(payload.transcriptPath);
      const meta = readCanonicalSessionMeta(source.realpath);
      if (meta.sessionId !== payload.sessionId) {
        throw new Error("hook session_id does not match transcript session_meta id");
      }
      canonicalProject = meta.project;
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
        const epoch = readResidentFactRevisions(db, payload.sessionId).contextEpoch;
        if (rehydrated.factRevisions.length) {
          recordResidentFactRevisions(db, payload.sessionId, epoch, rehydrated.factRevisions);
        }
        if (rehydrated.capsuleGeneration > 0) {
          db.prepare(`
            UPDATE session_memory_state SET capsule_generation_seen = ?, updated_at = ?
            WHERE session_id = ? AND context_epoch = ?
          `).run(rehydrated.capsuleGeneration, new Date().toISOString(), payload.sessionId, epoch);
        }
        return {
          stdout: emitAdditionalContext("SessionStart", rehydrated.context),
          warning: recoveryWarning,
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
