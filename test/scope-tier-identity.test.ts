/**
 * 0.6.0 scope model — branch capture propagation (#16).
 *
 * Reproduces the observed v0.5.2 state: `workspaces.branch` was captured at
 * session start but never reached `exchanges.git_branch` or the workstream
 * `branch_hint`, so every session minted `ws-<hash(project, session)>` and the
 * same project's sessions split across five streams.
 */
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

import { initDatabase, insertExchange } from "../src/db.js";
import {
  approveRemoteProjectMapping,
  branchSignalFor,
  deterministicWorkstreamId,
  inspectWorkspaceLocation,
  resolveProjectWorkspace,
} from "../src/continuity-identity.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { insertFact } from "../src/fact-db.js";
import { saveExtractedFacts } from "../src/fact-extractor.js";
import { applyTierMigration, listTierMigrationCandidates } from "../src/fact-management.js";
import type { ConversationExchange } from "../src/types.js";

let root: string;
let db: Database.Database;

function gitClone(dir: string, branch = "main", remote = "git@example.test:team/repo.git"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
}

function gitWorktree(commonRoot: string, dir: string, name: string, branch: string): void {
  const gitDir = path.join(commonRoot, ".git", "worktrees", name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
}

function setOriginHead(dir: string, branch: string): void {
  const head = path.join(dir, ".git", "refs", "remotes", "origin");
  fs.mkdirSync(head, { recursive: true });
  fs.writeFileSync(path.join(head, "HEAD"), `ref: refs/remotes/origin/${branch}\n`);
}

function exchange(id: string, sessionId: string, cwd: string): ConversationExchange {
  return {
    id, project: cwd, cwd, timestamp: "2026-09-03T00:00:00.000Z",
    userMessage: "Use SQLite for the cache", assistantMessage: "context only",
    archivePath: path.join(root, `${sessionId}.jsonl`),
    lineStart: 1, lineEnd: 2, sessionId, closureState: "closed", parserVersion: 2,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-scope-tier-"));
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

describe("branch signal", () => {
  it("treats a missing branch, the conventional default and origin/HEAD as no branch tier", () => {
    expect(branchSignalFor({ branch: null })).toMatchObject({ kind: "none", tierReason: "no-branch-signal" });
    expect(branchSignalFor({ branch: "main" })).toMatchObject({ kind: "default", tierReason: "default-branch" });
    expect(branchSignalFor({ branch: "master" })).toMatchObject({ kind: "default", tierReason: "default-branch" });
    expect(branchSignalFor({ branch: "feature/x" })).toMatchObject({ kind: "branch", tierReason: "branch:feature/x" });
    // origin/HEAD wins over the conventional names.
    expect(branchSignalFor({ branch: "develop", defaultBranch: "develop" })).toMatchObject({ kind: "default" });
    expect(branchSignalFor({ branch: "main", defaultBranch: "develop" })).toMatchObject({ kind: "branch" });
  });

  it("reads the repository default branch from origin/HEAD", () => {
    const repo = path.join(root, "origin-head");
    gitClone(repo, "release");
    setOriginHead(repo, "release");
    expect(inspectWorkspaceLocation(repo)).toMatchObject({ branch: "release", defaultBranch: "release" });
    const identity = resolveProjectWorkspace(db, { cwd: repo });
    expect(identity.defaultBranch).toBe("release");
    expect((db.prepare("SELECT default_branch FROM workspaces WHERE workspace_id = ?")
      .get(identity.workspaceId) as { default_branch: string }).default_branch).toBe("release");
  });
});

describe("deterministic workstream binding (#16)", () => {
  it("keeps three no-branch sessions of one project on a single default stream", () => {
    const project = path.join(root, "plain-project");
    fs.mkdirSync(project, { recursive: true });
    const bound = ["s1", "s2", "s3"].map((sessionId) =>
      ensureSessionMemoryState(db, { sessionId, project }).workstreamId);
    expect(new Set(bound).size).toBe(1);
    const identity = resolveProjectWorkspace(db, { cwd: project });
    expect(bound[0]).toBe(deterministicWorkstreamId(identity.projectId, null));
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM minimal_workstreams WHERE project_id = ?",
    ).get(identity.projectId) as { n: number }).n).toBe(1);
  });

  it("keeps default-branch git sessions on the same project-common stream", () => {
    const repo = path.join(root, "default-branch-repo");
    gitClone(repo, "main");
    const first = ensureSessionMemoryState(db, { sessionId: "g1", project: repo }).workstreamId;
    const second = ensureSessionMemoryState(db, { sessionId: "g2", project: repo }).workstreamId;
    expect(second).toBe(first);
    expect((db.prepare("SELECT branch_hint FROM minimal_workstreams WHERE workstream_id = ?")
      .get(first) as { branch_hint: string }).branch_hint).toBe("main");
  });

  it("splits branch A and branch B into two workstreams", () => {
    const repo = path.join(root, "branchy");
    gitClone(repo, "feature/a");
    const a = ensureSessionMemoryState(db, { sessionId: "a1", project: repo }).workstreamId;
    gitClone(repo, "feature/b");
    const b = ensureSessionMemoryState(db, { sessionId: "b1", project: repo }).workstreamId;
    expect(a).not.toBe(b);
    const identity = resolveProjectWorkspace(db, { cwd: repo });
    expect(a).toBe(deterministicWorkstreamId(identity.projectId, "feature/a"));
    expect(b).toBe(deterministicWorkstreamId(identity.projectId, "feature/b"));
  });

  it("shares one workstream between two worktrees of the same repo on the same branch", () => {
    const common = path.join(root, "wt-common");
    gitClone(common, "main");
    const one = path.join(root, "wt-one");
    const two = path.join(root, "wt-two");
    gitWorktree(common, one, "one", "feature/shared");
    gitWorktree(common, two, "two", "feature/shared");
    const first = ensureSessionMemoryState(db, { sessionId: "w1", project: one });
    const second = ensureSessionMemoryState(db, { sessionId: "w2", project: two });
    expect(second.projectId).toBe(first.projectId);
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(second.workstreamId).toBe(first.workstreamId);
  });
});

