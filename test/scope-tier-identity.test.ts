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
  branchSignalFor,
  deterministicWorkstreamId,
  inspectWorkspaceLocation,
  resolveProjectWorkspace,
} from "../src/continuity-identity.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
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
