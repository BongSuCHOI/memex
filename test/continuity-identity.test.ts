import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", () => ({
  EMBEDDING_VERSION: 2,
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.1),
}));

import { initDatabase, insertExchange, recordRecallEvent } from "../src/db.js";
import { deactivateFact, insertFact, searchFactsByScope } from "../src/fact-db.js";
import {
  approveRemoteProjectMapping,
  assignFactSubject,
  bindSessionWorkstream,
  createWorkstream,
  indexHotEvidenceForSession,
  linkWorkspaceToProject,
  markSessionProjectRevisionSeen,
  projectRevision,
  readHotEvidence,
  rebindSessionWorkstream,
  resolveProjectWorkspace,
  splitWorkspace,
} from "../src/continuity-identity.js";
import { createRelation, getRelatedFacts } from "../src/ontology-db.js";
import {
  buildRehydrationContext,
  ensureSessionMemoryState,
  handleContinuityHook,
  readResidentFactRevisions,
  recordResidentFactRevisions,
} from "../src/continuity-core.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import type { ConversationExchange } from "../src/types.js";
import {
  createCheckpointWithJob,
  ensureContinuitySchema,
} from "../src/continuity-store.js";

let root: string;
let db: Database.Database;
const emb = new Array(384).fill(0.1);

function gitClone(dir: string, remote = "git@example.test:team/repo.git"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
}