describe("exchange branch propagation (#16)", () => {
  it("stamps git_branch from the captured workspace branch when the host reports none", async () => {
    const repo = path.join(root, "captured-branch");
    gitClone(repo, "feature/capture");
    ensureSessionMemoryState(db, { sessionId: "cap-1", project: repo });
    await insertExchange(db, exchange("ex-cap-1", "cap-1", repo), new Array(384).fill(0.1));
    expect((db.prepare("SELECT git_branch FROM exchanges WHERE id = 'ex-cap-1'")
      .get() as { git_branch: string | null }).git_branch).toBe("feature/capture");
  });

  it("leaves git_branch null for a non-git project", async () => {
    const project = path.join(root, "no-git");
    fs.mkdirSync(project, { recursive: true });
    ensureSessionMemoryState(db, { sessionId: "plain-1", project });
    await insertExchange(db, exchange("ex-plain-1", "plain-1", project), new Array(384).fill(0.1));
    expect((db.prepare("SELECT git_branch FROM exchanges WHERE id = 'ex-plain-1'")
      .get() as { git_branch: string | null }).git_branch).toBeNull();
  });
});

/**
 * #21 — the observed state was 12 of 13 real workspaces still recorded as
 * `directory` because nothing updated the row after `git init`, so a later
 * worktree could not be matched by the git-common-dir rule and would split
 * into a separate project.
 */
