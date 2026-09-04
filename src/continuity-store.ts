import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { canonicalizeProjectPath } from "./project-identity.js";
import { inspectWorkspaceLocation } from "./continuity-identity.js";

export const CONTINUITY_SCHEMA_VERSION = 6;
export const FACT_EXTRACTION_POLICY_VERSION = "continuity-fact-v1";

export type ClosureState = "open" | "interrupted" | "closed" | "final";
export type MemoryJobState =
  | "pending"
  | "running"
  | "retry"
  | "completed"
  | "superseded"
  | "dead";

export type ContinuityMigrationStage =
  | "exchange-seq-column"
  | "content-hash-column"
  | "content-generation-column"
  | "closure-state-column"
  | "parser-version-column"
  | "continuity-tables"
  | "continuity-core-tables"
  | "journal-source-mtime-column"
  | "journal-source-guard-columns"
  | "identity-tables"
  | "identity-columns"
  | "identity-backfill"
  | "identity-triggers"
  | "continuity-indexes"
  | "continuity-core-indexes"
  | "chronicle-table"
  | "chronicle-backfill"
  | "incident-tables"
  | "telemetry-table"
  | "chronicle-indexes"
  | "recall-gate-columns"
  | "fts-rebuild"
  | "exchange-metadata"
  | "schema-meta"
  | "user-version";

export type ExtractionCommitStage =
  | "target-items"
  | "generation-state"
  | "target-cursor"
  | "compatibility-watermark"
  | "checkpoint"
  | "job";

