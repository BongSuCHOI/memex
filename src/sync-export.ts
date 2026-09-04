import fs from 'fs';
import path from 'path';
import os from 'os';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { initDatabase } from './db.js';
import { resolveProjectWorkspace } from './continuity-identity.js';
import { getMemexHome } from './paths.js';

const SYNC_DIR_NAME = 'sync';
const GENERATIONS_DIR_NAME = 'generations';
const CURRENT_MANIFEST = 'CURRENT';
/** Committed generations kept per device: current + one previous for
 * readers that resolved CURRENT between two exports. */
const GENERATIONS_TO_KEEP = 2;
const EXPORT_STATUS_FILE = 'export-status.json';

/** Thrown when another process is mid-export. The SessionEnd hook records it
 * to export-status (visible to doctor) and the next session retries. */
export class ExportLockedError extends Error {
  constructor() {
    super('sync export skipped: another export is in progress');
    this.name = 'ExportLockedError';
  }
}

function isSqliteLockError(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

/**
 * Serialize one local device's exporters with SQLite's process-owned write
 * transaction. The local DB is the device identity boundary, so unrelated
 * devices never contend and no lock artifact enters cloud sync. SQLite drops
 * the lock automatically when a process exits; there is no stat→unlink stale
 * break that can delete a successor's lock (재감사 P2 hardening).
 */
export function withExportTransaction<T>(db: Database.Database, operation: () => T): T {
  db.pragma('busy_timeout = 0');
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    db.pragma('busy_timeout = 5000');
    if (isSqliteLockError(error)) throw new ExportLockedError();
    throw error;
  }
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    db.pragma('busy_timeout = 5000');
  }
}

/** The payload files a committed generation must carry (meta.json excluded —
 * it is the integrity manifest OF these files). Protocol v4: ontology
 * domains/categories/relations and the KR translation are LOCAL DERIVED state
 * — every device rebuilds them from its own facts, so they no longer travel,
 * and private-derived taxonomy can never leak through sync (재감사 P1-4 v4). */
export const SYNC_PAYLOAD_FILE_NAMES = [
  'facts.jsonl',
  'fact-revisions.jsonl',
  'fact-tombstones.jsonl',
  'recall-events.jsonl',
] as const;

/** Non-empty JSONL lines — a generation manifest pins this count per file. */
export function countPayloadRows(content: string): number {
  return content.split('\n').filter((line) => line.trim() !== '').length;
}

/** SHA-256 of the exact bytes a generation file carries. Cloud sync moves a
 * generation directory file-by-file, so a locally-atomic rename proves
 * nothing about what the peer device receives — the importer must verify
 * content, not existence (재감사 P1-4 보강). */
export function payloadSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function getSyncDir(): string {
  const dir = path.join(getMemexHome(), 'conversation-index', SYNC_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export interface SyncExportResult {
  facts: number;
  revisions: number;
  tombstones: number;
  recallEvents: number;
}

/** Durable record of the last sync export attempt (P2-6). SessionEnd must
 * never wedge on export, so failures live here — visible to stderr, the
 * parent hook, and doctor — instead of vanishing with exit 0. */
export interface ExportStatus {
  ok: boolean;
  at: string;
  error?: string;
  counts?: SyncExportResult;
}

function getExportStatusPath(): string {
  return path.join(getMemexHome(), 'conversation-index', SYNC_DIR_NAME, EXPORT_STATUS_FILE);
}

export function readExportStatus(): ExportStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getExportStatusPath(), 'utf8')) as ExportStatus;
    return typeof parsed?.ok === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}

export function recordExportStatus(status: ExportStatus): void {
  const target = getExportStatusPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
  fs.renameSync(tmp, target);
}

function writeAtomic(target: string, body: string): void {
  // Per-process tmp name: two concurrent exports must never rename each
  // other's half-written file.
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
}

/** Delete old committed generations (keep current + one previous) and
 * crashed tmp dirs older than an hour. Exported for the concurrency test
 * suite; production callers pass this process's own current generation. */