describe("workspace location transition (#21)", () => {
  function events(workspaceId: string): Array<Record<string, unknown>> {
    return db.prepare(
      "SELECT * FROM workspace_location_events WHERE workspace_id = ? ORDER BY created_at, event_id",
    ).all(workspaceId) as Array<Record<string, unknown>>;
  }

  it("keeps workspace_id and project_id across a directory → clone transition and records one event", () => {
    const project = path.join(root, "transition");
    fs.mkdirSync(project, { recursive: true });
    const before = ensureSessionMemoryState(db, { sessionId: "t-1", project });
    expect((db.prepare("SELECT location_kind FROM workspaces WHERE workspace_id = ?")
      .get(before.workspaceId) as { location_kind: string }).location_kind).toBe("directory");
    expect(events(before.workspaceId)).toHaveLength(0);

    gitClone(project, "main");
    const after = ensureSessionMemoryState(db, { sessionId: "t-2", project });
    expect(after.workspaceId).toBe(before.workspaceId);
    expect(after.projectId).toBe(before.projectId);
    const row = db.prepare(
      "SELECT location_kind, git_common_dir, git_common_identity, remote_fingerprint, branch FROM workspaces WHERE workspace_id = ?",
    ).get(before.workspaceId) as Record<string, unknown>;
    expect(row.location_kind).toBe("clone");
    expect(row.git_common_dir).toBeTruthy();
    expect(row.git_common_identity).toBeTruthy();
    expect(row.remote_fingerprint).toBeTruthy();
    expect(row.branch).toBe("main");

    const recorded = events(before.workspaceId);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      event_kind: "WORKSPACE_LOCATION_CHANGED",
      from_location_kind: "directory",
      to_location_kind: "clone",
      requires_approval: 0,
    });
    // Re-running the same session start does not duplicate the transition.
    ensureSessionMemoryState(db, { sessionId: "t-3", project });
    expect(events(before.workspaceId)).toHaveLength(1);
  });

  it("adds a worktree as a second workspace of the same project", () => {
    const project = path.join(root, "wt-transition");
    fs.mkdirSync(project, { recursive: true });
    const before = ensureSessionMemoryState(db, { sessionId: "wt-0", project });
    gitClone(project, "main");
    ensureSessionMemoryState(db, { sessionId: "wt-1", project });

    const worktree = path.join(root, "wt-transition-feature");
    gitWorktree(project, worktree, "feature", "feature/x");
    const added = ensureSessionMemoryState(db, { sessionId: "wt-2", project: worktree });
    expect(added.projectId).toBe(before.projectId);
    expect(added.workspaceId).not.toBe(before.workspaceId);
    expect((db.prepare("SELECT location_kind FROM workspaces WHERE workspace_id = ?")
      .get(added.workspaceId) as { location_kind: string }).location_kind).toBe("worktree");
  });

  it("requires explicit approval before the same remote cloned elsewhere joins the project", () => {
    const origin = path.join(root, "remote-a");
    gitClone(origin, "main");
    const first = ensureSessionMemoryState(db, { sessionId: "r-1", project: origin });

    const clone = path.join(root, "remote-b");
    gitClone(clone, "main");
    const second = ensureSessionMemoryState(db, { sessionId: "r-2", project: clone });
    // No auto-merge: a shared remote alone never links two paths.
    expect(second.projectId).not.toBe(first.projectId);
    const suggestion = db.prepare(`
      SELECT reason FROM project_identity_audit WHERE action = 'suggest' ORDER BY created_at DESC LIMIT 1
    `).get() as { reason: string } | undefined;
    expect(suggestion?.reason).toContain("approval");

    const fingerprint = (db.prepare("SELECT remote_fingerprint FROM workspaces WHERE workspace_id = ?")
      .get(first.workspaceId) as { remote_fingerprint: string }).remote_fingerprint;
    approveRemoteProjectMapping(db, first.projectId, fingerprint);
    const third = path.join(root, "remote-c");
    gitClone(third, "main");
    expect(resolveProjectWorkspace(db, { cwd: third })).toMatchObject({
      projectId: first.projectId, reason: "approved-remote",
    });
  });

  it("updates the row only when .git is removed and never demotes branch memory", async () => {
    const project = path.join(root, "reverse");
    gitClone(project, "feature/reverse");
    const state = ensureSessionMemoryState(db, { sessionId: "rev-1", project });
    await insertExchange(db, exchange("ex-rev-1", "rev-1", project), new Array(384).fill(0.1));
    const factId = insertFact(db, {
      fact: "Reverse transition keeps branch memory", category: "knowledge", scope_type: "project",
      scope_project: project, source_exchange_ids: ["ex-rev-1"], embedding: new Array(384).fill(0.1),
      subject_key: "state.reverse.memory",
    });
    expect(db.prepare("SELECT promotion_state FROM facts WHERE id = ?").get(factId))
      .toEqual({ promotion_state: "workstream" });

    fs.rmSync(path.join(project, ".git"), { recursive: true, force: true });
    const after = ensureSessionMemoryState(db, { sessionId: "rev-2", project });
    expect(after.workspaceId).toBe(state.workspaceId);
    expect(db.prepare(
      "SELECT location_kind, git_common_dir, remote_fingerprint, branch FROM workspaces WHERE workspace_id = ?",
    ).get(state.workspaceId)).toEqual({
      location_kind: "directory", git_common_dir: null, remote_fingerprint: null, branch: null,
    });
    // The branch-tier fact is left exactly where it was: no auto-demotion.
    expect(db.prepare("SELECT promotion_state, workstream_id FROM facts WHERE id = ?").get(factId))
      .toEqual({ promotion_state: "workstream", workstream_id: state.workstreamId });
    expect(events(state.workspaceId).at(-1)).toMatchObject({
      from_location_kind: "clone", to_location_kind: "directory",
    });
  });
});

