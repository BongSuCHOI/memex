import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { assertMutationPolicy, captureMutationPolicy } from './fact-policy.js';
import {
  canonicalizeProjectPath,
  isUntrustedProjectPath,
  UntrustedProjectPathError,
} from "./project-identity.js";
import { appendSessionEvidence } from "./continuity-evidence.js";

export type WorkspaceLocationKind = "worktree" | "clone" | "directory";

export interface WorkspaceIdentity {
  projectId: string;
  workspaceId: string;
  canonicalPath: string;
  portableProjectKey: string | null;
  memoryRevision: number;
  locationKind: WorkspaceLocationKind;
  branch: string | null;
  /** Repository default branch (origin/HEAD, then init.defaultBranch). */
  defaultBranch: string | null;
  reason: "existing-path" | "explicit" | "git-common-dir" | "approved-remote" | "new-isolated";
}

/**
 * 0.6.0 scope model (#16/#18). A session carries a *branch signal* only when it
 * runs on a non-default branch (or a worktree checked out on one). Default
 * branch and non-git sessions carry none, and their memory belongs to the
 * project-common tier instead of a per-session stream.
 */
export type BranchSignalKind = "none" | "default" | "branch";

export interface BranchSignal {
  kind: BranchSignalKind;
  /** The captured branch name, kept for display even when it is the default. */
  branch: string | null;
  /** Recorded on the fact and in the Chronicle event that places it. */
  tierReason: "no-branch-signal" | "default-branch" | string;
}

/** Fallback default-branch names when the repository states none. */
export const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master"] as const;

export function isDefaultBranchName(
  branch: string | null | undefined,
  defaultBranch: string | null | undefined,
): boolean {
  if (!branch) return true;
  if (defaultBranch) return branch === defaultBranch;
  return (CONVENTIONAL_DEFAULT_BRANCHES as readonly string[]).includes(branch);
}

export function branchSignalFor(input: {
  branch?: string | null;
  defaultBranch?: string | null;
}): BranchSignal {
  const branch = input.branch?.trim() ? input.branch.trim() : null;
  if (!branch) return { kind: "none", branch: null, tierReason: "no-branch-signal" };
  if (isDefaultBranchName(branch, input.defaultBranch ?? null)) {
    return { kind: "default", branch, tierReason: "default-branch" };
  }
  return { kind: "branch", branch, tierReason: `branch:${branch}` };
}

/**
 * Deterministic workstream identity. A branch signal keys on (project, branch)
 * so two worktrees of the same repository on the same branch share one stream
 * (they share the project via the git-common-dir rule but not the workspace
 * row); no branch signal keys on the project alone so every default-branch and
 * non-git session of a project reuses ONE default stream instead of minting a
 * per-session `ws-<hash(project, session)>`.
 */
export function deterministicWorkstreamId(projectId: string, branch: string | null): string {
  return branch
    ? `ws-${hash("workstream-branch-v1", projectId, branch).slice(0, 32)}`
    : `ws-${hash("workstream-project-default-v1", projectId).slice(0, 32)}`;
}