export function pruneGenerations(generationsDir: string, currentId: string): void {
  // Concurrent-export hardening (재감사 P2): this process's currentId may be
  // STALE by the time pruning runs — a faster exporter may have already
  // flipped CURRENT. Re-read it and protect whichever generation it names so
  // overlapping SessionEnd exports can never erode the readers' grace window.
  let liveCurrent = currentId;
  try {
    liveCurrent = (JSON.parse(
      fs.readFileSync(path.join(generationsDir, "..", CURRENT_MANIFEST), "utf8"),
    ) as { generation?: string }).generation ?? currentId;
  } catch { /* no readable CURRENT — protect this process's own */ }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(generationsDir, { withFileTypes: true });
  } catch {
    return;
  }
  const protectedIds = new Set([currentId, liveCurrent]);
  const previous = entries
    .filter((e) => e.isDirectory() && !e.name.endsWith('.tmp') && !protectedIds.has(e.name))
    .map((e) => {
      try {
        return { name: e.name, mtimeMs: fs.statSync(path.join(generationsDir, e.name)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((v): v is { name: string; mtimeMs: number } => v !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const g of previous.slice(GENERATIONS_TO_KEEP - 1)) {
    try {
      fs.rmSync(path.join(generationsDir, g.name), { recursive: true, force: true });
    } catch { /* best-effort housekeeping */ }
  }
  const staleTmpMs = 60 * 60 * 1000;
  for (const e of entries.filter((e) => e.isDirectory() && e.name.endsWith('.tmp'))) {
    try {
      const st = fs.statSync(path.join(generationsDir, e.name));
      if (Date.now() - st.mtimeMs > staleTmpMs) {
        fs.rmSync(path.join(generationsDir, e.name), { recursive: true, force: true });
      }
    } catch { /* best-effort housekeeping */ }
  }
}

/**
 * Export current and historical fact state, durable recall receipts, ontology
 * domains/categories, and relations to JSONL files.
 * These JSONL files are durable cross-device state; the large local SQLite
 * index is not copied. Conversation indexes rebuild from rollouts/archives,
 * while facts, revisions, tombstones, and recall receipts reconcile from here.
 *
 * P2-5: one export is one *generation*. Every DB read happens inside a single
 * read transaction, the whole file set is written into
 * `devices/<id>/generations/<uuid>.tmp` and committed by an atomic directory
 * rename, and only then does the `CURRENT` manifest flip atomically — so a
 * crash, a cloud-sync observer, or a concurrent export can never surface a
 * mixed snapshot (facts=N+1 with revisions=N). The importer reads committed
 * generations only. The former per-file root JSONL mirror is gone: the only
 * readers are Memex v2 importers, and writing a non-atomic mirror beside an
 * atomic generation re-opened the mixed-snapshot hole for the reader that
 * also read it (재감사 P1-1). Committed generations are the whole protocol.
 */
export function exportForSync(): SyncExportResult {
  let db: Database.Database;
  try {
    // Export contention is a normal skip/retry condition. Use a zero timeout
    // before schema guards run so a concurrent exporter cannot turn it into a
    // five-second raw SQLITE_BUSY delay during init.
    db = initDatabase({ busyTimeoutMs: 0 });
  } catch (error) {
    if (isSqliteLockError(error)) throw new ExportLockedError();
    throw error;
  }
  const syncDir = getSyncDir();

  const performExport = (): SyncExportResult => {
    let device = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as
      | { value: string }
      | undefined;
    if (!device) {
      const value = randomUUID();
      db.prepare("INSERT INTO sync_meta (key, value) VALUES ('device_id', ?)").run(value);
      device = { value };
    }
    const deviceDir = path.join(syncDir, 'devices', device.value);
    fs.mkdirSync(deviceDir, { recursive: true });

    // The surrounding IMMEDIATE transaction fixes the snapshot for every file
    // in this generation and serializes local exporters. This nested helper is
    // a savepoint; WAL readers still see one consistent DB state throughout.
    const readTx = db.transaction(() => {
      // Compatibility rows may have been inserted by an older local writer or
      // a direct maintenance script after schema migration. Materialize their
      // stable identity before creating a path-free payload.
      const legacyProjectPaths = db.prepare(`
        SELECT DISTINCT scope_project FROM facts
        WHERE scope_type = 'project' AND project_id IS NULL AND scope_project IS NOT NULL
      `).all() as Array<{ scope_project: string }>;
      for (const row of legacyProjectPaths) {
        const identity = resolveProjectWorkspace(db, { cwd: row.scope_project });
        db.prepare(`
          UPDATE facts SET project_id = ?, subject_key = COALESCE(subject_key, 'legacy.fact.' || id)
          WHERE scope_type = 'project' AND project_id IS NULL AND scope_project = ?
        `).run(identity.projectId, row.scope_project);
      }
      const legacyRecallPaths = db.prepare(`
        SELECT DISTINCT project FROM recall_events WHERE project_id IS NULL
      `).all() as Array<{ project: string }>;
      for (const row of legacyRecallPaths) {
        const identity = resolveProjectWorkspace(db, { cwd: row.project });
        db.prepare("UPDATE recall_events SET project_id = ? WHERE project_id IS NULL AND project = ?")
          .run(identity.projectId, row.project);
      }
      // Export active and inactive facts. is_active is a revision-bearing state;
      // filtering it here would make deactivation impossible to reconcile.
      // semantic_updated_at carries the meaning clock and lifecycle_updated_at
      // the activation clock (재감사 P1-3 v4): peers judge each axis by its own
      // event time, never by a polluted updated_at. fact_kr and
      // ontology_category_id are derived overlay — they rebuild locally and do
      // not travel (재감사 P1-4 v4).
      const factRows = db.prepare(`
        SELECT f.id, f.fact, f.category, f.scope_type, f.source_exchange_ids,
               f.created_at, f.updated_at, f.consolidated_count, f.is_active,
               f.semantic_updated_at, f.lifecycle_updated_at, f.project_id,
               p.portable_project_key, f.subject_key, f.promotion_state
        FROM facts f LEFT JOIN projects p ON p.project_id = f.project_id
        WHERE f.scope_type = 'global'
           OR f.promotion_state IN ('legacy-project','decision','project-current')
        ORDER BY f.id
      `).all() as Array<Record<string, unknown>>;
      const facts = factRows.map((row) => ({
        ...row,
        // Device paths never leave the device. Stable logical identity is the
        // protocol-v4 Phase 3 scope; an old peer rejects these rows visibly
        // instead of silently merging them by a foreign path.
        scope_project: null,
      }));

      const revisions = db.prepare(`
        SELECT r.id, r.fact_id, r.previous_fact, r.new_fact, r.reason,
               r.source_exchange_id, r.created_at
        FROM fact_revisions r JOIN facts f ON f.id = r.fact_id
        WHERE f.scope_type = 'global'
           OR f.promotion_state IN ('legacy-project','decision','project-current')
        ORDER BY r.id
      `).all() as Array<Record<string, unknown>>;

      const tombstones = db.prepare(`
        SELECT fact_id, deleted_at, reason FROM fact_tombstones ORDER BY fact_id
      `).all() as Array<Record<string, unknown>>;

      // recall_events cannot be reconstructed from source rollouts. Export the
      // durable receipt so recalled context stays non-learnable after migration.
      const recallEvents = db.prepare(`
        SELECT r.id, r.session_id, NULL AS project, r.project_id,
               p.portable_project_key, r.prompt_hash, r.fact_ids, r.source_type,
               r.learnable, r.status, r.context_epoch, r.project_memory_revision,
               r.created_at, r.emitted_at
        FROM recall_events r LEFT JOIN projects p ON p.project_id = r.project_id
        ORDER BY r.id
      `).all() as Array<Record<string, unknown>>;

      return { facts, revisions, tombstones, recallEvents };
    });
    const { facts, revisions, tombstones, recallEvents } = readTx();

    const generationId = randomUUID();
    const jsonl = (rows: unknown[]): string =>
      rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
    const payloadFiles: Record<string, string> = {
      'facts.jsonl': jsonl(facts),
      'fact-revisions.jsonl': jsonl(revisions),
      'fact-tombstones.jsonl': jsonl(tombstones),
      'recall-events.jsonl': jsonl(recallEvents),
    };
    // Integrity manifest (재감사 P1-4 보강): every payload file is pinned by
    // row count and SHA-256, so an importer can fail closed on a partially
    // synced or corrupted generation instead of silently reading a prefix.
    const meta = {
      protocol_version: 4,
      identity_contract: 'stable-project-v1',
      generation: generationId,
      device_id: device.value,
      exported_at: new Date().toISOString(),
      hostname: os.hostname(),
      facts_count: facts.length,
      revisions_count: revisions.length,
      tombstones_count: tombstones.length,
      recall_events_count: recallEvents.length,
      files: Object.fromEntries(
        SYNC_PAYLOAD_FILE_NAMES.map((name) => [
          name,
          { rows: countPayloadRows(payloadFiles[name]), sha256: payloadSha256(payloadFiles[name]) },
        ]),
      ),
    };
    const files: Record<string, string> = {
      ...payloadFiles,
      'meta.json': JSON.stringify(meta, null, 2),
    };

    const generationsDir = path.join(deviceDir, GENERATIONS_DIR_NAME);
    fs.mkdirSync(generationsDir, { recursive: true });
    const genPath = path.join(generationsDir, generationId);
    const tmpPath = `${genPath}.tmp`;
    fs.rmSync(tmpPath, { recursive: true, force: true }); // leftover from a crash
    fs.mkdirSync(tmpPath, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(tmpPath, name), body);
    }
    fs.renameSync(tmpPath, genPath);

    // The manifest flip is the commit point: before it, readers resolve the
    // previous generation; after it, this complete one.
    writeAtomic(
      path.join(deviceDir, CURRENT_MANIFEST),
      JSON.stringify({ generation: generationId, exported_at: meta.exported_at }, null, 2),
    );

    pruneGenerations(generationsDir, generationId);

    return {
      facts: facts.length,
      revisions: revisions.length,
      tombstones: tombstones.length,
      recallEvents: recallEvents.length,
    };
  };

  try {
    return withExportTransaction(db, performExport);
  } finally {
    db.close();
  }
}