/**
 * #18 — the observed state was 9 ict-indicator facts (a non-git directory)
 * stuck on `promotion_state='workstream'`, invisible to the project screen and
 * never injected into the next session of the same project.
 */
describe("default tier rule at extraction insert (#18)", () => {
  async function factFor(sessionId: string, project: string, branch?: string): Promise<Record<string, unknown>> {
    const state = ensureSessionMemoryState(db, { sessionId, project, branch });
    await insertExchange(db, exchange(`ex-${sessionId}`, sessionId, project), new Array(384).fill(0.1));
    const id = insertFact(db, {
      fact: `Session store decision from ${sessionId}`,
      category: "knowledge", scope_type: "project", scope_project: project,
      source_exchange_ids: [`ex-${sessionId}`], embedding: new Array(384).fill(0.1),
      subject_key: `state.runtime.store_${sessionId.replace(/-/g, "_")}`,
    });
    expect(state.workstreamId).toBeTruthy();
    return db.prepare("SELECT promotion_state, tier_reason, workstream_id, workspace_id FROM facts WHERE id = ?")
      .get(id) as Record<string, unknown>;
  }

  it("writes a non-git session's fact as project-common with tier_reason no-branch-signal", async () => {
    const project = path.join(root, "tier-plain");
    fs.mkdirSync(project, { recursive: true });
    expect(await factFor("tier-plain-1", project)).toEqual({
      promotion_state: "project-current", tier_reason: "no-branch-signal",
      workstream_id: null, workspace_id: null,
    });
  });

  it("writes a default-branch session's fact as project-common with tier_reason default-branch", async () => {
    const repo = path.join(root, "tier-default");
    gitClone(repo, "main");
    expect(await factFor("tier-default-1", repo)).toEqual({
      promotion_state: "project-current", tier_reason: "default-branch",
      workstream_id: null, workspace_id: null,
    });
  });

  it("keeps a non-default-branch session's fact on the branch tier", async () => {
    const repo = path.join(root, "tier-branch");
    gitClone(repo, "feature/tier");
    const row = await factFor("tier-branch-1", repo);
    expect(row.promotion_state).toBe("workstream");
    expect(row.tier_reason).toBe("branch:feature/tier");
    expect(row.workstream_id).toBeTruthy();
  });

  it("records the tier decision on the ASSERTED Chronicle event", async () => {
    const project = path.join(root, "tier-chronicle");
    fs.mkdirSync(project, { recursive: true });
    ensureSessionMemoryState(db, { sessionId: "tier-ch-1", project });
    await insertExchange(db, exchange("ex-tier-ch-1", "tier-ch-1", project), new Array(384).fill(0.1));
    await saveExtractedFacts(
      db,
      [{
        fact: "Cache uses SQLite", category: "knowledge", scope_type: "project",
        subject_key: "state.runtime.cache", evidence: ["human_assertion"],
      }] as never,
      project,
      ["ex-tier-ch-1"],
    );
    const event = db.prepare(
      "SELECT event_kind, outcome_json FROM fact_revisions WHERE event_kind = 'ASSERTED' ORDER BY chronicle_seq DESC LIMIT 1",
    ).get() as { event_kind: string; outcome_json: string | null } | undefined;
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.outcome_json ?? "{}")).toMatchObject({
      tier: "project-current", tier_reason: "no-branch-signal",
    });
  });
});