function gitWorktree(commonRoot: string, dir: string, name: string): void {
  const gitDir = path.join(commonRoot, ".git", "worktrees", name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${name}\n`);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
}

function exchange(id: string, sessionId: string, cwd: string, userMessage = "Use SQLite for the cache"): ConversationExchange {
  return {
    id, project: cwd, cwd, timestamp: "2026-09-03T00:00:00.000Z",
    userMessage, assistantMessage: "context only", archivePath: path.join(root, `${sessionId}.jsonl`),
    lineStart: 1, lineEnd: 2, sessionId, closureState: "closed", parserVersion: 2,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-identity-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("stable project/workspace resolver", () => {
  it("uses one project and distinct workspaces for a checkout and its worktree", () => {
    const main = path.join(root, "repo");
    const worktree = path.join(root, "repo-feature");
    gitClone(main);
    gitWorktree(main, worktree, "feature");
    const a = resolveProjectWorkspace(db, { cwd: main });
    const b = resolveProjectWorkspace(db, { cwd: worktree });
    expect(b.projectId).toBe(a.projectId);
    expect(b.workspaceId).not.toBe(a.workspaceId);
    expect(b.reason).toBe("git-common-dir");
    expect(b.locationKind).toBe("worktree");
  });

  it("preserves project and workspace identity when a local git checkout is renamed", () => {
    const beforePath = path.join(root, "before-name");
    const afterPath = path.join(root, "after-name");
    gitClone(beforePath);
    const before = resolveProjectWorkspace(db, { cwd: beforePath });
    fs.renameSync(beforePath, afterPath);
    const after = resolveProjectWorkspace(db, { cwd: afterPath });
    expect(after.projectId).toBe(before.projectId);
    expect(after.workspaceId).toBe(before.workspaceId);
    expect((db.prepare("SELECT canonical_path FROM workspaces WHERE workspace_id = ?").get(before.workspaceId) as { canonical_path: string }).canonical_path).toBe(afterPath);
  });

  it("keeps same-remote clones isolated until an approved mapping exists", () => {
    const aPath = path.join(root, "clone-a");
    const bPath = path.join(root, "clone-b");
    const cPath = path.join(root, "clone-c");
    gitClone(aPath); gitClone(bPath); gitClone(cPath);
    const a = resolveProjectWorkspace(db, { cwd: aPath });
    const b = resolveProjectWorkspace(db, { cwd: bPath });
    expect(b.projectId).not.toBe(a.projectId);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_identity_audit WHERE action = 'suggest'").get() as { n: number }).n).toBe(1);
    const fingerprint = (db.prepare("SELECT remote_fingerprint FROM workspaces WHERE workspace_id = ?").get(a.workspaceId) as { remote_fingerprint: string }).remote_fingerprint;
    approveRemoteProjectMapping(db, a.projectId, fingerprint);
    const c = resolveProjectWorkspace(db, { cwd: cPath });
    expect(c.projectId).toBe(a.projectId);
    expect(c.reason).toBe("approved-remote");
  });

  it("supports explicit portable links and rejects silent path relinking", () => {
    const first = resolveProjectWorkspace(db, { cwd: path.join(root, "one") });
    db.prepare("UPDATE projects SET portable_project_key = 'portable:memex' WHERE project_id = ?").run(first.projectId);
    const moved = resolveProjectWorkspace(db, { cwd: path.join(root, "moved"), portableProjectKey: "portable:memex" });
    expect(moved.projectId).toBe(first.projectId);
    expect(() => resolveProjectWorkspace(db, { cwd: moved.canonicalPath, projectId: "project-does-not-exist" }))
      .toThrow("already linked");
  });

  it("makes explicit link and split idempotent and auditable", () => {
    const a = resolveProjectWorkspace(db, { cwd: path.join(root, "a") });
    const b = resolveProjectWorkspace(db, { cwd: path.join(root, "b") });
    linkWorkspaceToProject(db, { workspaceId: b.workspaceId, targetProjectId: a.projectId });
    linkWorkspaceToProject(db, { workspaceId: b.workspaceId, targetProjectId: a.projectId });
    const split = splitWorkspace(db, { workspaceId: b.workspaceId });
    expect(splitWorkspace(db, { workspaceId: b.workspaceId })).toBe(split);
    expect(() => splitWorkspace(db, {
      workspaceId: b.workspaceId,
      portableProjectKey: "portable:different-split",
    })).toThrow("conflicts with the existing split project");
    expect((db.prepare("SELECT project_id FROM workspaces WHERE workspace_id = ?").get(b.workspaceId) as { project_id: string }).project_id).toBe(split);
    expect((db.prepare("SELECT COUNT(*) AS n FROM project_identity_audit WHERE workspace_id = ? AND action IN ('link','split')").get(b.workspaceId) as { n: number }).n).toBeGreaterThanOrEqual(2);
  });

  it("moves path-owned legacy data and portable identity when linking the last workspace", () => {
    const target = resolveProjectWorkspace(db, { cwd: path.join(root, "target") });
    const source = resolveProjectWorkspace(db, { cwd: path.join(root, "source"), portableProjectKey: "portable:source" });
    const factId = insertFact(db, {
      fact: "source path truth", category: "knowledge", scope_type: "project",
      scope_project: source.canonicalPath, source_exchange_ids: [], embedding: null,
      project_id: source.projectId, promotion_state: "legacy-project",
      subject_key: "legacy.source.truth",
    });
    linkWorkspaceToProject(db, { workspaceId: source.workspaceId, targetProjectId: target.projectId });
    expect(db.prepare("SELECT project_id FROM facts WHERE id = ?").get(factId)).toEqual({ project_id: target.projectId });
    expect(db.prepare("SELECT portable_project_key FROM projects WHERE project_id = ?").get(target.projectId))
      .toEqual({ portable_project_key: "portable:source" });
    expect(db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(source.projectId)).toBeUndefined();
  });

  it("rejects a link between conflicting portable identities without partial mutation", () => {
    const target = resolveProjectWorkspace(db, { cwd: path.join(root, "target"), portableProjectKey: "portable:target" });
    const source = resolveProjectWorkspace(db, { cwd: path.join(root, "source"), portableProjectKey: "portable:source" });
    expect(() => linkWorkspaceToProject(db, { workspaceId: source.workspaceId, targetProjectId: target.projectId }))
      .toThrow("conflicting portable_project_key");
    expect(db.prepare("SELECT project_id FROM workspaces WHERE workspace_id = ?").get(source.workspaceId))
      .toEqual({ project_id: source.projectId });
  });

  it("moves legacy facts owned by a workspace path during an explicit split", () => {
    const first = resolveProjectWorkspace(db, { cwd: path.join(root, "first") });
    const secondPath = path.join(root, "second");
    const second = resolveProjectWorkspace(db, { cwd: secondPath, projectId: first.projectId });
    const factId = insertFact(db, {
      fact: "second checkout legacy truth", category: "knowledge", scope_type: "project",
      scope_project: secondPath, source_exchange_ids: [], embedding: null,
      project_id: first.projectId, promotion_state: "legacy-project",
      subject_key: "legacy.second.truth",
    });
    const splitProject = splitWorkspace(db, { workspaceId: second.workspaceId });
    expect(db.prepare("SELECT project_id FROM facts WHERE id = ?").get(factId))
      .toEqual({ project_id: splitProject });
  });

  it("backfills Phase 2 path data without losing fact, recall, checkpoint, or Capsule provenance", () => {
    const cwd = path.join(root, "legacy-phase2");
    const state = ensureSessionMemoryState(db, { sessionId: "legacy-session", project: cwd });
    insertExchange(db, exchange("legacy-ex", "legacy-session", cwd), emb);
    const factId = insertFact(db, {
      fact: "Legacy current truth",
      category: "knowledge",
      scope_type: "project",
      scope_project: cwd,
      source_exchange_ids: ["legacy-ex"],
      embedding: emb,
      promotion_state: "legacy-project",
    });
    const recallId = recordRecallEvent(db, {
      sessionId: "legacy-session",
      project: cwd,
      prompt: "legacy recall",
      factIds: [factId],
      projectId: state.projectId,
      workspaceId: state.workspaceId,
      workstreamId: state.workstreamId,
    });
    createCheckpointWithJob(db, {
      checkpoint: {
        checkpointId: "legacy-checkpoint",
        sessionId: "legacy-session",
        ordinal: 1,
        kind: "stop",
        idempotencyKey: "legacy-checkpoint",
      },
      job: {
        kind: "capture_index",
        partitionKey: "session:legacy-session",
        policyVersion: "continuity-capture-v1",
        priority: 100,
        idempotencyKey: "legacy-checkpoint-job",
      },
    });
    db.prepare(`
      INSERT INTO work_capsules
        (workstream_id, generation, objective, current_state,
         source_exchange_ids_json, through_checkpoint_id, updated_at)
      VALUES (?, 1, 'legacy objective', 'legacy state', '["legacy-ex"]',
              'legacy-checkpoint', ?)
    `).run(state.workstreamId, "2026-09-03T00:00:00.000Z");

    db.prepare("DELETE FROM workstream_sessions").run();
    db.prepare("UPDATE exchanges SET project_id = NULL, workspace_id = NULL, workstream_id = NULL").run();
    db.prepare("UPDATE facts SET project_id = NULL, workspace_id = NULL, workstream_id = NULL, subject_key = NULL").run();
    db.prepare("UPDATE recall_events SET project_id = NULL, workspace_id = NULL, workstream_id = NULL").run();
    db.prepare("UPDATE minimal_workstreams SET project_id = NULL, workspace_id = NULL").run();
    db.prepare("UPDATE session_memory_state SET project_id = NULL, workspace_id = NULL").run();
    db.prepare("UPDATE checkpoints SET workspace_id = NULL").run();
    db.prepare("UPDATE work_capsules SET source_workspace_id = NULL, source_session_id = NULL").run();
    db.prepare("DELETE FROM workspaces").run();
    db.prepare("DELETE FROM projects").run();

    ensureContinuitySchema(db);
    ensureContinuitySchema(db);

    const migrated = db.prepare(`
      SELECT e.project_id, e.workspace_id, s.workstream_id,
             f.project_id AS fact_project_id, f.subject_key,
             r.project_id AS recall_project_id, r.fact_ids,
             c.workspace_id AS checkpoint_workspace_id,
             w.source_exchange_ids_json, w.through_checkpoint_id
      FROM exchanges e
      JOIN session_memory_state s ON s.session_id = e.session_id
      JOIN facts f ON f.id = ?
      JOIN recall_events r ON r.id = ?
      JOIN checkpoints c ON c.checkpoint_id = 'legacy-checkpoint'
      JOIN work_capsules w ON w.workstream_id = s.workstream_id
      WHERE e.id = 'legacy-ex'
    `).get(factId, recallId) as Record<string, unknown>;
    expect(migrated.project_id).toBeTruthy();
    expect(migrated.workspace_id).toBeTruthy();
    expect(migrated.fact_project_id).toBe(migrated.project_id);
    expect(migrated.recall_project_id).toBe(migrated.project_id);
    expect(migrated.checkpoint_workspace_id).toBe(migrated.workspace_id);
    expect(migrated.subject_key).toBe(`legacy.fact.${factId}`);
    expect(migrated.fact_ids).toBe(JSON.stringify([factId]));
    expect(migrated.source_exchange_ids_json).toBe('["legacy-ex"]');
    expect(migrated.through_checkpoint_id).toBe("legacy-checkpoint");
    expect(searchFactsByScope(db, emb, { type: "project", project: cwd }, 10, 0)
      .map((row) => row.fact.id)).toContain(factId);
  });

  it("upgrades a released Phase 2-shaped database transactionally and reruns", () => {
    const cwd = path.join(root, "released-v3");
    const state = ensureSessionMemoryState(db, { sessionId: "released-session", project: cwd });
    insertExchange(db, exchange("released-ex", "released-session", cwd), emb);
    const factId = insertFact(db, {
      fact: "released truth", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: ["released-ex"], embedding: null,
    });
    const recallId = recordRecallEvent(db, {
      sessionId: "released-session", project: cwd, prompt: "released", factIds: [factId],
    });
    createCheckpointWithJob(db, {
      checkpoint: { checkpointId: "released-cp", sessionId: "released-session", workstreamId: state.workstreamId, workspaceId: state.workspaceId, ordinal: 1, kind: "stop", idempotencyKey: "released-cp" },
      job: { kind: "capture_index", partitionKey: "session:released-session", policyVersion: "continuity-capture-v1", priority: 100, idempotencyKey: "released-job" },
    });
    db.prepare("INSERT INTO work_capsules(workstream_id, generation, objective, through_checkpoint_id, updated_at) VALUES (?, 1, 'released objective', 'released-cp', ?)")
      .run(state.workstreamId, "2026-09-03T00:00:00.000Z");
    db.exec(`
      DROP TRIGGER IF EXISTS facts_project_revision_insert;
      DROP TRIGGER IF EXISTS facts_project_revision_semantic;
      DROP TRIGGER IF EXISTS facts_project_revision_move_old;
      DROP TRIGGER IF EXISTS facts_project_revision_delete;
      DROP TRIGGER IF EXISTS ontology_relations_scope_insert_guard;
      DROP TRIGGER IF EXISTS ontology_relations_scope_update_guard;
      DROP INDEX IF EXISTS idx_facts_project_subject;
      DROP INDEX IF EXISTS idx_facts_active_subject_slot;
      DROP INDEX IF EXISTS idx_workspaces_project;
      DROP INDEX IF EXISTS idx_workspaces_common_dir;
      DROP INDEX IF EXISTS idx_workspaces_git_identity;
      DROP INDEX IF EXISTS idx_workstreams_scope;
      DROP INDEX IF EXISTS idx_hot_evidence_scope;
      DROP TABLE hot_evidence;
      DROP TABLE workstream_sessions;
      DROP TABLE project_identity_audit;
      DROP TABLE approved_remote_mappings;
      DROP TABLE workspaces;
      DROP TABLE projects;
      ALTER TABLE exchanges DROP COLUMN project_id;
      ALTER TABLE exchanges DROP COLUMN workspace_id;
      ALTER TABLE exchanges DROP COLUMN workstream_id;
      ALTER TABLE facts DROP COLUMN project_id;
      ALTER TABLE facts DROP COLUMN workspace_id;
      ALTER TABLE facts DROP COLUMN workstream_id;
      ALTER TABLE facts DROP COLUMN subject_key;
      ALTER TABLE facts DROP COLUMN promotion_state;
      ALTER TABLE recall_events DROP COLUMN project_id;
      ALTER TABLE recall_events DROP COLUMN workspace_id;
      ALTER TABLE recall_events DROP COLUMN workstream_id;
      ALTER TABLE recall_events DROP COLUMN context_epoch;
      ALTER TABLE recall_events DROP COLUMN project_memory_revision;
      ALTER TABLE minimal_workstreams DROP COLUMN project_id;
      ALTER TABLE minimal_workstreams DROP COLUMN workspace_id;
      ALTER TABLE minimal_workstreams DROP COLUMN status;
      ALTER TABLE minimal_workstreams DROP COLUMN topic_fingerprint;
      ALTER TABLE session_memory_state DROP COLUMN project_id;
      ALTER TABLE session_memory_state DROP COLUMN workspace_id;
      ALTER TABLE session_memory_state DROP COLUMN binding_reason;
      ALTER TABLE session_memory_state DROP COLUMN binding_confidence;
      ALTER TABLE work_capsules DROP COLUMN source_workspace_id;
      ALTER TABLE work_capsules DROP COLUMN source_session_id;
      PRAGMA user_version = 3;
    `);
    const before = {
      exchanges: db.prepare("SELECT COUNT(*) AS n FROM exchanges").get(),
      facts: db.prepare("SELECT COUNT(*) AS n FROM facts").get(),
      recalls: db.prepare("SELECT COUNT(*) AS n FROM recall_events").get(),
      checkpoints: db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get(),
      capsules: db.prepare("SELECT COUNT(*) AS n FROM work_capsules").get(),
    };
    ensureContinuitySchema(db);
    ensureContinuitySchema(db);
    expect({
      exchanges: db.prepare("SELECT COUNT(*) AS n FROM exchanges").get(),
      facts: db.prepare("SELECT COUNT(*) AS n FROM facts").get(),
      recalls: db.prepare("SELECT COUNT(*) AS n FROM recall_events").get(),
      checkpoints: db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get(),
      capsules: db.prepare("SELECT COUNT(*) AS n FROM work_capsules").get(),
    }).toEqual(before);
    expect(db.prepare(`
      SELECT e.project_id, e.workspace_id, f.project_id AS fact_project,
             r.project_id AS recall_project, c.workspace_id AS checkpoint_workspace,
             w.source_exchange_ids_json
      FROM exchanges e JOIN facts f ON f.id = ? JOIN recall_events r ON r.id = ?
      JOIN checkpoints c ON c.checkpoint_id = 'released-cp'
      JOIN work_capsules w ON w.workstream_id = ?
      WHERE e.id = 'released-ex'
    `).get(factId, recallId, state.workstreamId)).toMatchObject({
      project_id: expect.any(String), workspace_id: expect.any(String),
      fact_project: expect.any(String), recall_project: expect.any(String),
      checkpoint_workspace: expect.any(String), source_exchange_ids_json: "[]",
    });
  });
});

describe("conservative workstream binding and scoped truth", () => {
  it("resumes exactly, honors explicit binding, and never picks an unrelated latest session", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    const wsA = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-a", workstreamId: "stream-a", branch: "main", topic: "sqlite cache" });
    createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-b", workstreamId: "stream-b", branch: "main", topic: "redis queue" });
    const explicit = bindSessionWorkstream(db, { sessionId: "session-a", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, explicitWorkstreamId: wsA });
    expect(explicit.reason).toBe("explicit");
    expect(bindSessionWorkstream(db, { sessionId: "session-a", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath }).workstreamId).toBe(wsA);
    const ambiguous = bindSessionWorkstream(db, { sessionId: "session-new", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, branch: "main" });
    expect(ambiguous.reason).toBe("session-local");
    expect(ambiguous.workstreamId).not.toBe("stream-b");
  });

  it("uses a strong deterministic topic margin and supports explicit rebind", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    for (const [id, topic] of [["sqlite-stream", "sqlite durable cache"], ["redis-stream", "redis background queue"]]) {
      createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: `owner-${id}`, workstreamId: id, topic });
      db.prepare("INSERT INTO work_capsules(workstream_id, objective, current_state, updated_at) VALUES (?, ?, '', ?)")
        .run(id, topic, "2026-09-03T00:00:00.000Z");
    }
    const bound = bindSessionWorkstream(db, { sessionId: "topic-session", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, prompt: "continue sqlite durable cache" });
    expect(bound.workstreamId).toBe("sqlite-stream");
    expect(bound.reason).toBe("strong-topic-margin");
    rebindSessionWorkstream(db, { sessionId: "topic-session", workstreamId: "redis-stream" });
    expect((db.prepare("SELECT workstream_id FROM session_memory_state WHERE session_id = 'topic-session'").get() as { workstream_id: string }).workstream_id).toBe("redis-stream");
  });

  it("shares one Capsule across A/C but never injects its blocker into workstream B", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    const a = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-a", workstreamId: "capsule-a" });
    const b = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-b", workstreamId: "capsule-b" });
    bindSessionWorkstream(db, { sessionId: "session-a", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, explicitWorkstreamId: a });
    bindSessionWorkstream(db, { sessionId: "session-c", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, explicitWorkstreamId: a });
    bindSessionWorkstream(db, { sessionId: "session-b", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, explicitWorkstreamId: b });
    db.prepare(`
      INSERT INTO work_capsules(workstream_id, generation, objective, current_state,
        verified_progress_json, blockers_json, updated_at)
      VALUES (?, 1, 'A objective', 'A verified progress', '[]', '["A-only blocker"]', ?)
    `).run(a, "2026-09-03T00:00:00.000Z");
    db.prepare(`
      INSERT INTO work_capsules(workstream_id, generation, objective, current_state, updated_at)
      VALUES (?, 1, 'B objective', 'B state', ?)
    `).run(b, "2026-09-03T00:00:00.000Z");
    expect(buildRehydrationContext(db, { sessionId: "session-c" }).context).toContain("A-only blocker");
    const bContext = buildRehydrationContext(db, { sessionId: "session-b" }).context;
    expect(bContext).toContain("B objective");
    expect(bContext).not.toContain("A-only blocker");
  });

  it("keeps experimental workstream facts out of project-current retrieval", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    ensureSessionMemoryState(db, { sessionId: "feature-session", project: identity.canonicalPath });
    insertExchange(db, exchange("feature-ex", "feature-session", identity.canonicalPath, "Redis experiment passed locally"), emb);
    const experimental = insertFact(db, { fact: "Redis is running in the feature worktree", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: ["feature-ex"], embedding: emb });
    const current = insertFact(db, { fact: "Main uses MySQL", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: emb, project_id: identity.projectId, promotion_state: "project-current", promotion_evidence: "validated", subject_key: "state.main.runtime.session_store" });
    expect(searchFactsByScope(db, emb, { type: "project-id", projectId: identity.projectId }, 10, 0).map((r) => r.fact.id)).toEqual([current]);
    expect(searchFactsByScope(db, emb, { type: "workstream-id", projectId: identity.projectId, workstreamId: (db.prepare("SELECT workstream_id FROM session_memory_state WHERE session_id = 'feature-session'").get() as { workstream_id: string }).workstream_id }, 10, 0).map((r) => r.fact.id)).toContain(experimental);
  });

  it("rejects low-level project-current promotion without merged or validated evidence", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    expect(() => insertFact(db, {
      fact: "Unmerged feature says Redis", category: "knowledge", scope_type: "project",
      scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: null,
      project_id: identity.projectId, promotion_state: "project-current",
      subject_key: "state.main.cache",
    })).toThrow("merged or validated evidence");
    expect(db.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 0 });
  });

  it("enforces subject slots and increments project revision only for meaningful current truth", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    const fact = insertFact(db, { fact: "Main uses MySQL", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: null, project_id: identity.projectId, promotion_state: "project-current", promotion_evidence: "validated", subject_key: "state.main.runtime.session_store" });
    const afterInsert = projectRevision(db, identity.projectId);
    db.prepare("UPDATE facts SET fact_kr = '메인은 MySQL 사용' WHERE id = ?").run(fact);
    expect(projectRevision(db, identity.projectId)).toBe(afterInsert);
    db.prepare("UPDATE facts SET fact = ?, semantic_generation = semantic_generation + 1, updated_at = ? WHERE id = ?").run("Main uses PostgreSQL", "2026-09-03T01:00:00.000Z", fact);
    expect(projectRevision(db, identity.projectId)).toBe(afterInsert + 1);
    const conflicting = insertFact(db, { fact: "another", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: null, project_id: identity.projectId });
    expect(() => assignFactSubject(db, { factId: conflicting, projectId: identity.projectId, subjectKey: "state.main.runtime.session_store", promotionState: "project-current", evidence: "validated" })).toThrow("slot already");
    const beforeNoop = projectRevision(db, identity.projectId);
    assignFactSubject(db, {
      factId: fact, projectId: identity.projectId,
      subjectKey: "state.main.runtime.session_store",
      promotionState: "project-current", evidence: "validated",
    });
    expect(projectRevision(db, identity.projectId)).toBe(beforeNoop);
  });

  it("increments lifecycle generation so low-level deactivation becomes a correction", () => {
    const session = ensureSessionMemoryState(db, { sessionId: "deactivate-session", project: path.join(root, "repo") });
    const factId = insertFact(db, {
      fact: "Current state", category: "knowledge", scope_type: "project",
      scope_project: path.join(root, "repo"), source_exchange_ids: [], embedding: null,
      project_id: session.projectId, promotion_state: "project-current", promotion_evidence: "validated", subject_key: "state.current",
    });
    const before = db.prepare("SELECT semantic_generation, lifecycle_generation FROM facts WHERE id = ?").get(factId) as { semantic_generation: number; lifecycle_generation: number };
    recordResidentFactRevisions(db, "deactivate-session", 0, [[factId, before.semantic_generation, before.lifecycle_generation]]);
    db.prepare("UPDATE session_memory_state SET memory_revision_seen = ? WHERE session_id = ?")
      .run(projectRevision(db, session.projectId), "deactivate-session");
    deactivateFact(db, factId);
    const correction = buildRehydrationContext(db, { sessionId: "deactivate-session" });
    expect(correction.context).toContain("No longer active: Current state");
    expect(correction.factRevisions).toContainEqual([factId, before.semantic_generation, before.lifecycle_generation + 1]);
  });

  it("keeps relation expansion inside the stable workstream scope", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    const streamA = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-a", workstreamId: "scope-a" });
    const streamB = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-b", workstreamId: "scope-b" });
    const a = insertFact(db, { fact: "A fact", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: null, project_id: identity.projectId, workspace_id: identity.workspaceId, workstream_id: streamA, subject_key: "workstream.a", promotion_state: "workstream", promotion_evidence: "experimental" });
    const b = insertFact(db, { fact: "B secret", category: "knowledge", scope_type: "project", scope_project: identity.canonicalPath, source_exchange_ids: [], embedding: null, project_id: identity.projectId, workspace_id: identity.workspaceId, workstream_id: streamB, subject_key: "workstream.b", promotion_state: "workstream", promotion_evidence: "experimental" });
    createRelation(db, a, "SUPPORTS", b);
    const related = getRelatedFacts(db, a, 1, 0.6, 0.2, null, "project", {
      type: "workstream-id", projectId: identity.projectId, workspaceId: identity.workspaceId, workstreamId: streamA,
    });
    expect(related.map((row) => row.fact.id)).not.toContain(b);
  });

  it("turns a sibling current-fact evolution into a next-boundary correction candidate", () => {
    const cwd = path.join(root, "repo");
    const sibling = ensureSessionMemoryState(db, { sessionId: "sibling-a", project: cwd });
    ensureSessionMemoryState(db, { sessionId: "stale-c", project: cwd });
    insertFact(db, {
      fact: "Validated main state is PostgreSQL", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: [], embedding: null,
      project_id: sibling.projectId, promotion_state: "project-current", promotion_evidence: "validated", subject_key: "state.main.database",
    });
    const correction = buildRehydrationContext(db, { sessionId: "stale-c" });
    expect(correction.context).toContain("[MEMEX CORRECTION]");
    expect(correction.context).toContain("Validated main state is PostgreSQL");
  });

  it("emits an explicit correction when a resident current fact becomes inactive", () => {
    const cwd = path.join(root, "repo");
    const session = ensureSessionMemoryState(db, { sessionId: "stale-inactive", project: cwd });
    const factId = insertFact(db, {
      fact: "Main uses MySQL", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: [], embedding: null,
      project_id: session.projectId, promotion_state: "project-current", promotion_evidence: "validated",
      subject_key: "state.main.database",
    });
    const row = db.prepare("SELECT semantic_generation, lifecycle_generation FROM facts WHERE id = ?")
      .get(factId) as { semantic_generation: number; lifecycle_generation: number };
    db.prepare(`
      UPDATE session_memory_state
      SET resident_fact_revisions_json = ?, memory_revision_seen = ?
      WHERE session_id = ?
    `).run(JSON.stringify([[factId, row.semantic_generation, row.lifecycle_generation]]), projectRevision(db, session.projectId), "stale-inactive");
    db.prepare(`
      UPDATE facts SET is_active = 0, lifecycle_generation = lifecycle_generation + 1,
        lifecycle_updated_at = ?, updated_at = ? WHERE id = ?
    `).run("2026-09-03T02:00:00.000Z", "2026-09-03T02:00:00.000Z", factId);
    const correction = buildRehydrationContext(db, { sessionId: "stale-inactive" });
    expect(correction.context).toContain("[MEMEX CORRECTION]");
    expect(correction.context).toContain("No longer active: Main uses MySQL");
    expect(correction.factRevisions).toContainEqual([
      factId,
      row.semantic_generation,
      row.lifecycle_generation + 1,
    ]);
  });

  it("does not complete a project revision until every bounded correction is emitted", () => {
    const cwd = path.join(root, "repo");
    const session = ensureSessionMemoryState(db, { sessionId: "bounded-corrections", project: cwd });
    for (let index = 0; index < 6; index++) {
      insertFact(db, {
        fact: `Current truth ${index}: ${"bounded correction text ".repeat(16)}`,
        category: "knowledge",
        scope_type: "project",
        scope_project: cwd,
        source_exchange_ids: [],
        embedding: null,
        project_id: session.projectId,
        promotion_state: "project-current", promotion_evidence: "validated",
        subject_key: `state.main.bounded_${index}`,
      });
    }
    const observed = new Set<string>();
    let complete = false;
    for (let boundary = 0; boundary < 10 && !complete; boundary++) {
      const result = buildRehydrationContext(db, {
        sessionId: "bounded-corrections",
        maxChars: 500,
      });
      for (const [factId] of result.factRevisions) observed.add(factId);
      const epoch = readResidentFactRevisions(db, "bounded-corrections").contextEpoch;
      expect(recordResidentFactRevisions(
        db,
        "bounded-corrections",
        epoch,
        result.factRevisions,
      )).toBe(true);
      complete = result.projectRevisionComplete;
      if (observed.size < 6) expect(complete).toBe(false);
    }
    expect(observed.size).toBe(6);
    expect(complete).toBe(true);
  });

  it("does not mark a newer concurrent project revision seen from an older rehydration snapshot", () => {
    const cwd = path.join(root, "revision-race");
    const session = ensureSessionMemoryState(db, { sessionId: "revision-race-session", project: cwd });
    insertFact(db, {
      fact: "first current truth", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: [], embedding: null,
      project_id: session.projectId, promotion_state: "project-current", promotion_evidence: "validated",
      subject_key: "state.race.first",
    });
    const snapshot = buildRehydrationContext(db, { sessionId: "revision-race-session" });
    insertFact(db, {
      fact: "concurrent current truth", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: [], embedding: null,
      project_id: session.projectId, promotion_state: "project-current", promotion_evidence: "validated",
      subject_key: "state.race.second",
    });
    expect(markSessionProjectRevisionSeen(
      db,
      "revision-race-session",
      snapshot.projectMemoryRevision,
    )).toBe(false);
  });

  it("rolls back rehydration residency when the project revision changes at commit", () => {
    const cwd = path.join(root, "rehydration-commit-race");
    const session = ensureSessionMemoryState(db, { sessionId: "rehydration-race-session", project: cwd });
    insertFact(db, {
      fact: "race current truth", category: "knowledge", scope_type: "project",
      scope_project: cwd, source_exchange_ids: [], embedding: null,
      project_id: session.projectId, promotion_state: "project-current", promotion_evidence: "validated",
      subject_key: "state.rehydration.race",
    });
    db.exec(`
      CREATE TRIGGER inject_rehydration_revision_race
      AFTER UPDATE OF resident_fact_revisions_json ON session_memory_state
      BEGIN
        UPDATE projects SET memory_revision = memory_revision + 1 WHERE project_id = NEW.project_id;
      END;
    `);
    expect(() => handleContinuityHook({
      hook_event_name: "SessionStart", session_id: "rehydration-race-session",
      cwd, source: "resume",
    }, { db })).toThrow("project memory revision changed");
    expect(readResidentFactRevisions(db, "rehydration-race-session").resident).toEqual([]);
  });
});

describe("memory lanes and privacy", () => {
  it("indexes only human/trusted tool evidence with TTL and an explicit lane label", () => {
    const cwd = path.join(root, "repo");
    ensureSessionMemoryState(db, { sessionId: "hot-session", project: cwd });
    const ex = exchange("hot-ex", "hot-session", cwd, "P95 is 240ms in the trusted benchmark");
    ex.toolCalls = [
      { id: "trusted-tool", exchangeId: "hot-ex", toolName: "exec_command", toolInput: { cmd: "npm test" }, toolResult: "754 tests passed", isError: false, timestamp: ex.timestamp, sourceType: "test_execution", learnable: true },
      { id: "untrusted-tool", exchangeId: "hot-ex", toolName: "web", toolInput: {}, toolResult: "someone said 1ms", isError: false, timestamp: ex.timestamp, sourceType: "external_unverified", learnable: false },
    ];
    insertExchange(db, ex, emb);
    expect(indexHotEvidenceForSession(db, "hot-session", { now: "2026-09-03T00:00:00.000Z", ttlDays: 2 })).toBe(2);
    const scope = db.prepare("SELECT project_id, workstream_id FROM session_memory_state WHERE session_id = 'hot-session'").get() as { project_id: string; workstream_id: string };
    const hot = readHotEvidence(db, { projectId: scope.project_id, workstreamId: scope.workstream_id, now: "2026-09-04T00:00:00.000Z" });
    expect(hot).toHaveLength(2);
    expect(hot.every((row) => row.lane === "HOT EVIDENCE — NOT YET DISTILLED" && row.authority === "hot-evidence")).toBe(true);
    const firstPage = readHotEvidence(db, {
      projectId: scope.project_id,
      workstreamId: scope.workstream_id,
      now: "2026-09-04T00:00:00.000Z",
      limit: 1,
    });
    const secondPage = readHotEvidence(db, {
      projectId: scope.project_id,
      workstreamId: scope.workstream_id,
      now: "2026-09-04T00:00:00.000Z",
      beforeCreatedAt: String(firstPage[0].created_at),
      beforeEvidenceId: String(firstPage[0].evidence_id),
      limit: 1,
    });
    expect(new Set([firstPage[0].evidence_id, secondPage[0].evidence_id]).size).toBe(2);
    expect(readHotEvidence(db, { projectId: scope.project_id, now: "2026-09-06T00:00:00.000Z" })).toHaveLength(0);
  });

  it("moves already indexed Hot Evidence on explicit session rebind", () => {
    const identity = resolveProjectWorkspace(db, { cwd: path.join(root, "repo") });
    const first = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-a", workstreamId: "hot-a" });
    const second = createWorkstream(db, { projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, ownerSessionId: "owner-b", workstreamId: "hot-b" });
    bindSessionWorkstream(db, { sessionId: "hot-rebind", projectId: identity.projectId, workspaceId: identity.workspaceId, projectPath: identity.canonicalPath, explicitWorkstreamId: first });
    insertExchange(db, exchange("hot-rebind-ex", "hot-rebind", identity.canonicalPath, "move this evidence"), emb);
    indexHotEvidenceForSession(db, "hot-rebind");
    rebindSessionWorkstream(db, { sessionId: "hot-rebind", workstreamId: second });
    expect(db.prepare("SELECT DISTINCT workstream_id FROM hot_evidence WHERE session_id = ?").all("hot-rebind"))
      .toEqual([{ workstream_id: second }]);
  });

  it("purges one session without deleting a Capsule shared by a sibling session", () => {
    const cwd = path.join(root, "repo");
    const first = ensureSessionMemoryState(db, { sessionId: "shared-a", project: cwd });
    bindSessionWorkstream(db, { sessionId: "shared-b", projectId: first.projectId, workspaceId: first.workspaceId, projectPath: cwd, explicitWorkstreamId: first.workstreamId });
    db.prepare("INSERT INTO work_capsules(workstream_id, objective, current_state, updated_at) VALUES (?, 'shared objective', '', ?)").run(first.workstreamId, "2026-09-03T00:00:00.000Z");
    insertExchange(db, exchange("shared-ex", "shared-a", cwd), emb);
    purgeConversationFromIndex(db, { archivePath: path.join(root, "shared-a.jsonl"), sessionId: "shared-a" });
    expect(db.prepare("SELECT objective FROM work_capsules WHERE workstream_id = ?").get(first.workstreamId)).toEqual({ objective: "shared objective" });
    expect(db.prepare("SELECT workstream_id FROM session_memory_state WHERE session_id = 'shared-b'").get()).toEqual({ workstream_id: first.workstreamId });
    expect(db.prepare("SELECT 1 FROM hot_evidence WHERE session_id = 'shared-a'").get()).toBeUndefined();
  });

  it("removes orphan identity rows even when legacy session state is already missing", () => {
    const cwd = path.join(root, "legacy-purge");
    const session = ensureSessionMemoryState(db, { sessionId: "legacy-purge-session", project: cwd });
    insertExchange(db, exchange("legacy-purge-ex", "legacy-purge-session", cwd), emb);
    db.prepare("DELETE FROM minimal_workstreams WHERE workstream_id = ?").run(session.workstreamId);
    expect(db.prepare("SELECT 1 FROM session_memory_state WHERE session_id = ?").get("legacy-purge-session")).toBeUndefined();
    purgeConversationFromIndex(db, {
      archivePath: path.join(root, "legacy-purge-session.jsonl"),
      sessionId: "legacy-purge-session",
    });
    expect(db.prepare("SELECT 1 FROM workspaces WHERE workspace_id = ?").get(session.workspaceId)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM projects WHERE project_id = ?").get(session.projectId)).toBeUndefined();
  });
});