class ContinuityCasRejected extends Error {}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseStoredJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export function exchangeContentHash(exchange: {
  userMessage: string;
  assistantMessage: string;
  lineEnd: number;
  toolCalls?: Array<{
    id: string;
    toolName: string;
    toolInput?: unknown;
    toolResult?: string;
    isError: boolean;
  }>;
}): string {
  const tools = (exchange.toolCalls ?? [])
    .map((tool) => ({
      id: tool.id,
      name: tool.toolName,
      input: tool.toolInput ?? null,
      result: tool.toolResult ?? null,
      error: tool.isError,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return sha256(
    JSON.stringify({
      user: exchange.userMessage,
      assistant: exchange.assistantMessage,
      lineEnd: exchange.lineEnd,
      tools,
    }),
  );
}

function columnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) !== undefined;
}

/**
 * Additive, idempotent Continuity v1 schema migration. Existing exchange rowids
 * and every fact/provenance row remain in place. The version is written only
 * after all DDL and deterministic exchange backfill finish successfully.
 */
export function ensureContinuitySchema(
  db: Database.Database,
  options: {
    afterStructuralDdl?: () => void;
    afterMigrationStage?: (stage: ContinuityMigrationStage) => void;
  } = {},
): void {
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
      db.exec(
        "ALTER TABLE exchanges ADD COLUMN content_generation INTEGER NOT NULL DEFAULT 0",
      );
      options.afterMigrationStage?.("content-generation-column");
    }
    if (!columns.has("closure_state")) {
      db.exec(
        "ALTER TABLE exchanges ADD COLUMN closure_state TEXT NOT NULL DEFAULT 'closed' " +
          "CHECK(closure_state IN ('open','interrupted','closed','final'))",
      );
      options.afterMigrationStage?.("closure-state-column");
    }
    if (!columns.has("parser_version")) {
      db.exec(
        "ALTER TABLE exchanges ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 1",
      );
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

      CREATE TABLE IF NOT EXISTS journal_streams (
        session_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        source_path TEXT NOT NULL,
        source_realpath TEXT NOT NULL,
        source_dev TEXT NOT NULL,
        source_ino TEXT NOT NULL,
        source_mtime_ms REAL NOT NULL DEFAULT 0,
        source_guard_start INTEGER NOT NULL DEFAULT 0,
        source_guard_hash TEXT NOT NULL DEFAULT '',
        copied_byte_end INTEGER NOT NULL DEFAULT 0,
        copied_line_end INTEGER NOT NULL DEFAULT 0,
        journal_byte_end INTEGER NOT NULL DEFAULT 0,
        journal_path TEXT NOT NULL,
        prefix_hash TEXT NOT NULL DEFAULT '',
        parser_version INTEGER NOT NULL DEFAULT 1,
        state TEXT NOT NULL DEFAULT 'active'
          CHECK(state IN ('active','replaced','gap','purged')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, stream_epoch)
      );

      CREATE TABLE IF NOT EXISTS journal_blocks (
        block_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        stream_epoch INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        source_from_byte INTEGER NOT NULL,
        source_through_byte INTEGER NOT NULL,
        journal_from_byte INTEGER NOT NULL,
        journal_through_byte INTEGER NOT NULL,
        from_line INTEGER NOT NULL,
        through_line INTEGER NOT NULL,
        segment_hash TEXT NOT NULL,
        prefix_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id, stream_epoch)
          REFERENCES journal_streams(session_id, stream_epoch) ON DELETE CASCADE,
        UNIQUE(session_id, stream_epoch, ordinal),
        UNIQUE(session_id, stream_epoch, source_through_byte, prefix_hash)
      );

      CREATE TABLE IF NOT EXISTS capture_gaps (
        gap_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        stream_epoch INTEGER,
        source_path TEXT,
        event_kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open'
          CHECK(state IN ('open','recovered','purged')),
        created_at TEXT NOT NULL,
        recovered_at TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_exclusions (
        session_id TEXT PRIMARY KEY,
        source_path TEXT,
        reason TEXT NOT NULL,
        excluded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS minimal_workstreams (
        workstream_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        branch_hint TEXT,
        binding_reason TEXT NOT NULL DEFAULT 'session-local',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_memory_state (
        session_id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        workstream_id TEXT NOT NULL REFERENCES minimal_workstreams(workstream_id) ON DELETE CASCADE,
        context_epoch INTEGER NOT NULL DEFAULT 0,
        epoch_token TEXT NOT NULL DEFAULT '',
        resident_fact_revisions_json TEXT NOT NULL DEFAULT '[]',
        carry_fact_revisions_json TEXT NOT NULL DEFAULT '[]',
        capsule_generation_seen INTEGER NOT NULL DEFAULT 0,
        memory_revision_seen INTEGER NOT NULL DEFAULT 0,
        latest_checkpoint_id TEXT,
        last_source TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_capsules (
        workstream_id TEXT PRIMARY KEY REFERENCES minimal_workstreams(workstream_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL DEFAULT 0,
        objective TEXT NOT NULL DEFAULT '',
        current_state TEXT NOT NULL DEFAULT '',
        verified_progress_json TEXT NOT NULL DEFAULT '[]',
        hypotheses_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        open_questions_json TEXT NOT NULL DEFAULT '[]',
        next_actions_json TEXT NOT NULL DEFAULT '[]',
        touched_areas_json TEXT NOT NULL DEFAULT '[]',
        carry_fact_revisions_json TEXT NOT NULL DEFAULT '[]',
        source_exchange_ids_json TEXT NOT NULL DEFAULT '[]',
        through_checkpoint_id TEXT,
        authority TEXT NOT NULL DEFAULT 'context-only'
          CHECK(authority = 'context-only'),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS capsule_checkpoint_state (
        checkpoint_id TEXT PRIMARY KEY REFERENCES checkpoints(checkpoint_id) ON DELETE CASCADE,
        workstream_id TEXT NOT NULL REFERENCES minimal_workstreams(workstream_id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','processing','processed','retry','failed-visible')),
        expected_generation INTEGER NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

    `);
    options.afterMigrationStage?.("continuity-tables");
    options.afterMigrationStage?.("continuity-core-tables");

    const journalColumns = columnNames(db, "journal_streams");
    if (!journalColumns.has("source_mtime_ms")) {
      db.exec("ALTER TABLE journal_streams ADD COLUMN source_mtime_ms REAL NOT NULL DEFAULT 0");
      options.afterMigrationStage?.("journal-source-mtime-column");
    }
    const guardedJournalColumns = columnNames(db, "journal_streams");
    if (!guardedJournalColumns.has("source_guard_start")) {
      db.exec("ALTER TABLE journal_streams ADD COLUMN source_guard_start INTEGER NOT NULL DEFAULT 0");
      options.afterMigrationStage?.("journal-source-guard-columns");
    }
    if (!guardedJournalColumns.has("source_guard_hash")) {
      db.exec("ALTER TABLE journal_streams ADD COLUMN source_guard_hash TEXT NOT NULL DEFAULT ''");
      options.afterMigrationStage?.("journal-source-guard-columns");
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        portable_project_key TEXT UNIQUE,
        display_name TEXT NOT NULL,
        memory_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE RESTRICT,
        device_id TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        git_common_dir TEXT,
        git_common_identity TEXT,
        git_dir_identity TEXT,
        remote_fingerprint TEXT,
        location_kind TEXT NOT NULL DEFAULT 'directory'
          CHECK(location_kind IN ('worktree','clone','directory')),
        branch TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(device_id, canonical_path)
      );

      CREATE TABLE IF NOT EXISTS approved_remote_mappings (
        remote_fingerprint TEXT NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        approved_at TEXT NOT NULL,
        approved_by TEXT NOT NULL DEFAULT 'user',
        PRIMARY KEY(remote_fingerprint, project_id)
      );

      CREATE TABLE IF NOT EXISTS project_identity_audit (
        audit_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK(action IN ('resolve','suggest','link','split','rebind')),
        project_id TEXT,
        workspace_id TEXT,
        workstream_id TEXT,
        session_id TEXT,
        reason TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workstream_sessions (
        session_id TEXT PRIMARY KEY,
        workstream_id TEXT NOT NULL REFERENCES minimal_workstreams(workstream_id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        binding_reason TEXT NOT NULL,
        binding_confidence REAL NOT NULL DEFAULT 1.0,
        bound_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hot_evidence (
        evidence_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
        workspace_id TEXT REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
        workstream_id TEXT,
        session_id TEXT NOT NULL,
        exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
        evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('human','trusted_tool')),
        source_type TEXT NOT NULL,
        evidence_text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        authority TEXT NOT NULL DEFAULT 'hot-evidence'
          CHECK(authority = 'hot-evidence'),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        UNIQUE(exchange_id, evidence_kind, source_type, content_hash)
      );
    `);
    options.afterMigrationStage?.("identity-tables");

    const identityColumns: Array<[string, string, string]> = [
      ["exchanges", "project_id", "TEXT"],
      ["exchanges", "workspace_id", "TEXT"],
      ["exchanges", "workstream_id", "TEXT"],
      ["facts", "project_id", "TEXT"],
      ["facts", "workspace_id", "TEXT"],
      ["facts", "workstream_id", "TEXT"],
      ["facts", "subject_key", "TEXT"],
      ["facts", "promotion_state", "TEXT NOT NULL DEFAULT 'legacy-project'"],
      ["recall_events", "project_id", "TEXT"],
      ["recall_events", "workspace_id", "TEXT"],
      ["recall_events", "workstream_id", "TEXT"],
      ["recall_events", "context_epoch", "INTEGER NOT NULL DEFAULT 0"],
      ["recall_events", "project_memory_revision", "INTEGER NOT NULL DEFAULT 0"],
      ["minimal_workstreams", "project_id", "TEXT"],
      ["minimal_workstreams", "workspace_id", "TEXT"],
      ["minimal_workstreams", "status", "TEXT NOT NULL DEFAULT 'active'"],
      ["minimal_workstreams", "topic_fingerprint", "TEXT"],
      ["session_memory_state", "project_id", "TEXT"],
      ["session_memory_state", "workspace_id", "TEXT"],
      ["session_memory_state", "binding_reason", "TEXT NOT NULL DEFAULT 'session-local'"],
      ["session_memory_state", "binding_confidence", "REAL NOT NULL DEFAULT 1.0"],
      ["work_capsules", "source_workspace_id", "TEXT"],
      ["work_capsules", "source_session_id", "TEXT"],
      ["workspaces", "git_common_identity", "TEXT"],
      ["workspaces", "git_dir_identity", "TEXT"],
    ];
    for (const [table, column, definition] of identityColumns) {
      if (!tableExists(db, table)) continue;
      if (!columnNames(db, table).has(column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
    options.afterMigrationStage?.("identity-columns");

    db.exec(`CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    let device = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as
      | { value: string }
      | undefined;
    if (!device) {
      device = { value: randomUUID() };
      db.prepare("INSERT INTO sync_meta(key, value) VALUES ('device_id', ?)").run(device.value);
    }
    const pathSources: string[] = [];
    if (tableExists(db, "exchanges")) pathSources.push("SELECT project AS value FROM exchanges");
    if (columnNames(db, "facts").has("scope_project") && columnNames(db, "facts").has("scope_type")) {
      pathSources.push("SELECT scope_project AS value FROM facts WHERE scope_type = 'project' AND scope_project IS NOT NULL");
    }
    if (columnNames(db, "recall_events").has("project")) pathSources.push("SELECT project AS value FROM recall_events");
    if (columnNames(db, "minimal_workstreams").has("project")) pathSources.push("SELECT project AS value FROM minimal_workstreams");
    if (columnNames(db, "session_memory_state").has("project")) pathSources.push("SELECT project AS value FROM session_memory_state");
    const pathRows = pathSources.length > 0
      ? db.prepare(pathSources.join(" UNION ")).all() as Array<{ value: string | null }>
      : [];
    const nowIdentity = new Date().toISOString();
    const identityByPath = new Map<string, { canonical: string; projectId: string; workspaceId: string }>();
    const commonProjectByDir = new Map<string, string>();
    for (const row of pathRows) {
      const raw = row.value ?? "";
      const canonical = canonicalizeProjectPath(raw);
      if (!canonical || canonical === "unknown") continue;
      const existingWorkspace = db.prepare(`
        SELECT workspace_id, project_id FROM workspaces
        WHERE device_id = ? AND canonical_path = ?
      `).get(device.value, canonical) as { workspace_id: string; project_id: string } | undefined;
      const inspected = inspectWorkspaceLocation(canonical);
      const linkedByCommonDir = inspected.gitCommonDir
        ? commonProjectByDir.get(inspected.gitCommonDir) ?? (
            db.prepare(`
              SELECT project_id FROM workspaces
              WHERE device_id = ? AND git_common_dir = ?
              ORDER BY created_at, workspace_id LIMIT 1
            `).get(device.value, inspected.gitCommonDir) as { project_id: string } | undefined
          )?.project_id
        : undefined;
      const projectId = linkedByCommonDir ?? existingWorkspace?.project_id ??
        `project-${sha256(`path-project-v1\0${canonical}`).slice(0, 32)}`;
      const workspaceId = existingWorkspace?.workspace_id ??
        `workspace-${sha256(`workspace-v1\0${device.value}\0${canonical}`).slice(0, 32)}`;
      db.prepare(`
        INSERT OR IGNORE INTO projects
          (project_id, display_name, memory_revision, created_at, updated_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(projectId, path.basename(canonical) || "unknown", nowIdentity, nowIdentity);
      db.prepare(`
        INSERT OR IGNORE INTO workspaces
          (workspace_id, project_id, device_id, canonical_path, git_common_dir,
           git_common_identity, git_dir_identity, remote_fingerprint,
           location_kind, branch, last_seen_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        workspaceId, projectId, device.value, canonical, inspected.gitCommonDir,
        inspected.gitCommonIdentity, inspected.gitDirIdentity,
        inspected.remoteFingerprint, inspected.locationKind, inspected.branch,
        nowIdentity, nowIdentity,
      );
      if (existingWorkspace && existingWorkspace.project_id !== projectId && inspected.gitCommonDir) {
        db.prepare(`
          UPDATE workspaces SET project_id = ?, git_common_dir = ?, remote_fingerprint = ?,
            git_common_identity = ?, git_dir_identity = ?, location_kind = ?,
            branch = COALESCE(?, branch), last_seen_at = ?
          WHERE workspace_id = ?
        `).run(
          projectId, inspected.gitCommonDir, inspected.remoteFingerprint,
          inspected.gitCommonIdentity, inspected.gitDirIdentity, inspected.locationKind,
          inspected.branch, nowIdentity, existingWorkspace.workspace_id,
        );
      }
      if (inspected.gitCommonDir) commonProjectByDir.set(inspected.gitCommonDir, projectId);
      identityByPath.set(raw, { canonical, projectId, workspaceId });
    }
    const updateIdentity = (table: string, pathColumn: string): void => {
      const columns = columnNames(db, table);
      if (!columns.has(pathColumn) || !columns.has("project_id") || !columns.has("workspace_id")) return;
      const update = db.prepare(`UPDATE ${table} SET project_id = ?, workspace_id = ? WHERE ${pathColumn} = ?`);
      for (const [raw, identity] of identityByPath) {
        update.run(identity.projectId, identity.workspaceId, raw);
      }
    };
    updateIdentity("exchanges", "project");
    updateIdentity("recall_events", "project");
    updateIdentity("minimal_workstreams", "project");
    updateIdentity("session_memory_state", "project");
    const factColumnsForIdentity = columnNames(db, "facts");
    if (factColumnsForIdentity.has("scope_project") && factColumnsForIdentity.has("scope_type") && factColumnsForIdentity.has("subject_key")) {
      const updateFacts = db.prepare(`
        UPDATE facts SET project_id = ?, subject_key = COALESCE(subject_key, 'legacy.fact.' || id)
        WHERE scope_type = 'project' AND scope_project = ?
      `);
      for (const [raw, identity] of identityByPath) updateFacts.run(identity.projectId, raw);
      db.prepare("UPDATE facts SET subject_key = COALESCE(subject_key, 'global.fact.' || id) WHERE scope_type = 'global'").run();
    }
    if (tableExists(db, "minimal_workstreams")) {
      db.prepare(`
        UPDATE workstream_sessions
        SET workspace_id = (SELECT workspace_id FROM minimal_workstreams w WHERE w.workstream_id = workstream_sessions.workstream_id)
        WHERE workspace_id IS NULL
      `).run();
    }
    if (tableExists(db, "session_memory_state")) {
      db.prepare(`
        INSERT OR IGNORE INTO workstream_sessions
          (session_id, workstream_id, workspace_id, binding_reason, binding_confidence, bound_at)
        SELECT s.session_id, s.workstream_id, s.workspace_id,
               COALESCE(s.binding_reason, 'session-local'), COALESCE(s.binding_confidence, 1.0), s.created_at
        FROM session_memory_state s
      `).run();
      if (tableExists(db, "checkpoints")) {
        db.prepare(`
          UPDATE checkpoints
          SET workspace_id = (SELECT workspace_id FROM session_memory_state s WHERE s.session_id = checkpoints.session_id)
          WHERE workspace_id IS NULL
        `).run();
      }
    }
    options.afterMigrationStage?.("identity-backfill");

    const factColumnsForTriggers = columnNames(db, "facts");
    if (["scope_type", "project_id", "fact", "semantic_generation", "lifecycle_generation", "is_active", "updated_at", "promotion_state", "subject_key", "workspace_id", "workstream_id"].every((name) => factColumnsForTriggers.has(name))) db.exec(`
      DROP TRIGGER IF EXISTS facts_project_revision_insert;
      DROP TRIGGER IF EXISTS facts_project_revision_semantic;
      DROP TRIGGER IF EXISTS facts_project_revision_move_old;
      DROP TRIGGER IF EXISTS facts_project_revision_delete;
      CREATE TRIGGER facts_project_revision_insert
      AFTER INSERT ON facts
      WHEN NEW.scope_type = 'project' AND NEW.project_id IS NOT NULL
        AND NEW.promotion_state IN ('legacy-project','decision','project-current','workspace')
      BEGIN
        UPDATE projects SET memory_revision = memory_revision + 1, updated_at = NEW.updated_at
        WHERE project_id = NEW.project_id;
      END;
      CREATE TRIGGER facts_project_revision_semantic
      AFTER UPDATE OF fact, semantic_generation, lifecycle_generation, is_active, project_id,
        promotion_state, subject_key, workspace_id, workstream_id ON facts
      WHEN COALESCE(NEW.project_id, '') <> ''
        AND (NEW.promotion_state IN ('legacy-project','decision','project-current','workspace')
          OR OLD.promotion_state IN ('legacy-project','decision','project-current','workspace'))
        AND (
        OLD.fact IS NOT NEW.fact OR OLD.semantic_generation IS NOT NEW.semantic_generation OR
        OLD.lifecycle_generation IS NOT NEW.lifecycle_generation OR OLD.is_active IS NOT NEW.is_active OR
        OLD.project_id IS NOT NEW.project_id OR OLD.promotion_state IS NOT NEW.promotion_state OR
        OLD.subject_key IS NOT NEW.subject_key OR OLD.workspace_id IS NOT NEW.workspace_id OR
        OLD.workstream_id IS NOT NEW.workstream_id
      )
      BEGIN
        UPDATE projects SET memory_revision = memory_revision + 1, updated_at = NEW.updated_at
        WHERE project_id = NEW.project_id;
      END;
      CREATE TRIGGER facts_project_revision_move_old
      AFTER UPDATE OF project_id ON facts
      WHEN OLD.project_id IS NOT NULL AND OLD.project_id IS NOT NEW.project_id
      BEGIN
        UPDATE projects SET memory_revision = memory_revision + 1, updated_at = NEW.updated_at
        WHERE project_id = OLD.project_id;
      END;
      CREATE TRIGGER facts_project_revision_delete
      AFTER DELETE ON facts
      WHEN OLD.scope_type = 'project' AND OLD.project_id IS NOT NULL
        AND OLD.promotion_state IN ('legacy-project','decision','project-current','workspace')
      BEGIN
        UPDATE projects SET memory_revision = memory_revision + 1, updated_at = datetime('now')
        WHERE project_id = OLD.project_id;
      END;
    `);
    options.afterMigrationStage?.("identity-triggers");

    if (tableExists(db, "ontology_relations") && factColumnsForTriggers.has("project_id")) {
      db.exec(`
        DROP TRIGGER IF EXISTS ontology_relations_scope_insert_guard;
        DROP TRIGGER IF EXISTS ontology_relations_scope_update_guard;
        CREATE TRIGGER ontology_relations_scope_insert_guard
        BEFORE INSERT ON ontology_relations
        WHEN EXISTS (
          SELECT 1 FROM facts AS source JOIN facts AS target
            ON source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id
          WHERE source.scope_type = 'project' AND target.scope_type = 'project'
            AND COALESCE(source.project_id, 'path:' || source.scope_project)
                IS NOT COALESCE(target.project_id, 'path:' || target.scope_project)
        )
        BEGIN
          SELECT RAISE(ABORT, 'cross-project ontology relation is not allowed');
        END;
        CREATE TRIGGER ontology_relations_scope_update_guard
        BEFORE UPDATE OF source_fact_id, target_fact_id ON ontology_relations
        WHEN EXISTS (
          SELECT 1 FROM facts AS source JOIN facts AS target
            ON source.id = NEW.source_fact_id AND target.id = NEW.target_fact_id
          WHERE source.scope_type = 'project' AND target.scope_type = 'project'
            AND COALESCE(source.project_id, 'path:' || source.scope_project)
                IS NOT COALESCE(target.project_id, 'path:' || target.scope_project)
        )
        BEGIN
          SELECT RAISE(ABORT, 'cross-project ontology relation is not allowed');
        END;
      `);
    }

    ensureChronicleSchema(db, options);

    // Phase 5 recall gate state (RFC §12.2): additive session columns.
    const gateColumns: Array<[string, string]> = [
      ["topic_fingerprint_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["topic_embedding", "BLOB"],
      ["informative_prompts_since_retrieval", "INTEGER NOT NULL DEFAULT 0"],
      ["last_retrieval_epoch", "INTEGER NOT NULL DEFAULT -1"],
      ["last_retrieval_at", "TEXT"],
      ["resident_bundle_hash", "TEXT NOT NULL DEFAULT ''"],
      ["watch_emitted_json", "TEXT NOT NULL DEFAULT '[]'"],
    ];
    const sessionColumns = columnNames(db, "session_memory_state");
    for (const [name, type] of gateColumns) {
      if (!sessionColumns.has(name)) db.exec(`ALTER TABLE session_memory_state ADD COLUMN ${name} ${type}`);
    }
    options.afterMigrationStage?.("recall-gate-columns");

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
      CREATE INDEX IF NOT EXISTS idx_journal_streams_source
        ON journal_streams(source_realpath, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_journal_blocks_range
        ON journal_blocks(session_id, stream_epoch, source_through_byte);
      CREATE INDEX IF NOT EXISTS idx_capture_gaps_state
        ON capture_gaps(state, session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_session_memory_workstream
        ON session_memory_state(workstream_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_capsule_checkpoint_state
        ON capsule_checkpoint_state(workstream_id, state, updated_at);
      CREATE INDEX IF NOT EXISTS idx_workspaces_project
        ON workspaces(project_id, device_id, canonical_path);
      CREATE INDEX IF NOT EXISTS idx_workspaces_common_dir
        ON workspaces(device_id, git_common_dir) WHERE git_common_dir IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_workspaces_git_identity
        ON workspaces(device_id, git_common_identity, git_dir_identity);
      CREATE INDEX IF NOT EXISTS idx_workstreams_scope
        ON minimal_workstreams(project_id, workspace_id, status, branch_hint);
      CREATE INDEX IF NOT EXISTS idx_hot_evidence_scope
        ON hot_evidence(project_id, workstream_id, expires_at, created_at);
    `);
    if (["project_id", "subject_key", "is_active", "promotion_state", "workspace_id", "workstream_id"].every((name) => factColumnsForTriggers.has(name))) db.exec(`
      CREATE INDEX IF NOT EXISTS idx_facts_project_subject
        ON facts(project_id, subject_key, is_active);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_facts_active_subject_slot
        ON facts(
          project_id,
          subject_key,
          promotion_state,
          COALESCE(workspace_id, ''),
          COALESCE(workstream_id, '')
        )
        WHERE is_active = 1 AND project_id IS NOT NULL AND subject_key IS NOT NULL;
    `);
    options.afterMigrationStage?.("continuity-indexes");
    options.afterMigrationStage?.("continuity-core-indexes");

    options.afterStructuralDdl?.();

    const priorVersion = Number(
      (db.prepare(
        "SELECT value FROM continuity_schema_meta WHERE key = 'schema_version'",
      ).get() as { value?: string } | undefined)?.value ?? 0,
    );
    const ftsExists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'exchanges_fts'",
    ).get();
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

export const CHRONICLE_EVENT_KINDS = [
  "ASSERTED",
  "CHANGED",
  "RETIRED",
  "RESTORED",
  "VALIDATED",
  "INCIDENT",
  "CONTRADICTED",
] as const;

const CHRONICLE_COLUMNS: Array<[string, string]> = [
  ["project_id", "TEXT"],
  ["subject_key", "TEXT"],
  ["event_kind", "TEXT NOT NULL DEFAULT 'CHANGED'"],
  ["from_semantic_generation", "INTEGER"],
  ["to_semantic_generation", "INTEGER"],
  ["lifecycle_generation", "INTEGER"],
  ["problem", "TEXT"],
  ["grounded_cause", "TEXT"],
  ["rationale", "TEXT"],
  ["classifier_note", "TEXT"],
  ["outcome_json", "TEXT"],
  ["source_exchange_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ["source_evidence_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ["reverts_event_id", "TEXT"],
  ["related_event_ids", "TEXT NOT NULL DEFAULT '[]'"],
  ["actor", "TEXT NOT NULL DEFAULT 'legacy'"],
  ["policy_version", "TEXT NOT NULL DEFAULT 'legacy-revision-v0'"],
  ["evidence_authority", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["effective_at", "TEXT NOT NULL DEFAULT ''"],
  ["effective_at_source", "TEXT NOT NULL DEFAULT 'recorded'"],
  ["recorded_at", "TEXT NOT NULL DEFAULT ''"],
  ["projection_applied", "INTEGER NOT NULL DEFAULT 1"],
  // Local monotonic append order; the deterministic tie-breaker when two
  // events share effective_at and recorded_at (never a history clock).
  ["chronicle_seq", "INTEGER"],
];

/**
 * Phase 4 Chronicle. The released `fact_revisions` table is the single
 * history table: it is rebuilt in place so `fact_id`/`previous_fact`/`new_fact`
 * become nullable (event-only VALIDATED/INCIDENT rows) and the RFC event shape
 * is added additively. Existing revision rows keep their ids and are
 * backfilled as legacy CHANGED events whose free-text `reason` becomes a
 * classifier note (a consolidator verdict is model inference, never a
 * grounded cause). No parallel history table is created.
 */
function ensureChronicleSchema(
  db: Database.Database,
  options: { afterMigrationStage?: (stage: ContinuityMigrationStage) => void },
): void {
  const BASE_REVISION_COLUMNS: Array<[string, string]> = [
    ["id", "TEXT PRIMARY KEY"],
    // Nullable so event-only rows exist; the reference keeps orphan detection.
    ["fact_id", "TEXT REFERENCES facts(id)"],
    ["previous_fact", "TEXT"],
    ["new_fact", "TEXT"],
    ["reason", "TEXT"],
    ["source_exchange_id", "TEXT"],
    ["created_at", "TEXT NOT NULL DEFAULT ''"],
  ];
  if (!tableExists(db, "fact_revisions")) {
    db.exec(`CREATE TABLE fact_revisions (${BASE_REVISION_COLUMNS.map(([n, t]) => `${n} ${t}`).join(", ")})`);
  }
  const revisionInfo = db.prepare("PRAGMA table_info(fact_revisions)").all() as Array<{
    name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const relaxable = new Set(["fact_id", "previous_fact", "new_fact"]);
  const needsRebuild = revisionInfo.some((column) =>
    relaxable.has(column.name) && column.notnull === 1);
  if (needsRebuild) {
    // SQLite cannot drop NOT NULL in place. Copy every existing column (known
    // ones in the relaxed shape, unknown ones exactly as declared) into a new
    // table, preserving every id and value, then swap names. The surrounding
    // immediate transaction makes the swap atomic and rerunnable.
    const known = new Map(BASE_REVISION_COLUMNS);
    const existingNames = revisionInfo.map((column) => column.name);
    const ddl = revisionInfo.map((column) => {
      if (known.has(column.name)) return `${column.name} ${known.get(column.name)}`;
      const type = column.type || "TEXT";
      const notNull = column.notnull === 1 ? " NOT NULL" : "";
      const dflt = column.dflt_value !== null ? ` DEFAULT ${column.dflt_value}` : "";
      return `${column.name} ${type}${notNull}${dflt}`;
    });
    for (const [name, type] of BASE_REVISION_COLUMNS) {
      if (!existingNames.includes(name)) ddl.push(`${name} ${type}`);
    }
    const copyColumns = existingNames.join(", ");
    db.exec(`
      CREATE TABLE fact_revisions_chronicle (${ddl.join(", ")});
      INSERT INTO fact_revisions_chronicle (${copyColumns})
      SELECT ${copyColumns} FROM fact_revisions;
      DROP TABLE fact_revisions;
      ALTER TABLE fact_revisions_chronicle RENAME TO fact_revisions;
    `);
  }
  for (const [name, type] of BASE_REVISION_COLUMNS) {
    if (!columnNames(db, "fact_revisions").has(name)) {
      db.exec(`ALTER TABLE fact_revisions ADD COLUMN ${name} ${type}`);
    }
  }
  const revisionColumns = columnNames(db, "fact_revisions");
  for (const [name, type] of CHRONICLE_COLUMNS) {
    if (!revisionColumns.has(name)) {
      db.exec(`ALTER TABLE fact_revisions ADD COLUMN ${name} ${type}`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS chronicle_tombstones (
      event_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL,
      reason TEXT
    )
  `);
  options.afterMigrationStage?.("chronicle-table");

  // Deterministic, rerunnable backfill for released revision rows. A row is
  // legacy when recorded_at is still empty. effective_at prefers the cited
  // source exchange timestamp; otherwise it falls back to the recorded time
  // and says so, because the transition time is genuinely unknown.
  const factColumns = columnNames(db, "facts");
  const hasFactIdentity = factColumns.has("project_id") && factColumns.has("subject_key");
  const migrationNow = new Date().toISOString();
  db.prepare("UPDATE fact_revisions SET created_at = ? WHERE created_at = '' OR created_at IS NULL").run(migrationNow);
  db.prepare(`
    UPDATE fact_revisions SET
      event_kind = CASE WHEN event_kind IS NULL OR event_kind = '' THEN 'CHANGED' ELSE event_kind END,
      actor = 'legacy',
      policy_version = 'legacy-revision-v0',
      classifier_note = COALESCE(classifier_note, reason),
      source_exchange_ids = CASE
        WHEN source_exchange_id IS NOT NULL AND source_exchange_id <> '' THEN json_array(source_exchange_id)
        ELSE '[]' END,
      effective_at = COALESCE(
        (SELECT e.timestamp FROM exchanges e WHERE e.id = fact_revisions.source_exchange_id),
        created_at),
      effective_at_source = CASE
        WHEN EXISTS (SELECT 1 FROM exchanges e WHERE e.id = fact_revisions.source_exchange_id) THEN 'source'
        ELSE 'recorded' END,
      recorded_at = created_at,
      projection_applied = 1
    WHERE recorded_at = ''
  `).run();
  db.prepare("UPDATE fact_revisions SET chronicle_seq = rowid WHERE chronicle_seq IS NULL").run();
  if (hasFactIdentity) {
    db.prepare(`
      UPDATE fact_revisions SET
        project_id = COALESCE(project_id, (SELECT f.project_id FROM facts f WHERE f.id = fact_revisions.fact_id)),
        subject_key = COALESCE(subject_key, (SELECT f.subject_key FROM facts f WHERE f.id = fact_revisions.fact_id))
      WHERE fact_id IS NOT NULL AND (project_id IS NULL OR subject_key IS NULL)
    `).run();
  }
  options.afterMigrationStage?.("chronicle-backfill");

  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      workstream_id TEXT,
      session_id TEXT,
      signature_key TEXT NOT NULL,
      signature_text TEXT NOT NULL,
      subject_key TEXT,
      event_id TEXT NOT NULL REFERENCES fact_revisions(id) ON DELETE CASCADE,
      source_exchange_ids TEXT NOT NULL DEFAULT '[]',
      source_evidence_ids TEXT NOT NULL DEFAULT '[]',
      retry_count INTEGER NOT NULL DEFAULT 0,
      evidence_authority TEXT NOT NULL DEFAULT 'trusted-tool',
      effective_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      last_retry_at TEXT,
      state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','remediated')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_signatures (
      project_id TEXT NOT NULL,
      signature_key TEXT NOT NULL,
      signature_text TEXT NOT NULL,
      first_effective_at TEXT NOT NULL,
      last_effective_at TEXT NOT NULL,
      episode_count INTEGER NOT NULL DEFAULT 0,
      user_flagged_repeat INTEGER NOT NULL DEFAULT 0,
      pattern_state TEXT NOT NULL DEFAULT 'candidate'
        CHECK(pattern_state IN ('candidate','pattern','remediated')),
      remediation_event_id TEXT,
      remediation_summary TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(project_id, signature_key)
    );
  `);
  options.afterMigrationStage?.("incident-tables");

  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_telemetry (
      sample_id TEXT PRIMARY KEY,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'count',
      project_id TEXT,
      session_id TEXT,
      dims_json TEXT NOT NULL DEFAULT '{}',
      recorded_at TEXT NOT NULL
    )
  `);
  options.afterMigrationStage?.("telemetry-table");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_revisions_fact ON fact_revisions(fact_id);
    CREATE INDEX IF NOT EXISTS idx_chronicle_subject_time
      ON fact_revisions(project_id, subject_key, effective_at, recorded_at, chronicle_seq);
    CREATE INDEX IF NOT EXISTS idx_chronicle_fact_time
      ON fact_revisions(fact_id, effective_at, recorded_at, chronicle_seq);
    CREATE INDEX IF NOT EXISTS idx_chronicle_kind
      ON fact_revisions(project_id, event_kind, effective_at);
    CREATE INDEX IF NOT EXISTS idx_incident_signature_scope
      ON incident_occurrences(project_id, signature_key, session_id, effective_at);
    CREATE INDEX IF NOT EXISTS idx_incident_event
      ON incident_occurrences(event_id);
    CREATE INDEX IF NOT EXISTS idx_telemetry_metric
      ON continuity_telemetry(metric, project_id, recorded_at);
  `);
  options.afterMigrationStage?.("chronicle-indexes");
}

/** Backfill rows inserted by legacy readers or direct migration fixtures. */
export function refreshExchangeMetadata(
  db: Database.Database,
  sessionId?: string,
): void {
  const rows = db
    .prepare(`
      SELECT rowid, id, session_id, user_message, assistant_message, line_end,
             exchange_seq, content_hash, content_generation
      FROM exchanges
      ${sessionId ? "WHERE session_id = ?" : ""}
      ORDER BY session_id, timestamp, rowid
    `)
    .all(...(sessionId ? [sessionId] : [])) as Array<{
    rowid: number;
    id: string;
    session_id: string | null;
    user_message: string;
    assistant_message: string;
    line_end: number;
    exchange_seq: number;
    content_hash: string;
    content_generation: number;
  }>;
  const nextBySession = new Map<string, number>();
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
    const tools = selectTools.all(row.id) as Array<{
      id: string;
      tool_name: string;
      tool_input: string | null;
      tool_result: string | null;
      is_error: number;
    }>;
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
    update.run(
      row.exchange_seq > 0 ? row.exchange_seq : next,
      hash,
      changed
        ? Math.max(1, row.content_generation) + 1
        : row.content_generation > 0 ? row.content_generation : 1,
      row.id,
    );
  }
}

export interface CheckpointJobInput {
  checkpoint: {
    checkpointId: string;
    sessionId: string;
    ordinal: number;
    kind: "stop" | "interrupt" | "precompact" | "final" | "extraction";
    idempotencyKey: string;
    fromCursor?: number;
    throughCursor?: number;
    parserVersion?: number;
    closureState?: ClosureState;
  };
  job: {
    kind: string;
    partitionKey: string;
    policyVersion: string;
    priority: number;
    idempotencyKey: string;
    targetId?: string;
    maxAttempts?: number;
  };
  now?: string;
  /** Test-only crash seam. A thrown error rolls back both rows. */
  afterCheckpoint?: () => void;
  /** Test-only crash seam after the job write but before transaction commit. */
  afterJob?: () => void;
}

export function createCheckpointWithJob(
  db: Database.Database,
  input: CheckpointJobInput,
): { checkpointId: string; jobId: string; created: boolean } {
  const now = input.now ?? new Date().toISOString();
  const tx = db.transaction(() => {
    const existingCheckpoint = db.prepare(`
      SELECT * FROM checkpoints
      WHERE checkpoint_id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(
      input.checkpoint.checkpointId,
      input.checkpoint.idempotencyKey,
    ) as Record<string, unknown> | undefined;
    if (
      existingCheckpoint &&
      (String(existingCheckpoint.checkpoint_id) !== input.checkpoint.checkpointId ||
        String(existingCheckpoint.session_id) !== input.checkpoint.sessionId ||
        Number(existingCheckpoint.ordinal) !== input.checkpoint.ordinal ||
        String(existingCheckpoint.kind) !== input.checkpoint.kind ||
        nullableNumber(existingCheckpoint.from_cursor) !== (input.checkpoint.fromCursor ?? null) ||
        nullableNumber(existingCheckpoint.through_cursor) !== (input.checkpoint.throughCursor ?? null) ||
        Number(existingCheckpoint.parser_version) !== (input.checkpoint.parserVersion ?? 1) ||
        String(existingCheckpoint.closure_state) !== (input.checkpoint.closureState ?? "closed") ||
        String(existingCheckpoint.idempotency_key) !== input.checkpoint.idempotencyKey)
    ) {
      throw new Error("checkpoint idempotency collision with different semantic target");
    }
    const checkpointResult = db.prepare(`
      INSERT OR IGNORE INTO checkpoints
        (checkpoint_id, session_id, ordinal, kind, from_cursor, through_cursor,
         parser_version, closure_state, state, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      input.checkpoint.checkpointId,
      input.checkpoint.sessionId,
      input.checkpoint.ordinal,
      input.checkpoint.kind,
      input.checkpoint.fromCursor ?? null,
      input.checkpoint.throughCursor ?? null,
      input.checkpoint.parserVersion ?? 1,
      input.checkpoint.closureState ?? "closed",
      input.checkpoint.idempotencyKey,
      now,
    );
    input.afterCheckpoint?.();
    const jobId = sha256(`job\0${input.job.idempotencyKey}`);
    const existingJob = db.prepare(`
      SELECT * FROM memory_jobs
      WHERE job_id = ? OR idempotency_key = ?
      LIMIT 1
    `).get(jobId, input.job.idempotencyKey) as Record<string, unknown> | undefined;
    if (
      existingJob &&
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
        String(existingJob.idempotency_key) !== input.job.idempotencyKey)
    ) {
      throw new Error("job idempotency collision with different semantic target");
    }
    const jobResult = db.prepare(`
      INSERT OR IGNORE INTO memory_jobs
        (job_id, kind, partition_key, checkpoint_id, target_id, from_cursor,
         through_cursor, policy_version, priority, state, available_at,
         max_attempts, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      jobId,
      input.job.kind,
      input.job.partitionKey,
      input.checkpoint.checkpointId,
      input.job.targetId ?? null,
      input.checkpoint.fromCursor ?? null,
      input.checkpoint.throughCursor ?? null,
      input.job.policyVersion,
      input.job.priority,
      now,
      input.job.maxAttempts ?? 5,
      input.job.idempotencyKey,
      now,
      now,
    );
    input.afterJob?.();
    const existing = db
      .prepare("SELECT job_id FROM memory_jobs WHERE idempotency_key = ?")
      .get(input.job.idempotencyKey) as { job_id: string };
    return {
      checkpointId: input.checkpoint.checkpointId,
      jobId: existing.job_id,
      created: checkpointResult.changes === 1 || jobResult.changes === 1,
    };
  });
  return tx.immediate();
}

export interface ClaimedMemoryJob {
  job_id: string;
  kind: string;
  partition_key: string;
  checkpoint_id: string | null;
  target_id: string | null;
  from_cursor: number | null;
  through_cursor: number | null;
  policy_version: string;
  priority: number;
  lease_owner: string;
  lease_until: string;
  lease_generation: number;
  attempts: number;
}

export function claimMemoryJobById(
  db: Database.Database,
  input: { jobId: string; owner: string; now?: Date; leaseMs?: number },
): ClaimedMemoryJob | null {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(now.getTime() + (input.leaseMs ?? 30 * 60_000)).toISOString();
  const tx = db.transaction(() => {
    const row = db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(input.jobId) as
      | (ClaimedMemoryJob & { state: MemoryJobState; available_at: string; max_attempts: number })
      | undefined;
    if (
      !row ||
      row.state === "completed" ||
      row.state === "superseded" ||
      row.state === "dead"
    ) return null;

    const expiredRunning =
      row.state === "running" && (!row.lease_until || row.lease_until <= nowIso);
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
          `).get(row.target_id) as {
            from_ordinal: number | null;
            through_ordinal: number | null;
            from_rowid: number | null;
            through_rowid: number | null;
          }
        : undefined;
      if (row.target_id && remaining?.from_ordinal != null) {
        const fingerprint = sha256(`${row.target_id}\0lease-expired\0${remaining.from_ordinal}\0${remaining.through_ordinal}`);
        const failureId = sha256(
          `${row.target_id}\0${remaining.from_ordinal}\0${remaining.through_ordinal}\0${fingerprint}`,
        );
        db.prepare(`
          INSERT INTO extraction_failed_ranges
            (failure_id, target_id, from_ordinal, through_ordinal, from_rowid,
             through_rowid, payload_fingerprint, error_kind, error_message,
             state, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'lease_expired', ?, 'failed-visible', ?, ?)
          ON CONFLICT(target_id, from_ordinal, through_ordinal, payload_fingerprint)
          DO UPDATE SET attempts = attempts + 1, error_message = excluded.error_message,
                        state = 'failed-visible', updated_at = excluded.updated_at
        `).run(
          failureId,
          row.target_id,
          remaining.from_ordinal,
          remaining.through_ordinal,
          remaining.from_rowid,
          remaining.through_rowid,
          fingerprint,
          error,
          nowIso,
          nowIso,
        );
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
    `).get(row.partition_key) as { job_id: string } | undefined;
    if (firstOutstanding?.job_id !== row.job_id) return null;
    const partitionBusy = db.prepare(`
      SELECT 1 FROM memory_jobs
      WHERE partition_key = ? AND job_id <> ? AND state = 'running'
        AND lease_until > ? LIMIT 1
    `).get(row.partition_key, row.job_id, nowIso);
    if (partitionBusy) return null;
    const reclaimable =
      (row.state === "pending" || row.state === "retry") &&
        row.available_at <= nowIso ||
      (row.state === "running" && (!row.lease_until || row.lease_until <= nowIso));
    if (!reclaimable || row.attempts >= row.max_attempts) return null;
    const generation = row.lease_generation + 1;
    const changed = db.prepare(`
      UPDATE memory_jobs
      SET state = 'running', lease_owner = ?, lease_until = ?,
          lease_generation = ?, attempts = attempts + 1, updated_at = ?
      WHERE job_id = ? AND lease_generation = ? AND state = ?
    `).run(
      input.owner,
      leaseUntil,
      generation,
      nowIso,
      row.job_id,
      row.lease_generation,
      row.state,
    ).changes;
    if (changed !== 1) return null;
    return db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(row.job_id) as ClaimedMemoryJob;
  });
  return tx.immediate();
}

export function renewMemoryJobLease(
  db: Database.Database,
  input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    now?: Date;
    leaseMs?: number;
  },
): boolean {
  const now = input.now ?? new Date();
  const until = new Date(now.getTime() + (input.leaseMs ?? 30 * 60_000)).toISOString();
  return db.prepare(`
    UPDATE memory_jobs SET lease_until = ?, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).run(
    until,
    now.toISOString(),
    input.jobId,
    input.owner,
    input.leaseGeneration,
    now.toISOString(),
  ).changes === 1;
}

export function completeMemoryJob(
  db: Database.Database,
  input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    now?: Date;
  },
): boolean {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  return db.prepare(`
    UPDATE memory_jobs
    SET state = 'completed', lease_owner = NULL, lease_until = NULL, updated_at = ?
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).run(
    nowIso,
    input.jobId,
    input.owner,
    input.leaseGeneration,
    nowIso,
  ).changes === 1;
}

export function failMemoryJob(
  db: Database.Database,
  input: {
    jobId: string;
    owner: string;
    leaseGeneration: number;
    error: string;
    retry: boolean;
    availableAt?: Date;
    now?: Date;
  },
): boolean {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const row = db.prepare(`
    SELECT attempts, max_attempts, checkpoint_id, target_id, kind FROM memory_jobs
    WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_until > ?
  `).get(input.jobId, input.owner, input.leaseGeneration, nowIso) as
    | {
        attempts: number;
        max_attempts: number;
        checkpoint_id: string | null;
        target_id: string | null;
        kind: string;
      }
    | undefined;
  if (!row) return false;
  const retry = input.retry && row.attempts < row.max_attempts;
  const state = retry ? "retry" : "dead";
  const defaultBackoffMs = Math.min(
    60 * 60_000,
    1000 * 2 ** Math.max(0, row.attempts - 1),
  );
  const availableAt = input.availableAt ?? new Date(now.getTime() + defaultBackoffMs);
  const fail = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE memory_jobs
      SET state = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          last_error = ?, updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(
      state,
      availableAt.toISOString(),
      input.error,
      nowIso,
      input.jobId,
      input.owner,
      input.leaseGeneration,
      nowIso,
    ).changes;
    if (changed !== 1) return false;
    // Extraction targets own their richer exact-range checkpoint state. For
    // checkpoint-native Continuity work, keep terminal/retry accountability
    // synchronized with the queue transition itself.
    if (!row.target_id && row.checkpoint_id) {
      db.prepare("UPDATE checkpoints SET state = ? WHERE checkpoint_id = ?")
        .run(retry ? "retry" : "dead-letter", row.checkpoint_id);
      if (!retry && row.kind === "capture_index") {
        db.prepare(`
          UPDATE memory_jobs
          SET state = 'dead', last_error = ?, updated_at = ?
          WHERE checkpoint_id = ? AND kind = 'capsule_update'
            AND state IN ('pending','retry')
        `).run("capture_index dependency is dead-letter", nowIso, row.checkpoint_id);
        db.prepare(`
          UPDATE capsule_checkpoint_state
          SET state = 'failed-visible', last_error = ?, updated_at = ?
          WHERE checkpoint_id = ? AND state IN ('pending','retry')
        `).run("capture_index dependency is dead-letter", nowIso, row.checkpoint_id);
      }
      if (row.kind === "capsule_update") {
        db.prepare(`
          UPDATE capsule_checkpoint_state
          SET state = ?, last_error = ?, updated_at = ?
          WHERE checkpoint_id = ?
        `).run(
          retry ? "retry" : "failed-visible",
          input.error.slice(0, 1_000),
          nowIso,
          row.checkpoint_id,
        );
      }
    }
    return true;
  });
  return db.inTransaction ? fail() : fail.immediate();
}

export interface ExtractionTargetItem {
  ordinal: number;
  exchange_id: string;
  exchange_rowid: number;
  content_generation: number;
  content_hash: string;
}

export interface ExtractionTarget {
  targetId: string;
  jobId: string;
  sessionId: string;
  fromRowid: number;
  throughRowid: number;
  cursorOrdinal: number;
  itemCount: number;
  policyVersion: string;
  state: MemoryJobState;
}

/** Create one immutable target from a claim-time snapshot, never live completion MAX. */
export function ensureExtractionTarget(
  db: Database.Database,
  input: {
    sessionId: string;
    project: string;
    policyVersion?: string;
    now?: string;
  },
): ExtractionTarget | null {
  const ensure = db.transaction((): ExtractionTarget | null => {
    const policy = input.policyVersion ?? FACT_EXTRACTION_POLICY_VERSION;
    refreshExchangeMetadata(db, input.sessionId);
  const active = db.prepare(`
    SELECT t.*, j.job_id
    FROM extraction_targets t
    JOIN memory_jobs j ON j.target_id = t.target_id
    WHERE t.session_id = ? AND t.policy_version = ?
      AND t.state IN ('pending','running','retry')
    ORDER BY t.created_at, t.target_id LIMIT 1
  `).get(input.sessionId, policy) as Record<string, unknown> | undefined;
  if (active) return targetFromRow(active);

  // A legacy session watermark is only a reporting/scheduling hint. Older
  // extractors used sampling and seed/permanent markers, so it cannot prove
  // that every generation below it was presented. Only an exact current
  // exchange_extraction_state='processed' row is completion authority.
  const firstOpen = (db.prepare(`
    SELECT MIN(rowid) AS rowid FROM exchanges
    WHERE session_id = ? AND closure_state IN ('open','interrupted')
  `).get(input.sessionId) as { rowid: number | null }).rowid;

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
  `).all(
    policy,
    input.sessionId,
    firstOpen ?? Number.MAX_SAFE_INTEGER,
  ) as Array<Omit<ExtractionTargetItem, "ordinal">>;
  if (items.length === 0) return null;

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
  `).get(targetId) as Record<string, unknown> | undefined;
  if (identical) return targetFromRow(identical);
  const now = input.now ?? new Date().toISOString();
  const checkpointId = sha256(`checkpoint\0${targetId}`);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO extraction_targets
        (target_id, session_id, project, from_rowid, through_rowid,
         item_count, policy_version, state, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      targetId,
      input.sessionId,
      input.project,
      fromRowid,
      throughRowid,
      items.length,
      policy,
      targetId,
      now,
      now,
    );
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
      insertItem.run(
        targetId,
        index + 1,
        item.exchange_id,
        item.exchange_rowid,
        item.content_generation,
        item.content_hash,
      );
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

function targetFromRow(row: Record<string, unknown>): ExtractionTarget {
  return {
    targetId: String(row.target_id),
    jobId: String(row.job_id),
    sessionId: String(row.session_id),
    fromRowid: Number(row.from_rowid),
    throughRowid: Number(row.through_rowid),
    cursorOrdinal: Number(row.cursor_ordinal),
    itemCount: Number(row.item_count),
    policyVersion: String(row.policy_version),
    state: row.state as MemoryJobState,
  };
}

export function readExtractionTargetItems(
  db: Database.Database,
  targetId: string,
  afterOrdinal: number,
  limit: number,
): ExtractionTargetItem[] {
  return db.prepare(`
    SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
    FROM extraction_target_items
    WHERE target_id = ? AND ordinal > ?
    ORDER BY ordinal LIMIT ?
  `).all(targetId, afterOrdinal, Math.max(1, Math.trunc(limit))) as ExtractionTargetItem[];
}

export function recordExtractionFailure(
  db: Database.Database,
  input: {
    targetId: string;
    items: ExtractionTargetItem[];
    payloadFingerprint: string;
    errorKind: string;
    errorMessage: string;
    retry: boolean;
    owner: string;
    leaseGeneration: number;
    now?: string;
  },
): boolean {
  if (input.items.length === 0) return false;
  const now = input.now ?? new Date().toISOString();
  const first = input.items[0];
  const last = input.items[input.items.length - 1];
  if (
    input.items.some(
      (item, index) => item.ordinal !== first.ordinal + index,
    )
  ) return false;
  const tx = db.transaction(() => {
    const job = db.prepare(`
      SELECT job_id, attempts, max_attempts FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now) as
      | { job_id: string; attempts: number; max_attempts: number }
      | undefined;
    if (!job) return false;
    const targetOwned = db.prepare(`
      SELECT 1 FROM extraction_targets
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
    if (!targetOwned) return false;
    const exact = db.prepare(`
      SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
      FROM extraction_target_items
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(input.targetId, first.ordinal, last.ordinal) as ExtractionTargetItem[];
    if (
      exact.length !== input.items.length ||
      exact.some((item, index) =>
        item.ordinal !== input.items[index].ordinal ||
        item.exchange_id !== input.items[index].exchange_id ||
        item.exchange_rowid !== input.items[index].exchange_rowid ||
        item.content_generation !== input.items[index].content_generation ||
        item.content_hash !== input.items[index].content_hash)
    ) return false;
    const retry = input.retry && job.attempts < job.max_attempts;
    const state = retry ? "retry" : "failed-visible";
    const failureId = sha256(
      `${input.targetId}\0${first.ordinal}\0${last.ordinal}\0${input.payloadFingerprint}`,
    );
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
    `).run(
      failureId,
      input.targetId,
      first.ordinal,
      last.ordinal,
      first.exchange_rowid,
      last.exchange_rowid,
      input.payloadFingerprint,
      input.errorKind,
      input.errorMessage,
      state,
      now,
      now,
    );
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
    `).run(
      retry ? "retry" : "dead",
      input.errorMessage,
      now,
      input.targetId,
      input.owner,
      input.leaseGeneration,
      now,
    ).changes;
    if (targetChanged !== 1) throw new ContinuityCasRejected();
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
    })) throw new ContinuityCasRejected();
    return true;
  });
  try {
    return tx.immediate();
  } catch (error) {
    if (error instanceof ContinuityCasRejected) return false;
    throw error;
  }
}

/**
 * Retire a claim whose immutable exchange generation changed while async work
 * was running. This is not a failed-visible extraction: the captured
 * generation is obsolete, and the current generation must form a new target.
 */
export function supersedeStaleExtractionTarget(
  db: Database.Database,
  input: {
    targetId: string;
    owner: string;
    leaseGeneration: number;
    now?: string;
  },
): boolean {
  const now = input.now ?? new Date().toISOString();
  const supersede = db.transaction(() => {
    const job = db.prepare(`
      SELECT job_id, checkpoint_id FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now) as
      | { job_id: string; checkpoint_id: string }
      | undefined;
    if (!job) return false;
    const targetOwned = db.prepare(`
      SELECT 1 FROM extraction_targets
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(input.targetId, input.owner, input.leaseGeneration, now);
    if (!targetOwned) return false;
    const stale = db.prepare(`
      SELECT 1 FROM extraction_target_items i
      LEFT JOIN exchanges e ON e.id = i.exchange_id
      WHERE i.target_id = ? AND i.state <> 'processed'
        AND (e.id IS NULL OR e.content_generation <> i.content_generation
          OR e.content_hash <> i.content_hash
          OR e.closure_state NOT IN ('closed','final'))
      LIMIT 1
    `).get(input.targetId);
    if (!stale) return false;
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
    `).run(
      now,
      input.targetId,
      input.owner,
      input.leaseGeneration,
      now,
    ).changes;
    if (targetChanges !== 1) throw new ContinuityCasRejected();
    const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'superseded'
      WHERE checkpoint_id = ?
    `).run(job.checkpoint_id).changes;
    if (checkpointChanges !== 1) throw new ContinuityCasRejected();
    const jobChanges = db.prepare(`
      UPDATE memory_jobs
      SET state = 'superseded', lease_owner = NULL, lease_until = NULL,
          last_error = 'exchange generation changed during extraction', updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(
      now,
      job.job_id,
      input.owner,
      input.leaseGeneration,
      now,
    ).changes;
    if (jobChanges !== 1) throw new ContinuityCasRejected();
    return true;
  });
  try {
    return supersede.immediate();
  } catch (error) {
    if (error instanceof ContinuityCasRejected) return false;
    throw error;
  }
}

export function commitExtractionPage(
  db: Database.Database,
  input: {
    target: ExtractionTarget;
    items: ExtractionTargetItem[];
    owner: string;
    leaseGeneration: number;
    extracted: number;
    saved: number;
    now?: string;
    /** Test-only crash seam. Throwing rolls the complete page transaction back. */
    afterWrite?: (stage: ExtractionCommitStage) => void;
  },
): boolean {
  if (input.items.length === 0) return false;
  const first = input.items[0];
  const last = input.items[input.items.length - 1];
  if (
    input.items.some((item, index) => item.ordinal !== first.ordinal + index)
  ) return false;
  const commit = db.transaction(() => {
    const now = input.now ?? new Date().toISOString();
    const target = db.prepare(`
      SELECT session_id, from_rowid, through_rowid, cursor_ordinal, item_count,
             state, lease_owner, lease_until, lease_generation
      FROM extraction_targets WHERE target_id = ?
    `).get(input.target.targetId) as {
      session_id: string;
      from_rowid: number;
      through_rowid: number;
      cursor_ordinal: number;
      item_count: number;
      state: MemoryJobState;
      lease_owner: string | null;
      lease_until: string | null;
      lease_generation: number;
    } | undefined;
    if (
      !target ||
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
      last.ordinal > target.item_count
    ) return false;
    const exact = db.prepare(`
      SELECT ordinal, exchange_id, exchange_rowid, content_generation, content_hash
      FROM extraction_target_items
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ORDER BY ordinal
    `).all(input.target.targetId, first.ordinal, last.ordinal) as ExtractionTargetItem[];
    if (
      exact.length !== input.items.length ||
      exact.some((item, index) =>
        item.ordinal !== input.items[index].ordinal ||
        item.exchange_id !== input.items[index].exchange_id ||
        item.exchange_rowid !== input.items[index].exchange_rowid ||
        item.content_generation !== input.items[index].content_generation ||
        item.content_hash !== input.items[index].content_hash)
    ) return false;
    const current = db.prepare(`
      SELECT COUNT(*) AS n FROM extraction_target_items i
      JOIN exchanges e ON e.id = i.exchange_id
      WHERE i.target_id = ? AND i.ordinal BETWEEN ? AND ?
        AND e.content_generation = i.content_generation
        AND e.content_hash = i.content_hash
        AND e.closure_state IN ('closed','final')
    `).get(input.target.targetId, first.ordinal, last.ordinal) as { n: number };
    if (current.n !== input.items.length) return false;
    const owned = db.prepare(`
      SELECT job_id FROM memory_jobs
      WHERE target_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).get(
      input.target.targetId,
      input.owner,
      input.leaseGeneration,
      now,
    ) as { job_id: string } | undefined;
    if (!owned) return false;

    const itemChanges = db.prepare(`
      UPDATE extraction_target_items SET state = 'processed'
      WHERE target_id = ? AND ordinal BETWEEN ? AND ?
        AND state IN ('pending','processing','retry')
    `).run(input.target.targetId, first.ordinal, last.ordinal).changes;
    if (itemChanges !== input.items.length) throw new ContinuityCasRejected();
    input.afterWrite?.("target-items");
    const generationChanges = db.prepare(`
      UPDATE exchange_extraction_state
      SET state = 'processed', processed_at = ?
      WHERE target_id = ? AND exchange_id IN (
        SELECT exchange_id FROM extraction_target_items
        WHERE target_id = ? AND ordinal BETWEEN ? AND ?
      ) AND state IN ('pending','processing','retry')
    `).run(
      now,
      input.target.targetId,
      input.target.targetId,
      first.ordinal,
      last.ordinal,
    ).changes;
    if (generationChanges !== input.items.length) throw new ContinuityCasRejected();
    input.afterWrite?.("generation-state");
    const completed = last.ordinal === target.item_count;
    const targetChanges = db.prepare(`
      UPDATE extraction_targets
      SET cursor_ordinal = ?, state = ?, lease_owner = NULL, lease_until = NULL,
          updated_at = ?
      WHERE target_id = ? AND cursor_ordinal = ? AND state = 'running'
        AND lease_owner = ? AND lease_generation = ? AND lease_until > ?
    `).run(
      last.ordinal,
      completed ? "completed" : "pending",
      now,
      input.target.targetId,
      input.target.cursorOrdinal,
      input.owner,
      input.leaseGeneration,
      now,
    ).changes;
    if (targetChanges !== 1) throw new ContinuityCasRejected();
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
    `).run(
      target.session_id,
      now,
      input.extracted,
      input.saved,
      contiguousWatermark,
    );
    input.afterWrite?.("compatibility-watermark");
    if (completed) {
      const checkpointChanges = db.prepare(`
        UPDATE checkpoints SET state = 'processed'
        WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)
      `).run(owned.job_id).changes;
      if (checkpointChanges !== 1) throw new ContinuityCasRejected();
      input.afterWrite?.("checkpoint");
      if (!completeMemoryJob(db, {
        jobId: owned.job_id,
        owner: input.owner,
        leaseGeneration: input.leaseGeneration,
        now: new Date(now),
      })) throw new ContinuityCasRejected();
      input.afterWrite?.("job");
      return true;
    }
    const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'pending'
      WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)
    `).run(owned.job_id).changes;
    if (checkpointChanges !== 1) throw new ContinuityCasRejected();
    input.afterWrite?.("checkpoint");
    const jobChanges = db.prepare(`
      UPDATE memory_jobs
      SET state = 'pending', from_cursor = ?, attempts = 0,
          lease_owner = NULL, lease_until = NULL,
          updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ?
        AND lease_generation = ? AND lease_until > ?
    `).run(
      contiguousWatermark,
      now,
      owned.job_id,
      input.owner,
      input.leaseGeneration,
      now,
    ).changes;
    if (jobChanges !== 1) throw new ContinuityCasRejected();
    input.afterWrite?.("job");
    return true;
  });
  try {
    return commit.immediate();
  } catch (error) {
    if (error instanceof ContinuityCasRejected) return false;
    throw error;
  }
}

export function claimExtractionTarget(
  db: Database.Database,
  target: ExtractionTarget,
  owner = randomUUID(),
  now = new Date(),
): { target: ExtractionTarget; owner: string; leaseGeneration: number } | null {
  const claim = db.transaction(() => {
    const job = claimMemoryJobById(db, { jobId: target.jobId, owner, now });
    if (!job) return null;
    const changed = db.prepare(`
      UPDATE extraction_targets
      SET state = 'running', lease_owner = ?, lease_until = ?,
          lease_generation = ?, attempts = attempts + 1, updated_at = ?
      WHERE target_id = ? AND state IN ('pending','retry','running')
        AND (lease_until IS NULL OR lease_until <= ? OR lease_owner = ?)
    `).run(
      owner,
      job.lease_until,
      job.lease_generation,
      now.toISOString(),
      target.targetId,
      now.toISOString(),
      owner,
    ).changes;
    if (changed !== 1) throw new ContinuityCasRejected();
    const checkpointChanges = db.prepare(`
      UPDATE checkpoints SET state = 'processing'
      WHERE checkpoint_id = ?
    `).run(job.checkpoint_id).changes;
    if (checkpointChanges !== 1) throw new ContinuityCasRejected();
    const row = db.prepare(`
      SELECT t.*, j.job_id FROM extraction_targets t
      JOIN memory_jobs j ON j.target_id = t.target_id WHERE t.target_id = ?
    `).get(target.targetId) as Record<string, unknown>;
    return { target: targetFromRow(row), owner, leaseGeneration: job.lease_generation };
  });
  try {
    return claim.immediate();
  } catch (error) {
    if (error instanceof ContinuityCasRejected) return null;
    throw error;
  }
}