describe("facts migrate-tiers (#18)", () => {
  it("lists pre-0.6.0 workstream facts with no branch signal and moves them only on apply", async () => {
    const project = path.join(root, "migrate-plain");
    fs.mkdirSync(project, { recursive: true });
    const branchRepo = path.join(root, "migrate-branch");
    gitClone(branchRepo, "feature/keep");

    const plain = ensureSessionMemoryState(db, { sessionId: "mig-plain", project });
    const branchy = ensureSessionMemoryState(db, { sessionId: "mig-branch", project: branchRepo });
    await insertExchange(db, exchange("ex-mig-plain", "mig-plain", project), new Array(384).fill(0.1));
    await insertExchange(db, exchange("ex-mig-branch", "mig-branch", branchRepo), new Array(384).fill(0.1));

    // Reproduce the legacy placement: everything on the workstream tier.
    const legacy = insertFact(db, {
      fact: "ict-indicator uses a single loader", category: "knowledge", scope_type: "project",
      scope_project: project, source_exchange_ids: ["ex-mig-plain"], embedding: new Array(384).fill(0.1),
      subject_key: "state.loader.mode", project_id: plain.projectId,
      workspace_id: plain.workspaceId, workstream_id: plain.workstreamId,
      promotion_state: "workstream", promotion_evidence: "experimental",
    });
    const keep = insertFact(db, {
      fact: "Branch experiment uses Redis", category: "knowledge", scope_type: "project",
      scope_project: branchRepo, source_exchange_ids: ["ex-mig-branch"], embedding: new Array(384).fill(0.1),
      subject_key: "state.branch.cache", project_id: branchy.projectId,
      workspace_id: branchy.workspaceId, workstream_id: branchy.workstreamId,
      promotion_state: "workstream", promotion_evidence: "experimental",
    });

    expect(listTierMigrationCandidates(db).map((c) => c.id)).toEqual([legacy]);
    // A dry run changes nothing.
    expect(db.prepare("SELECT promotion_state FROM facts WHERE id = ?").get(legacy))
      .toEqual({ promotion_state: "workstream" });

    const applied = applyTierMigration(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(applied).toEqual({ promoted: [legacy], skipped: [] });
    expect(db.prepare("SELECT promotion_state, tier_reason, workstream_id FROM facts WHERE id = ?").get(legacy))
      .toEqual({ promotion_state: "project-current", tier_reason: "no-branch-signal", workstream_id: null });
    expect(db.prepare("SELECT promotion_state FROM facts WHERE id = ?").get(keep))
      .toEqual({ promotion_state: "workstream" });
    const event = db.prepare(
      "SELECT event_kind, actor, outcome_json FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED'",
    ).get(legacy) as { event_kind: string; actor: string; outcome_json: string };
    expect(event.actor).toBe("migration");
    expect(JSON.parse(event.outcome_json)).toMatchObject({
      from_tier: "workstream", to_tier: "project-current", reason: "no-branch-signal",
    });
    // Idempotent: nothing is left to migrate.
    expect(listTierMigrationCandidates(db)).toEqual([]);
  });
});