function hash(...parts: Array<string | number | null | undefined>): string {
  const h = createHash("sha256");
  for (const part of parts) h.update(String(part ?? "")).update("\0");
  return h.digest("hex");
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function deviceId(db: Database.Database): string {
  const existing = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get() as
    | { value: string }
    | undefined;
  if (existing) return existing.value;
  const value = randomUUID();
  db.prepare("INSERT INTO sync_meta(key, value) VALUES ('device_id', ?)").run(value);
  return value;
}

function audit(
  db: Database.Database,
  input: {
    action: "resolve" | "suggest" | "link" | "split" | "rebind";
    projectId?: string | null;
    workspaceId?: string | null;
    workstreamId?: string | null;
    sessionId?: string | null;
    reason: string;
    detail?: Record<string, unknown>;
    now?: string;
  },
): void {
  const at = nowIso(input.now);
  const detail = JSON.stringify(input.detail ?? {});
  const auditId = `identity-audit-${hash(input.action, input.projectId, input.workspaceId, input.workstreamId, input.sessionId, input.reason, detail).slice(0, 32)}`;
  db.prepare(`
    INSERT OR IGNORE INTO project_identity_audit
      (audit_id, action, project_id, workspace_id, workstream_id, session_id, reason, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    auditId, input.action, input.projectId ?? null, input.workspaceId ?? null,
    input.workstreamId ?? null, input.sessionId ?? null, input.reason, detail, at,
  );
}

function readGitFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** Repository default branch: `origin/HEAD` first, then `init.defaultBranch`. */
function detectDefaultBranch(commonDir: string, config: string): string | null {
  const originHead = readGitFile(path.join(commonDir, "refs", "remotes", "origin", "HEAD"));
  const symbolic = originHead?.match(/^ref:\s+refs\/remotes\/origin\/(.+)$/)?.[1]?.trim();
  if (symbolic) return symbolic;
  const packed = readGitFile(path.join(commonDir, "packed-refs")) ?? "";
  const packedHead = packed.match(/^\s*ref:\s+refs\/remotes\/origin\/(.+)$/m)?.[1]?.trim();
  if (packedHead) return packedHead;
  const init = config.match(/\[init\][\s\S]*?\n\s*defaultBranch\s*=\s*([^\n]+)/i)?.[1]?.trim();
  return init || null;
}

export function inspectWorkspaceLocation(cwd: string): {
  gitCommonDir: string | null;
  remoteFingerprint: string | null;
  locationKind: WorkspaceLocationKind;
  branch: string | null;
  defaultBranch: string | null;
  gitCommonIdentity: string | null;
  gitDirIdentity: string | null;
} {
  const canonical = canonicalizeProjectPath(cwd);
  const dotGit = path.join(canonical, ".git");
  let gitDir: string | null = null;
  let locationKind: WorkspaceLocationKind = "directory";
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) {
      gitDir = fs.realpathSync(dotGit);
      locationKind = "clone";
    } else if (stat.isFile()) {
      const pointer = readGitFile(dotGit)?.match(/^gitdir:\s*(.+)$/i)?.[1];
      if (pointer) {
        gitDir = fs.realpathSync(path.resolve(canonical, pointer));
        locationKind = "worktree";
      }
    }
  } catch { /* non-git directory or historical path */ }
  if (!gitDir) return { gitCommonDir: null, remoteFingerprint: null, locationKind, branch: null, defaultBranch: null, gitCommonIdentity: null, gitDirIdentity: null };

  const commonPointer = readGitFile(path.join(gitDir, "commondir"));
  let common = gitDir;
  if (commonPointer) {
    try {
      common = fs.realpathSync(path.resolve(gitDir, commonPointer));
    } catch {
      common = path.resolve(gitDir, commonPointer);
    }
  }
  const config = readGitFile(path.join(common, "config")) ?? "";
  const origin = config.match(/\[remote\s+"origin"\][\s\S]*?\n\s*url\s*=\s*([^\n]+)/i)?.[1]?.trim();
  const head = readGitFile(path.join(gitDir, "HEAD"));
  const inodeIdentity = (value: string): string | null => {
    try {
      const stat = fs.statSync(value);
      return `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  };
  return {
    gitCommonDir: canonicalizeProjectPath(common),
    remoteFingerprint: origin ? hash("remote-v1", origin).slice(0, 40) : null,
    locationKind,
    branch: head?.match(/^ref:\s+refs\/heads\/(.+)$/)?.[1] ?? null,
    defaultBranch: detectDefaultBranch(common, config),
    gitCommonIdentity: inodeIdentity(common),
    gitDirIdentity: inodeIdentity(gitDir),
  };
}

function directoryExists(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** Projects other than `projectId` that already claim this git identity/remote. */
function conflictingProjects(
  db: Database.Database,
  device: string,
  projectId: string,
  next: { gitCommonDir: string | null; gitCommonIdentity: string | null; remoteFingerprint: string | null },
): string[] {
  if (!next.gitCommonDir && !next.gitCommonIdentity && !next.remoteFingerprint) return [];
  const rows = db.prepare(`
    SELECT DISTINCT project_id FROM workspaces
    WHERE device_id = ? AND project_id <> ? AND (
      (? IS NOT NULL AND git_common_dir = ?) OR
      (? IS NOT NULL AND git_common_identity = ?) OR
      (? IS NOT NULL AND remote_fingerprint = ?)
    )
  `).all(device, projectId,
    next.gitCommonDir, next.gitCommonDir,
    next.gitCommonIdentity, next.gitCommonIdentity,
    next.remoteFingerprint, next.remoteFingerprint) as Array<{ project_id: string }>;
  const approved = new Set(
    next.remoteFingerprint
      ? (db.prepare("SELECT project_id FROM approved_remote_mappings WHERE remote_fingerprint = ?")
        .all(next.remoteFingerprint) as Array<{ project_id: string }>).map((row) => row.project_id)
      : [],
  );
  return rows.map((row) => row.project_id).filter((id) => !approved.has(id)).sort();
}

/**
 * #21 — `WORKSPACE_LOCATION_CHANGED`. Its id is derived from the transition's
 * shape, not from the clock, so re-running the same session start records the
 * same single event instead of one per session.
 */
export function recordWorkspaceLocationChange(
  db: Database.Database,
  input: {
    workspaceId: string;
    projectId: string;
    from: string;
    to: string;
    gitCommonDir: string | null;
    remoteFingerprint: string | null;
    branch: string | null;
    changedFields: string[];
    conflictProjectIds: string[];
    now?: string;
  },
): string {
  const at = nowIso(input.now);
  const eventId = `wsloc-${hash(
    "workspace-location-v1", input.workspaceId, input.from, input.to,
    input.gitCommonDir, input.remoteFingerprint,
  ).slice(0, 32)}`;
  db.prepare(`
    INSERT OR IGNORE INTO workspace_location_events
      (event_id, workspace_id, project_id, event_kind, from_location_kind, to_location_kind,
       git_common_dir, remote_fingerprint, branch, requires_approval, detail_json, created_at)
    VALUES (?, ?, ?, 'WORKSPACE_LOCATION_CHANGED', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, input.workspaceId, input.projectId, input.from, input.to,
    input.gitCommonDir, input.remoteFingerprint, input.branch,
    input.conflictProjectIds.length > 0 ? 1 : 0,
    JSON.stringify({ changed: input.changedFields, conflict_project_ids: input.conflictProjectIds }),
    at,
  );
  audit(db, {
    action: input.conflictProjectIds.length > 0 ? "suggest" : "resolve",
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    reason: input.conflictProjectIds.length > 0
      ? "workspace location changed into an identity another project already claims"
      : "workspace location changed",
    detail: {
      from: input.from, to: input.to, gitCommonDir: input.gitCommonDir,
      changed: input.changedFields, candidates: input.conflictProjectIds,
    },
    now: at,
  });
  return eventId;
}

function projectRow(db: Database.Database, projectId: string): {
  project_id: string;
  portable_project_key: string | null;
  memory_revision: number;
} | undefined {
  return db.prepare(`
    SELECT project_id, portable_project_key, memory_revision FROM projects WHERE project_id = ?
  `).get(projectId) as ReturnType<typeof projectRow>;
}

export function resolveProjectWorkspace(
  db: Database.Database,
  input: {
    cwd: string;
    projectId?: string | null;
    portableProjectKey?: string | null;
    gitCommonDir?: string | null;
    remoteFingerprint?: string | null;
    locationKind?: WorkspaceLocationKind;
    branch?: string | null;
    now?: string;
  },
): WorkspaceIdentity {
  if (input.projectId && !/^[A-Za-z0-9_-]{8,128}$/.test(input.projectId)) {
    throw new Error("invalid project_id");
  }
  if (input.portableProjectKey && !/^[A-Za-z0-9_.:-]{4,160}$/.test(input.portableProjectKey)) {
    throw new Error("invalid portable_project_key");
  }
  if (input.branch && input.branch.length > 512) throw new Error("branch hint is too long");
  const canonicalPath = canonicalizeProjectPath(input.cwd);
  // #38 — `/` and any path with an empty basename are rejected exactly like
  // `unknown`: attaching to the wrong project is worse than attaching to none.
  if (isUntrustedProjectPath(input.cwd)) throw new UntrustedProjectPathError(String(input.cwd ?? ""));
  const at = nowIso(input.now);
  const device = deviceId(db);
  const inspected = input.gitCommonDir === undefined && input.remoteFingerprint === undefined
    ? inspectWorkspaceLocation(canonicalPath)
    : { gitCommonDir: input.gitCommonDir ?? null, remoteFingerprint: input.remoteFingerprint ?? null, locationKind: input.locationKind ?? "directory" as WorkspaceLocationKind, branch: input.branch ?? null, defaultBranch: null, gitCommonIdentity: null, gitDirIdentity: null };
  const gitCommonDir = input.gitCommonDir ?? inspected.gitCommonDir;
  const remoteFingerprint = input.remoteFingerprint ?? inspected.remoteFingerprint;
  const locationKind = input.locationKind ?? inspected.locationKind;

  const tx = db.transaction((): WorkspaceIdentity => {
    const byPath = db.prepare(`
      SELECT w.workspace_id, w.project_id, w.location_kind, w.branch, w.default_branch,
             w.git_common_dir, w.git_common_identity, w.git_dir_identity, w.remote_fingerprint,
             p.portable_project_key, p.memory_revision
      FROM workspaces w JOIN projects p ON p.project_id = w.project_id
      WHERE w.device_id = ? AND w.canonical_path = ?
    `).get(device, canonicalPath) as Record<string, unknown> | undefined;
    if (byPath) {
      if (input.projectId && input.projectId !== String(byPath.project_id)) {
        throw new Error("workspace is already linked to another project; use explicit linkWorkspaceToProject");
      }
      if (input.portableProjectKey && input.portableProjectKey !== byPath.portable_project_key) {
        throw new Error("workspace portable_project_key conflicts with its linked project");
      }
      // #21 — a directory can become a clone, gain a worktree, or lose `.git`
      // between sessions. When the path is actually present the fresh
      // inspection is authoritative and replaces the stored git metadata in
      // place; workspace_id and project_id never change, so project-common
      // memory, Capsules and history survive the transition untouched. A
      // historical or vanished path keeps whatever was recorded.
      const observed = directoryExists(canonicalPath);
      const previous = {
        locationKind: String(byPath.location_kind ?? "directory"),
        gitCommonDir: (byPath.git_common_dir as string | null) ?? null,
        gitCommonIdentity: (byPath.git_common_identity as string | null) ?? null,
        gitDirIdentity: (byPath.git_dir_identity as string | null) ?? null,
        remoteFingerprint: (byPath.remote_fingerprint as string | null) ?? null,
        branch: (byPath.branch as string | null) ?? null,
      };
      const next = observed
        ? {
          locationKind,
          gitCommonDir: gitCommonDir ? canonicalizeProjectPath(gitCommonDir) : null,
          gitCommonIdentity: inspected.gitCommonIdentity,
          gitDirIdentity: inspected.gitDirIdentity,
          remoteFingerprint,
          branch: input.branch ?? inspected.branch ?? null,
        }
        : {
          locationKind,
          gitCommonDir: gitCommonDir ? canonicalizeProjectPath(gitCommonDir) : previous.gitCommonDir,
          gitCommonIdentity: inspected.gitCommonIdentity ?? previous.gitCommonIdentity,
          gitDirIdentity: inspected.gitDirIdentity ?? previous.gitDirIdentity,
          remoteFingerprint: remoteFingerprint ?? previous.remoteFingerprint,
          branch: input.branch ?? inspected.branch ?? previous.branch,
        };
      db.prepare(`
        UPDATE workspaces SET git_common_dir = ?, git_common_identity = ?, git_dir_identity = ?,
          remote_fingerprint = ?, location_kind = ?, branch = ?,
          default_branch = COALESCE(?, default_branch), last_seen_at = ? WHERE workspace_id = ?
      `).run(next.gitCommonDir, next.gitCommonIdentity, next.gitDirIdentity,
        next.remoteFingerprint, next.locationKind, next.branch,
        inspected.defaultBranch, at, byPath.workspace_id);
      const changedFields = (["locationKind", "gitCommonDir", "gitCommonIdentity", "gitDirIdentity", "remoteFingerprint"] as const)
        .filter((key) => previous[key] !== next[key]);
      if (changedFields.length > 0) {
        recordWorkspaceLocationChange(db, {
          workspaceId: String(byPath.workspace_id),
          projectId: String(byPath.project_id),
          from: previous.locationKind,
          to: next.locationKind,
          gitCommonDir: next.gitCommonDir,
          remoteFingerprint: next.remoteFingerprint,
          branch: next.branch,
          changedFields: [...changedFields],
          // No auto-merge: an identity that already belongs to another project
          // stays a suggestion the user must approve, exactly like a shared
          // remote does today.
          conflictProjectIds: conflictingProjects(db, device, String(byPath.project_id), next),
          now: at,
        });
      }
      return {
        projectId: String(byPath.project_id), workspaceId: String(byPath.workspace_id), canonicalPath,
        portableProjectKey: byPath.portable_project_key ? String(byPath.portable_project_key) : null,
        memoryRevision: Number(byPath.memory_revision), locationKind,
        branch: next.branch,
        defaultBranch: inspected.defaultBranch ?? (byPath.default_branch ? String(byPath.default_branch) : null),
        reason: "existing-path",
      };
    }

    if (inspected.gitDirIdentity) {
      const moved = db.prepare(`
        SELECT w.workspace_id, w.project_id, w.location_kind, w.branch, w.default_branch,
               p.portable_project_key, p.memory_revision
        FROM workspaces w JOIN projects p ON p.project_id = w.project_id
        WHERE w.device_id = ? AND w.git_dir_identity = ?
      `).all(device, inspected.gitDirIdentity) as Array<Record<string, unknown>>;
      if (moved.length === 1) {
        const row = moved[0];
        if (input.projectId && input.projectId !== String(row.project_id)) {
          throw new Error("moved workspace is linked to another project; use explicit linkWorkspaceToProject");
        }
        db.prepare(`
          UPDATE workspaces SET canonical_path = ?, git_common_dir = ?,
            git_common_identity = ?, remote_fingerprint = COALESCE(?, remote_fingerprint),
            location_kind = ?, branch = COALESCE(?, branch),
            default_branch = COALESCE(?, default_branch), last_seen_at = ?
          WHERE workspace_id = ?
        `).run(canonicalPath, gitCommonDir, inspected.gitCommonIdentity, remoteFingerprint,
          locationKind, input.branch ?? inspected.branch ?? null, inspected.defaultBranch, at, row.workspace_id);
        audit(db, { action: "resolve", projectId: String(row.project_id), workspaceId: String(row.workspace_id), reason: "local git location moved", detail: { canonicalPath }, now: at });
        return {
          projectId: String(row.project_id), workspaceId: String(row.workspace_id), canonicalPath,
          portableProjectKey: row.portable_project_key ? String(row.portable_project_key) : null,
          memoryRevision: Number(row.memory_revision), locationKind,
          branch: input.branch ?? inspected.branch ?? (row.branch ? String(row.branch) : null),
          defaultBranch: inspected.defaultBranch ?? (row.default_branch ? String(row.default_branch) : null),
          reason: "existing-path",
        };
      }
    }

    let selectedProject: { project_id: string; portable_project_key: string | null; memory_revision: number } | undefined;
    let reason: WorkspaceIdentity["reason"] = "new-isolated";
    if (input.projectId) {
      selectedProject = projectRow(db, input.projectId);
      if (!selectedProject) throw new Error("explicit project_id does not exist");
      if (input.portableProjectKey && selectedProject.portable_project_key !== input.portableProjectKey) {
        throw new Error("explicit project_id conflicts with portable_project_key");
      }
      reason = "explicit";
    } else if (input.portableProjectKey) {
      selectedProject = db.prepare(`
        SELECT project_id, portable_project_key, memory_revision FROM projects WHERE portable_project_key = ?
      `).get(input.portableProjectKey) as typeof selectedProject;
      if (!selectedProject) {
        const projectId = `project-${randomUUID()}`;
        db.prepare(`
          INSERT INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
          VALUES (?, ?, ?, 0, ?, ?)
        `).run(projectId, input.portableProjectKey, path.basename(canonicalPath) || "unknown", at, at);
        selectedProject = { project_id: projectId, portable_project_key: input.portableProjectKey, memory_revision: 0 };
      }
      reason = "explicit";
    }
    if (!selectedProject && gitCommonDir) {
      const rows = db.prepare(`
        SELECT DISTINCT p.project_id, p.portable_project_key, p.memory_revision
        FROM workspaces w JOIN projects p ON p.project_id = w.project_id
        WHERE w.device_id = ? AND (
          w.git_common_dir = ? OR (? IS NOT NULL AND w.git_common_identity = ?)
        )
      `).all(device, canonicalizeProjectPath(gitCommonDir), inspected.gitCommonIdentity, inspected.gitCommonIdentity) as Array<typeof selectedProject & object>;
      if (rows.length === 1) {
        selectedProject = rows[0];
        reason = "git-common-dir";
      }
    }
    if (!selectedProject && remoteFingerprint) {
      const rows = db.prepare(`
        SELECT p.project_id, p.portable_project_key, p.memory_revision
        FROM approved_remote_mappings m JOIN projects p ON p.project_id = m.project_id
        WHERE m.remote_fingerprint = ?
      `).all(remoteFingerprint) as Array<{
        project_id: string; portable_project_key: string | null; memory_revision: number;
      }>;
      if (rows.length === 1) {
        selectedProject = rows[0];
        reason = "approved-remote";
      } else {
        const candidates = db.prepare(`
          SELECT DISTINCT project_id FROM workspaces WHERE remote_fingerprint = ?
        `).all(remoteFingerprint) as Array<{ project_id: string }>;
        if (candidates.length > 0 || rows.length > 1) {
          audit(db, {
            action: "suggest",
            reason: rows.length > 1
              ? "remote has conflicting approved project mappings"
              : "same remote requires explicit approval",
            detail: {
              canonicalPath,
              remoteFingerprint,
              candidates: [...new Set([
                ...rows.map((row) => row?.project_id).filter(Boolean),
                ...candidates.map((row) => row.project_id),
              ])],
            },
            now: at,
          });
        }
      }
    }
    if (!selectedProject) {
      const projectId = `project-${randomUUID()}`;
      db.prepare(`
        INSERT INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `).run(projectId, input.portableProjectKey ?? null, path.basename(canonicalPath) || "unknown", at, at);
      selectedProject = { project_id: projectId, portable_project_key: input.portableProjectKey ?? null, memory_revision: 0 };
    }
    const workspaceId = `workspace-${randomUUID()}`;
    db.prepare(`
      INSERT INTO workspaces
        (workspace_id, project_id, device_id, canonical_path, git_common_dir, remote_fingerprint,
         git_common_identity, git_dir_identity, location_kind, branch, default_branch,
         last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId, selectedProject.project_id, device, canonicalPath,
      gitCommonDir ? canonicalizeProjectPath(gitCommonDir) : null,
      remoteFingerprint, inspected.gitCommonIdentity, inspected.gitDirIdentity,
      locationKind, input.branch ?? inspected.branch ?? null, inspected.defaultBranch, at, at,
    );
    audit(db, { action: "resolve", projectId: selectedProject.project_id, workspaceId, reason, detail: { canonicalPath }, now: at });
    return {
      projectId: selectedProject.project_id, workspaceId, canonicalPath,
      portableProjectKey: selectedProject.portable_project_key,
      memoryRevision: selectedProject.memory_revision, locationKind,
      branch: input.branch ?? inspected.branch ?? null,
      defaultBranch: inspected.defaultBranch, reason,
    };
  });
  return db.inTransaction ? tx() : tx.immediate();
}

export function approveRemoteProjectMapping(
  db: Database.Database,
  projectId: string,
  remoteFingerprint: string,
  now?: string,
): void {
  if (!/^[a-f0-9]{8,128}$/i.test(remoteFingerprint)) throw new Error("invalid remote fingerprint");
  if (!projectRow(db, projectId)) throw new Error("project not found");
  db.prepare(`
    INSERT OR IGNORE INTO approved_remote_mappings(remote_fingerprint, project_id, approved_at, approved_by)
    VALUES (?, ?, ?, 'user')
  `).run(remoteFingerprint, projectId, nowIso(now));
}

export function linkWorkspaceToProject(
  db: Database.Database,
  input: { workspaceId: string; targetProjectId: string; approveRemote?: boolean; now?: string },
): void {
  const at = nowIso(input.now);
  const tx = db.transaction(() => {
    const workspace = db.prepare("SELECT project_id, remote_fingerprint, canonical_path FROM workspaces WHERE workspace_id = ?")
      .get(input.workspaceId) as { project_id: string; remote_fingerprint: string | null; canonical_path: string } | undefined;
    if (!workspace) throw new Error("workspace not found");
    if (!projectRow(db, input.targetProjectId)) throw new Error("target project not found");
    if (workspace.project_id === input.targetProjectId) {
      if (input.approveRemote && workspace.remote_fingerprint) {
        approveRemoteProjectMapping(db, input.targetProjectId, workspace.remote_fingerprint, at);
      }
      audit(db, { action: "link", projectId: input.targetProjectId, workspaceId: input.workspaceId, reason: "explicit workspace link already applied", now: at });
      return;
    }
    const sourceProjectId = workspace.project_id;
    const sourceProject = projectRow(db, sourceProjectId);
    const targetProject = projectRow(db, input.targetProjectId)!;
    if (sourceProject?.portable_project_key && targetProject.portable_project_key &&
        sourceProject.portable_project_key !== targetProject.portable_project_key) {
      throw new Error("linked projects have conflicting portable_project_key values");
    }
    const affected = db.prepare('SELECT id FROM facts WHERE project_id = ? OR workspace_id = ?')
      .all(sourceProjectId, input.workspaceId) as Array<{ id: string }>;
    if (affected.length) {
      const policy = captureMutationPolicy(db, 'identity', affected.map(row => row.id));
      assertMutationPolicy(db, policy, affected[0].id);
    }
    db.prepare("UPDATE workspaces SET project_id = ?, last_seen_at = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, at, input.workspaceId);
    db.prepare("UPDATE minimal_workstreams SET project_id = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, input.workspaceId);
    db.prepare("UPDATE session_memory_state SET project_id = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, input.workspaceId);
    db.prepare("UPDATE exchanges SET project_id = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, input.workspaceId);
    db.prepare("UPDATE recall_events SET project_id = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, input.workspaceId);
    db.prepare("UPDATE hot_evidence SET project_id = ? WHERE workspace_id = ?")
      .run(input.targetProjectId, input.workspaceId);
    db.prepare(`
      UPDATE facts SET project_id = ?
      WHERE workspace_id = ? OR (
        project_id = ? AND workspace_id IS NULL AND promotion_state = 'legacy-project'
        AND scope_project = ?
      )
    `).run(input.targetProjectId, input.workspaceId, sourceProjectId, workspace.canonical_path);
    const remaining = (db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE project_id = ?").get(sourceProjectId) as { n: number }).n;
    if (remaining === 0) {
      db.prepare("UPDATE facts SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      db.prepare("UPDATE exchanges SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      db.prepare("UPDATE recall_events SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      db.prepare("UPDATE hot_evidence SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      db.prepare("UPDATE minimal_workstreams SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      db.prepare("UPDATE session_memory_state SET project_id = ? WHERE project_id = ?").run(input.targetProjectId, sourceProjectId);
      if (!targetProject.portable_project_key && sourceProject?.portable_project_key) {
        db.prepare("UPDATE projects SET portable_project_key = NULL WHERE project_id = ?")
          .run(sourceProjectId);
        db.prepare("UPDATE projects SET portable_project_key = ? WHERE project_id = ?")
          .run(sourceProject.portable_project_key, input.targetProjectId);
      }
      db.prepare(`
        INSERT OR IGNORE INTO approved_remote_mappings(remote_fingerprint, project_id, approved_at, approved_by)
        SELECT remote_fingerprint, ?, ?, approved_by
        FROM approved_remote_mappings WHERE project_id = ?
      `).run(input.targetProjectId, at, sourceProjectId);
    }
    if (input.approveRemote && workspace.remote_fingerprint) {
      approveRemoteProjectMapping(db, input.targetProjectId, workspace.remote_fingerprint, at);
    }
    audit(db, { action: "link", projectId: input.targetProjectId, workspaceId: input.workspaceId, reason: "explicit workspace link", detail: { sourceProjectId }, now: at });
    if (remaining === 0) {
      db.prepare("DELETE FROM approved_remote_mappings WHERE project_id = ?").run(sourceProjectId);
      db.prepare("DELETE FROM projects WHERE project_id = ?").run(sourceProjectId);
    }
    refreshWorkspaceEvidence(db, input.workspaceId);
  });
  db.inTransaction ? tx() : tx.immediate();
}

export function splitWorkspace(
  db: Database.Database,
  input: { workspaceId: string; portableProjectKey?: string | null; displayName?: string; now?: string },
): string {
  const at = nowIso(input.now);
  const tx = db.transaction(() => {
    const workspace = db.prepare("SELECT project_id, canonical_path FROM workspaces WHERE workspace_id = ?")
      .get(input.workspaceId) as { project_id: string; canonical_path: string } | undefined;
    if (!workspace) throw new Error("workspace not found");
    const existingAudit = db.prepare(`
      SELECT project_id FROM project_identity_audit
      WHERE action = 'split' AND workspace_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(input.workspaceId) as { project_id: string } | undefined;
    if (existingAudit && workspace.project_id === existingAudit.project_id) {
      const current = projectRow(db, existingAudit.project_id);
      if (input.portableProjectKey && current?.portable_project_key !== input.portableProjectKey) {
        throw new Error("split portable_project_key conflicts with the existing split project");
      }
      return existingAudit.project_id;
    }
    const affected = db.prepare(`SELECT id FROM facts WHERE workspace_id = ? OR
      (project_id = ? AND workspace_id IS NULL AND promotion_state = 'legacy-project' AND scope_project = ?)`)
      .all(input.workspaceId, workspace.project_id, workspace.canonical_path) as Array<{ id: string }>;
    if (affected.length) {
      const policy = captureMutationPolicy(db, 'identity', affected.map(row => row.id));
      assertMutationPolicy(db, policy, affected[0].id);
    }
    const projectId = `project-${randomUUID()}`;
    db.prepare(`
      INSERT INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?)
    `).run(projectId, input.portableProjectKey ?? null, input.displayName ?? path.basename(workspace.canonical_path), at, at);
    db.prepare("UPDATE workspaces SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare("UPDATE minimal_workstreams SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare("UPDATE session_memory_state SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare("UPDATE exchanges SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare("UPDATE recall_events SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare("UPDATE hot_evidence SET project_id = ? WHERE workspace_id = ?").run(projectId, input.workspaceId);
    db.prepare(`
      UPDATE facts SET project_id = ?
      WHERE workspace_id = ? OR (
        project_id = ? AND workspace_id IS NULL AND promotion_state = 'legacy-project'
        AND scope_project = ?
      )
    `).run(projectId, input.workspaceId, workspace.project_id, workspace.canonical_path);
    audit(db, { action: "split", projectId, workspaceId: input.workspaceId, reason: "explicit workspace split", detail: { sourceProjectId: workspace.project_id }, now: at });
    refreshWorkspaceEvidence(db, input.workspaceId);
    return projectId;
  });
  return db.inTransaction ? tx() : tx.immediate();
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection++;
  return intersection / (left.size + right.size - intersection);
}

function workspaceDefaultBranch(db: Database.Database, workspaceId: string): string | null {
  const row = db.prepare("SELECT default_branch FROM workspaces WHERE workspace_id = ?")
    .get(workspaceId) as { default_branch: string | null } | undefined;
  return row?.default_branch ?? null;
}

/** The branch signal a session carries, read from its bound workspace row. */
export function sessionBranchSignal(
  db: Database.Database,
  input: { workspaceId?: string | null; branch?: string | null },
): BranchSignal {
  return branchSignalFor({
    branch: input.branch,
    defaultBranch: input.workspaceId ? workspaceDefaultBranch(db, input.workspaceId) : null,
  });
}

export function bindSessionWorkstream(
  db: Database.Database,
  input: {
    sessionId: string;
    projectId: string;
    workspaceId: string;
    projectPath: string;
    explicitWorkstreamId?: string | null;
    branch?: string | null;
    prompt?: string | null;
    now?: string;
  },
): { workstreamId: string; reason: string; confidence: number } {
  if (!db.inTransaction) {
    const tx = db.transaction(() => bindSessionWorkstream(db, input));
    return tx.immediate();
  }
  const existing = db.prepare(`
    SELECT workstream_id, binding_reason, binding_confidence, project_id, workspace_id
    FROM session_memory_state WHERE session_id = ?
  `).get(input.sessionId) as {
    workstream_id: string; binding_reason: string; binding_confidence: number;
    project_id: string | null; workspace_id: string | null;
  } | undefined;
  if (existing) {
    if (existing.project_id && existing.project_id !== input.projectId) {
      throw new Error("resumed session is outside the resolved project");
    }
    if (existing.workspace_id && existing.workspace_id !== input.workspaceId) {
      throw new Error("resumed session is outside the resolved workspace");
    }
    return { workstreamId: existing.workstream_id, reason: "resume-exact", confidence: 1 };
  }
  const at = nowIso(input.now);
  let workstreamId: string | null = null;
  let reason = "session-local";
  let confidence = 1;
  if (input.explicitWorkstreamId) {
    const explicit = db.prepare("SELECT project_id FROM minimal_workstreams WHERE workstream_id = ?")
      .get(input.explicitWorkstreamId) as { project_id: string | null } | undefined;
    if (!explicit || explicit.project_id !== input.projectId) throw new Error("explicit workstream is outside the resolved project");
    workstreamId = input.explicitWorkstreamId;
    reason = "explicit";
  }
  if (!workstreamId && input.branch) {
    const candidates = db.prepare(`
      SELECT workstream_id FROM minimal_workstreams
      WHERE project_id = ? AND workspace_id = ? AND status = 'active' AND branch_hint = ?
      ORDER BY updated_at DESC
    `).all(input.projectId, input.workspaceId, input.branch) as Array<{ workstream_id: string }>;
    if (candidates.length === 1) {
      workstreamId = candidates[0].workstream_id;
      reason = "unique-workspace-branch";
      confidence = 0.9;
    }
  }
  // #16 — deterministic stream identity. A branch signal keys on the branch;
  // no signal (non-git or default branch) reuses the project's ONE default
  // stream. Both are looked up before the topic heuristic so repeated sessions
  // converge on the same stream instead of splitting per session.
  const signal = branchSignalFor({
    branch: input.branch,
    defaultBranch: workspaceDefaultBranch(db, input.workspaceId),
  });
  const deterministicId = deterministicWorkstreamId(
    input.projectId,
    signal.kind === "branch" ? signal.branch : null,
  );
  const deterministicReason = signal.kind === "branch" ? "workspace-branch" : "project-default";
  if (!workstreamId) {
    // The id already hashes the project, so a hit is always this project's.
    const known = db.prepare("SELECT workstream_id FROM minimal_workstreams WHERE workstream_id = ?")
      .get(deterministicId) as { workstream_id: string } | undefined;
    if (known) {
      workstreamId = known.workstream_id;
      reason = deterministicReason;
    }
  }
  if (!workstreamId && input.prompt?.trim()) {
    const query = tokens(input.prompt);
    const rows = db.prepare(`
      SELECT w.workstream_id, c.objective, c.current_state
      FROM minimal_workstreams w JOIN work_capsules c ON c.workstream_id = w.workstream_id
      WHERE w.project_id = ? AND w.status = 'active'
    `).all(input.projectId) as Array<{ workstream_id: string; objective: string; current_state: string }>;
    const ranked = rows.map((row) => ({ id: row.workstream_id, score: jaccard(query, tokens(`${row.objective} ${row.current_state}`)) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    if (ranked[0] && ranked[0].score >= 0.45 && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.15) {
      workstreamId = ranked[0].id;
      reason = "strong-topic-margin";
      confidence = ranked[0].score;
    }
  }
  if (!workstreamId) {
    workstreamId = deterministicId;
    reason = deterministicReason;
    db.prepare(`
      INSERT OR IGNORE INTO minimal_workstreams
        (workstream_id, project, session_id, branch_hint, binding_reason, project_id, workspace_id,
         status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(workstreamId, input.projectPath, input.sessionId, signal.branch,
      deterministicReason, input.projectId, input.workspaceId, at, at);
  }
  db.prepare(`
    INSERT INTO workstream_sessions(session_id, workstream_id, workspace_id, binding_reason, binding_confidence, bound_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.sessionId, workstreamId, input.workspaceId, reason, confidence, at);
  db.prepare(`
    INSERT INTO session_memory_state
      (session_id, project, project_id, workspace_id, workstream_id, context_epoch,
       binding_reason, binding_confidence, last_source, memory_revision_seen, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'binding',
      COALESCE((SELECT memory_revision FROM projects WHERE project_id = ?), 0), ?, ?)
  `).run(input.sessionId, input.projectPath, input.projectId, input.workspaceId, workstreamId, reason, confidence, input.projectId, at, at);
  audit(db, { action: "rebind", projectId: input.projectId, workspaceId: input.workspaceId, workstreamId, sessionId: input.sessionId, reason, detail: { confidence }, now: at });
  return { workstreamId, reason, confidence };
}

export function createWorkstream(
  db: Database.Database,
  input: {
    projectId: string;
    workspaceId: string;
    projectPath: string;
    ownerSessionId: string;
    branch?: string | null;
    workstreamId?: string;
    topic?: string | null;
    now?: string;
  },
): string {
  const workspace = db.prepare("SELECT project_id FROM workspaces WHERE workspace_id = ?")
    .get(input.workspaceId) as { project_id: string } | undefined;
  if (!workspace || workspace.project_id !== input.projectId) {
    throw new Error("workstream workspace is outside the resolved project");
  }
  const at = nowIso(input.now);
  const workstreamId = input.workstreamId ?? `ws-${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(workstreamId)) throw new Error("invalid workstream_id");
  const topicFingerprint = input.topic?.trim() ? hash("topic-v1", ...[...tokens(input.topic)].sort()) : null;
  db.prepare(`
    INSERT INTO minimal_workstreams
      (workstream_id, project, session_id, branch_hint, binding_reason, project_id,
       workspace_id, status, topic_fingerprint, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'explicit-create', ?, ?, 'active', ?, ?, ?)
  `).run(
    workstreamId, canonicalizeProjectPath(input.projectPath), input.ownerSessionId,
    input.branch ?? null, input.projectId, input.workspaceId, topicFingerprint, at, at,
  );
  return workstreamId;
}

export function rebindSessionWorkstream(
  db: Database.Database,
  input: { sessionId: string; workstreamId: string; now?: string },
): void {
  const at = nowIso(input.now);
  const tx = db.transaction(() => {
    const session = db.prepare(`
      SELECT project_id, workspace_id, workstream_id FROM session_memory_state WHERE session_id = ?
    `).get(input.sessionId) as { project_id: string; workspace_id: string; workstream_id: string } | undefined;
    if (!session) throw new Error("session binding not found");
    const target = db.prepare("SELECT project_id FROM minimal_workstreams WHERE workstream_id = ?")
      .get(input.workstreamId) as { project_id: string } | undefined;
    if (!target || target.project_id !== session.project_id) {
      throw new Error("target workstream is outside the session project");
    }
    if (session.workstream_id === input.workstreamId) return;
    db.prepare(`
      UPDATE session_memory_state
      SET workstream_id = ?, binding_reason = 'explicit-rebind', binding_confidence = 1.0,
          capsule_generation_seen = 0, hot_evidence_cursor = 0, updated_at = ?
      WHERE session_id = ?
    `).run(input.workstreamId, at, input.sessionId);
    db.prepare(`
      INSERT INTO workstream_sessions
        (session_id, workstream_id, workspace_id, binding_reason, binding_confidence, bound_at)
      VALUES (?, ?, ?, 'explicit-rebind', 1.0, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        workstream_id = excluded.workstream_id,
        workspace_id = excluded.workspace_id,
        binding_reason = excluded.binding_reason,
        binding_confidence = excluded.binding_confidence,
        bound_at = excluded.bound_at
    `).run(input.sessionId, input.workstreamId, session.workspace_id, at);
    db.prepare("UPDATE exchanges SET workstream_id = ? WHERE session_id = ?")
      .run(input.workstreamId, input.sessionId);
    db.prepare("UPDATE hot_evidence SET workstream_id = ? WHERE session_id = ?")
      .run(input.workstreamId, input.sessionId);
    db.prepare("UPDATE checkpoints SET workstream_id = ? WHERE session_id = ?")
      .run(input.workstreamId, input.sessionId);
    db.prepare(`UPDATE capsule_checkpoint_state
      SET workstream_id = ?, target_seq = NULL, target_revision = NULL
      WHERE checkpoint_id IN (SELECT checkpoint_id FROM checkpoints WHERE session_id = ?)`)
      .run(input.workstreamId, input.sessionId);
    db.prepare(`UPDATE memory_jobs SET partition_key = ?,
      state = CASE WHEN state = 'running' THEN 'pending' ELSE state END,
      lease_generation = lease_generation + 1, lease_owner = NULL, lease_until = NULL
      WHERE kind = 'capsule_update' AND checkpoint_id IN
        (SELECT checkpoint_id FROM checkpoints WHERE session_id = ?)`)
      .run(`workstream:${input.workstreamId}`, input.sessionId);
    appendSessionEvidence(db, input.sessionId);
    audit(db, {
      action: "rebind", projectId: session.project_id, workspaceId: session.workspace_id,
      workstreamId: input.workstreamId, sessionId: input.sessionId,
      reason: "explicit session rebind", detail: { previousWorkstreamId: session.workstream_id }, now: at,
    });
  });
  db.inTransaction ? tx() : tx.immediate();
}

function refreshWorkspaceEvidence(db: Database.Database, workspaceId: string): void {
  const sessions = db.prepare("SELECT session_id FROM session_memory_state WHERE workspace_id = ?")
    .all(workspaceId) as Array<{ session_id: string }>;
  for (const session of sessions) appendSessionEvidence(db, session.session_id);
}

export function indexHotEvidenceForSession(
  db: Database.Database,
  sessionId: string,
  options: { ttlDays?: number; now?: string } = {},
): number {
  const at = nowIso(options.now);
  const expires = new Date(Date.parse(at) + Math.max(1, options.ttlDays ?? 14) * 86_400_000).toISOString();
  const rows = db.prepare(`
    SELECT e.id, e.project_id, e.workspace_id, e.workstream_id, e.user_message,
           s.workstream_id AS session_workstream
    FROM exchanges e LEFT JOIN session_memory_state s ON s.session_id = e.session_id
    WHERE e.session_id = ? AND e.project_id IS NOT NULL
    ORDER BY e.exchange_seq, e.rowid
  `).all(sessionId) as Array<Record<string, unknown>>;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO hot_evidence
      (evidence_id, project_id, workspace_id, workstream_id, session_id, exchange_id,
       evidence_kind, source_type, evidence_text, content_hash, authority, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hot-evidence', ?, ?)
  `);
  let saved = 0;
  for (const row of rows) {
    const exchangeId = String(row.id);
    const userText = String(row.user_message ?? "").trim();
    if (userText) {
      const contentHash = hash(userText);
      saved += insert.run(
        `hot-${hash(exchangeId, "human", contentHash).slice(0, 32)}`,
        row.project_id, row.workspace_id ?? null, row.workstream_id ?? row.session_workstream ?? null,
        sessionId, exchangeId, "human", "human_assertion", userText.slice(0, 2_000), contentHash, at, expires,
      ).changes;
    }
    const tools = db.prepare(`
      SELECT source_type, tool_result FROM tool_calls
      WHERE exchange_id = ? AND learnable = 1 AND is_error = 0
        AND source_type IN ('repo_file','git_history','test_execution')
      ORDER BY id
    `).all(exchangeId) as Array<{ source_type: string; tool_result: string }>;
    for (const tool of tools) {
      const text = String(tool.tool_result ?? "").trim();
      if (!text) continue;
      const contentHash = hash(text);
      saved += insert.run(
        `hot-${hash(exchangeId, tool.source_type, contentHash).slice(0, 32)}`,
        row.project_id, row.workspace_id ?? null, row.workstream_id ?? row.session_workstream ?? null,
        sessionId, exchangeId, "trusted_tool", tool.source_type, text.slice(0, 2_000), contentHash, at, expires,
      ).changes;
    }
  }
  db.prepare("DELETE FROM hot_evidence WHERE expires_at <= ?").run(at);
  return saved;
}

export function readHotEvidence(
  db: Database.Database,
  input: {
    projectId: string;
    workspaceId?: string | null;
    workstreamId?: string | null;
    sessionId?: string | null;
    /** Sibling-lane read: the session's own evidence is already in its context. */
    excludeSessionId?: string | null;
    beforeCreatedAt?: string | null;
    beforeEvidenceId?: string | null;
    /** Optional timestamp filter; automatic residency uses afterSeq. */
    afterCreatedAt?: string | null;
    /** Automatic continuity reads the oldest unconsumed eligible sequence. */
    afterSeq?: number;
    limit?: number;
    now?: string;
  },
): Array<Record<string, unknown>> {
  const where = ["project_id = ?", "expires_at > ?"];
  const args: unknown[] = [input.projectId, nowIso(input.now)];
  if (input.workspaceId) { where.push("workspace_id = ?"); args.push(input.workspaceId); }
  if (input.workstreamId) { where.push("workstream_id = ?"); args.push(input.workstreamId); }
  if (input.sessionId) { where.push("session_id = ?"); args.push(input.sessionId); }
  if (input.excludeSessionId) { where.push("session_id <> ?"); args.push(input.excludeSessionId); }
  if (input.afterCreatedAt) { where.push("created_at > ?"); args.push(input.afterCreatedAt); }
  if (input.afterSeq !== undefined) { where.push("seq > ?"); args.push(input.afterSeq); }
  if (input.beforeCreatedAt) {
    where.push("(created_at < ? OR (created_at = ? AND evidence_id > ?))");
    args.push(input.beforeCreatedAt, input.beforeCreatedAt, input.beforeEvidenceId ?? "");
  }
  args.push(Math.max(1, Math.min(100, input.limit ?? 20)));
  return db.prepare(`
    SELECT seq, evidence_id, project_id, workspace_id, workstream_id, session_id, exchange_id,
           evidence_kind, source_type, evidence_text, authority, created_at, expires_at,
           'HOT EVIDENCE — NOT YET DISTILLED' AS lane
    FROM hot_evidence JOIN hot_evidence_sequence USING(evidence_id) WHERE ${where.join(" AND ")}
    ORDER BY ${input.afterSeq === undefined ? "created_at DESC, evidence_id" : "seq"} LIMIT ?
  `).all(...args) as Array<Record<string, unknown>>;
}

/** Commit only the emitted eligible prefix; a purge/rebind/epoch race retries. */
export function commitHotEvidenceCursor(
  db: Database.Database,
  input: {
    sessionId: string; projectId: string; workstreamId: string; contextEpoch: number;
    fromSeq: number; emittedSeqs: number[];
  },
): void {
  if (!db.inTransaction) throw new Error("Hot Evidence cursor requires the residency transaction");
  if (!input.emittedSeqs.length) return;
  const end = input.emittedSeqs.at(-1)!;
  const current = readHotEvidence(db, {
    projectId: input.projectId, workstreamId: input.workstreamId, excludeSessionId: input.sessionId,
    afterSeq: input.fromSeq, limit: input.emittedSeqs.length,
  });
  if (current.length !== input.emittedSeqs.length ||
      current.some((row, i) => Number(row.seq) !== input.emittedSeqs[i])) {
    throw new Error("Hot Evidence prefix changed before residency commit");
  }
  const updated = db.prepare(`UPDATE session_memory_state SET hot_evidence_cursor = ?
    WHERE session_id = ? AND project_id = ? AND workstream_id = ?
      AND context_epoch = ? AND hot_evidence_cursor = ?`)
    .run(end, input.sessionId, input.projectId, input.workstreamId, input.contextEpoch, input.fromSeq);
  if (updated.changes !== 1) throw new Error("Hot Evidence scope or cursor changed before residency commit");
}

export function assignFactSubject(
  db: Database.Database,
  input: {
    factId: string;
    projectId: string;
    subjectKey: string;
    promotionState: "decision" | "project-current" | "workspace" | "workstream";
    /**
     * #18 — `no-branch-signal` is admissible evidence for project-current: a
     * non-git or default-branch session has no branch for the fact to belong
     * to, so project-common IS its grounded placement, not a promotion.
     */
    evidence: "explicit-decision" | "merged" | "validated" | "experimental" | "no-branch-signal";
    /** Recorded on the fact: `no-branch-signal` | `default-branch` | `branch:<name>`. */
    tierReason?: string | null;
    workspaceId?: string | null;
    workstreamId?: string | null;
  },
): void {
  if (!/^[a-z][a-z0-9_.-]{2,160}$/.test(input.subjectKey)) throw new Error("invalid subject_key");
  if (input.promotionState === "decision" && input.evidence !== "explicit-decision") {
    throw new Error("project decision requires explicit decision evidence");
  }
  if (input.promotionState === "project-current" &&
      !["merged", "validated", "no-branch-signal"].includes(input.evidence)) {
    throw new Error("project current state requires merged, validated or no-branch-signal evidence");
  }
  if (input.promotionState === "workspace" && !input.workspaceId) throw new Error("workspace state requires workspace_id");
  if (input.promotionState === "workstream" && !input.workstreamId) throw new Error("workstream state requires workstream_id");
  if (input.promotionState === "workstream" && input.evidence !== "experimental") throw new Error("workstream state must remain experimental");
  if ((input.promotionState === "decision" || input.promotionState === "project-current") &&
      (input.workspaceId || input.workstreamId)) {
    throw new Error("project-wide truth cannot retain workspace/workstream scope");
  }
  if (input.promotionState === "workspace" && input.workstreamId) {
    throw new Error("workspace truth cannot retain workstream scope");
  }
  const current = db.prepare(`
    SELECT project_id, subject_key, promotion_state, workspace_id, workstream_id
    FROM facts WHERE id = ?
  `).get(input.factId) as {
    project_id: string | null; subject_key: string | null; promotion_state: string;
    workspace_id: string | null; workstream_id: string | null;
  } | undefined;
  if (!current) throw new Error("fact not found");
  if (current.project_id === input.projectId && current.subject_key === input.subjectKey &&
      current.promotion_state === input.promotionState &&
      current.workspace_id === (input.workspaceId ?? null) &&
      current.workstream_id === (input.workstreamId ?? null)) {
    return;
  }
  const conflict = db.prepare(`
    SELECT id FROM facts WHERE id <> ? AND is_active = 1 AND project_id = ? AND subject_key = ?
      AND promotion_state = ? AND COALESCE(workspace_id, '') = COALESCE(?, '')
      AND COALESCE(workstream_id, '') = COALESCE(?, '') LIMIT 1
  `).get(input.factId, input.projectId, input.subjectKey, input.promotionState, input.workspaceId ?? null, input.workstreamId ?? null);
  if (conflict) throw new Error("subject_key slot already has an active fact");
  const policy = captureMutationPolicy(db, 'identity', [input.factId]);
  const apply = db.transaction(() => {
    assertMutationPolicy(db, policy, input.factId);
    const changed = db.prepare(`
      UPDATE facts SET project_id = ?, subject_key = ?, promotion_state = ?, workspace_id = ?, workstream_id = ?,
        tier_reason = COALESCE(?, tier_reason),
        semantic_generation = semantic_generation + 1, semantic_updated_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      input.projectId, input.subjectKey, input.promotionState,
      input.workspaceId ?? null, input.workstreamId ?? null, input.tierReason ?? null,
      new Date().toISOString(), new Date().toISOString(), input.factId,
    );
    if (changed.changes !== 1) throw new Error("fact not found");
    audit(db, { action: 'rebind', projectId: input.projectId, workspaceId: input.workspaceId,
      workstreamId: input.workstreamId, reason: 'explicit fact placement',
      detail: { factId: input.factId, promotionState: input.promotionState, evidence: input.evidence,
        subjectKey: input.subjectKey, previous: current } });
  });
  apply();
}

export function projectRevision(db: Database.Database, projectId: string): number {
  return Number((db.prepare("SELECT memory_revision FROM projects WHERE project_id = ?").get(projectId) as { memory_revision?: number } | undefined)?.memory_revision ?? 0);
}

export function sessionProjectRevisionState(
  db: Database.Database,
  sessionId: string,
): { projectId: string | null; seen: number; current: number } {
  const row = db.prepare(`
    SELECT s.project_id, s.memory_revision_seen, p.memory_revision
    FROM session_memory_state s LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.session_id = ?
  `).get(sessionId) as
    | { project_id: string | null; memory_revision_seen: number; memory_revision: number | null }
    | undefined;
  return {
    projectId: row?.project_id ?? null,
    seen: Number(row?.memory_revision_seen ?? 0),
    current: Number(row?.memory_revision ?? 0),
  };
}

export function markSessionProjectRevisionSeen(
  db: Database.Database,
  sessionId: string,
  expectedRevision: number,
): boolean {
  return db.prepare(`
    UPDATE session_memory_state SET memory_revision_seen = ?, updated_at = ?
    WHERE session_id = ? AND project_id IS NOT NULL
      AND (SELECT memory_revision FROM projects WHERE project_id = session_memory_state.project_id) = ?
  `).run(expectedRevision, new Date().toISOString(), sessionId, expectedRevision).changes === 1;
}
