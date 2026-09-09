import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import { deleteExchange, initDatabase, insertExchange } from "../src/db.js";
import {
  insertFact,
  searchHumanSourceIdentifiersInScope,
  validateHumanSourceIdentifierEvidence,
} from "../src/fact-db.js";
import {
  bindSessionWorkstream,
  createWorkstream,
  resolveProjectWorkspace,
} from "../src/continuity-identity.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { computeInjectContext } from "../src/inject-core.js";
import type { ConversationExchange } from "../src/types.js";

vi.mock("../src/embeddings.js", () => ({
  EMBEDDING_VERSION: 2,
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.1),
  queryBaseline: async () => 0,
  embeddingCallStats: () => ({ modelCalls: 0, cacheHits: 0 }),
}));

let db: Database.Database;
let root: string;
let projectPath: string;
let projectId: string;
let workspaceId: string;
let workstreamId: string;

const embedding = new Array(384).fill(0.1);

function gitClone(dir: string, remote = "git@example.test:team/identifier-source.git"): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(
    path.join(dir, ".git", "config"),
    `[remote "origin"]\n\turl = ${remote}\n`,
  );
}

function gitWorktree(commonRoot: string, dir: string, name: string): void {
  const gitDir = path.join(commonRoot, ".git", "worktrees", name);
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${name}\n`);
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitDir}\n`);
}

function exchange(
  id: string,
  sessionId: string,
  cwd: string,
  userMessage: string,
  options: Partial<ConversationExchange> = {},
): ConversationExchange {
  return {
    id,
    project: cwd,
    cwd,
    timestamp: "2026-09-08T00:00:00.000Z",
    userMessage,
    assistantMessage: "assistant context must never be returned as raw evidence",
    archivePath: path.join(root, `${sessionId}.jsonl`),
    lineStart: 10,
    lineEnd: 14,
    sessionId,
    closureState: "closed",
    parserVersion: 2,
    ...options,
  };
}

function currentScope() {
  return {
    type: "workstream-id" as const,
    projectId,
    workspaceId,
    workstreamId,
  };
}

function addExchange(
  id: string,
  sessionId: string,
  cwd: string,
  userMessage: string,
  options: Partial<ConversationExchange> = {},
): void {
  insertExchange(db, exchange(id, sessionId, cwd, userMessage, options), embedding);
}

function bindSharedSession(
  sessionId: string,
  cwd = projectPath,
  targetWorkspaceId = workspaceId,
  targetWorkstreamId = workstreamId,
): void {
  bindSessionWorkstream(db, {
    sessionId,
    projectId,
    workspaceId: targetWorkspaceId,
    projectPath: cwd,
    explicitWorkstreamId: targetWorkstreamId,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-identifier-source-"));
  projectPath = path.join(root, "repo");
  gitClone(projectPath);
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  db = initDatabase();

  const session = ensureSessionMemoryState(db, {
    sessionId: "identifier-source-session",
    project: projectPath,
  });
  projectId = session.projectId;
  workspaceId = session.workspaceId;
  workstreamId = session.workstreamId;
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("human source identifier fallback", () => {
  it("returns bounded, centered snippets for omitted error codes, paths, and symbols", () => {
    addExchange(
      "human-error",
      "identifier-source-session",
      projectPath,
      "The worker must preserve E_QUEUE_LEASE_EXPIRED while retrying the queue.",
    );
    addExchange(
      "human-path",
      "identifier-source-session",
      projectPath,
      "The implementation lives in src/storage/checkpoint.ts beside the cursor writer.",
      { lineStart: 30, lineEnd: 42 },
    );
    addExchange(
      "human-symbol",
      "identifier-source-session",
      projectPath,
      "Please keep retryBudgetMs aligned with the bounded worker timeout.",
      { lineStart: 50, lineEnd: 58 },
    );

    const scope = currentScope();
    const error = searchHumanSourceIdentifiersInScope(
      db,
      "Where is E_QUEUE_LEASE_EXPIRED handled?",
      scope,
      2,
    );
    const file = searchHumanSourceIdentifiersInScope(
      db,
      "Locate src/storage/checkpoint.ts",
      scope,
      2,
    );
    const symbol = searchHumanSourceIdentifiersInScope(
      db,
      "What does retryBudgetMs control?",
      scope,
      2,
    );

    expect(error).toHaveLength(1);
    expect(file).toHaveLength(1);
    expect(symbol).toHaveLength(1);
    for (const [result, identifier] of [
      [error[0], "E_QUEUE_LEASE_EXPIRED"],
      [file[0], "src/storage/checkpoint.ts"],
      [symbol[0], "retryBudgetMs"],
    ] as const) {
      expect(result.exchangeId).toBeTruthy();
      expect(result.text).toContain(identifier);
      expect(result.text.length).toBeLessThanOrEqual(160);
      expect(result.text).toContain(result.exchangeId);
      expect(result.text).toMatch(/(?:lines?\s*)?\d+[-–]\d+|:\d+[-–]\d+/i);
      expect(result.snapshot).toBeTruthy();
      expect(result.coordinates).toBeTruthy();
      expect(validateHumanSourceIdentifierEvidence(db, result, scope)).toBe(true);
    }
  });

  it("limits source evidence to two rows and lets an active exact fact suppress fallback", async () => {
    addExchange(
      "human-duplicate-1",
      "identifier-source-session",
      projectPath,
      "The queue reports E_QUEUE_LEASE_EXPIRED after the lease timeout.",
    );
    addExchange(
      "human-duplicate-2",
      "identifier-source-session",
      projectPath,
      "retryBudgetMs is aligned with the bounded worker timeout.",
    );
    addExchange(
      "human-duplicate-3",
      "identifier-source-session",
      projectPath,
      "Alert on E_QUEUE_LEASE_EXPIRED after three attempts.",
    );

    const results = searchHumanSourceIdentifiersInScope(
      db,
      "Explain E_QUEUE_LEASE_EXPIRED and retryBudgetMs",
      currentScope(),
      2,
    );
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.exchangeId)).size).toBe(2);

    expect(results.every((result) => validateHumanSourceIdentifierEvidence(db, result, currentScope()))).toBe(true);

    const factId = insertFact(db, {
      fact: "The active fact records E_QUEUE_LEASE_EXPIRED retry behavior.",
      category: "knowledge",
      scope_type: "project",
      scope_project: projectPath,
      source_exchange_ids: ["human-duplicate-1"],
      embedding,
      project_id: projectId,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      promotion_state: "workstream",
      promotion_evidence: "experimental",
    });
    expect(factId).toBeTruthy();
    const context = await computeInjectContext(
      "Explain E_QUEUE_LEASE_EXPIRED",
      projectPath,
      "daemon",
      "identifier-source-session",
      { gate: false },
    );
    expect(context).toContain("E_QUEUE_LEASE_EXPIRED");
    expect(context).toContain("[CURRENT TRUTH]");
    expect(context).not.toContain("[RAW EVIDENCE");
  });

  it("enforces project and workstream scope, while allowing an explicitly shared workstream across valid workspaces", () => {
    const featurePath = path.join(root, "repo-feature");
    gitWorktree(projectPath, featurePath, "feature");
    const featureIdentity = resolveProjectWorkspace(db, { cwd: featurePath });
    bindSessionWorkstream(db, {
      sessionId: "identifier-source-feature-session",
      projectId,
      workspaceId: featureIdentity.workspaceId,
      projectPath: featureIdentity.canonicalPath,
      explicitWorkstreamId: workstreamId,
    });
    addExchange(
      "human-shared-workstream",
      "identifier-source-feature-session",
      featurePath,
      "The shared stream handles E_QUEUE_LEASE_EXPIRED in the feature workspace.",
    );

    const otherStream = createWorkstream(db, {
      projectId,
      workspaceId,
      projectPath,
      ownerSessionId: "identifier-source-other-session",
      workstreamId: "identifier-source-other-stream",
    });
    bindSessionWorkstream(db, {
      sessionId: "identifier-source-other-session",
      projectId,
      workspaceId,
      projectPath,
      explicitWorkstreamId: otherStream,
    });
    addExchange(
      "human-other-workstream",
      "identifier-source-other-session",
      projectPath,
      "The other stream also mentions E_QUEUE_LEASE_EXPIRED.",
    );

    const foreignProjectPath = path.join(root, "other-project");
    gitClone(foreignProjectPath, "git@example.test:other/identifier-source.git");
    const foreign = ensureSessionMemoryState(db, {
      sessionId: "identifier-source-foreign-project-session",
      project: foreignProjectPath,
    });
    addExchange(
      "human-other-project",
      "identifier-source-foreign-project-session",
      foreignProjectPath,
      "The unrelated project mentions E_QUEUE_LEASE_EXPIRED too.",
    );

    const shared = searchHumanSourceIdentifiersInScope(
      db,
      "Find E_QUEUE_LEASE_EXPIRED",
      currentScope(),
      10,
    );
    expect(shared.map((result) => result.exchangeId)).toContain("human-shared-workstream");
    expect(shared.map((result) => result.exchangeId)).not.toContain("human-other-workstream");
    expect(shared.map((result) => result.exchangeId)).not.toContain("human-other-project");
    expect(foreign.projectId).not.toBe(projectId);
    expect(validateHumanSourceIdentifierEvidence(db, shared[0], currentScope())).toBe(true);

    // A workstream ID alone is insufficient when its source workspace no
    // longer belongs to the canonical project.
    db.prepare("UPDATE exchanges SET workspace_id = ? WHERE id = ?")
      .run("workspace-outside-project", "human-shared-workstream");
    expect(searchHumanSourceIdentifiersInScope(db, "E_QUEUE_LEASE_EXPIRED", currentScope(), 10))
      .toEqual([]);
  });

  it("does not let a basename fact suppress a full path source match", () => {
    addExchange(
      "full-path-source",
      "identifier-source-session",
      projectPath,
      "The queue worker implementation lives in src/queue/retry.ts.",
    );
    insertFact(db, {
      fact: "The worker uses retry.ts for bounded retries.",
      category: "knowledge",
      scope_type: "project",
      scope_project: projectPath,
      source_exchange_ids: [],
      embedding,
      project_id: projectId,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      promotion_state: "workstream",
      promotion_evidence: "experimental",
    });

    const results = searchHumanSourceIdentifiersInScope(
      db,
      "Locate src/queue/retry.ts",
      currentScope(),
      2,
    );
    expect(results).toHaveLength(1);
    expect(results[0].exchangeId).toBe("full-path-source");
    expect(results[0].text).toContain("src/queue/retry.ts");
  });

  it("keeps two omitted identifiers from one human exchange as two bounded snippets", () => {
    addExchange(
      "multi-identifier-source",
      "identifier-source-session",
      projectPath,
      `The worker first reports E_FIRST_ERROR during startup, then records ${"x".repeat(240)} E_SECOND_ERROR after the retry boundary.`,
    );
    const results = searchHumanSourceIdentifiersInScope(
      db,
      "Find E_FIRST_ERROR and E_SECOND_ERROR",
      currentScope(),
      2,
    );
    expect(results).toHaveLength(2);
    expect(new Set(results.map((result) => result.identifier))).toEqual(
      new Set(["E_FIRST_ERROR", "E_SECOND_ERROR"]),
    );
    expect(results.every((result) => result.exchangeId === "multi-identifier-source")).toBe(true);
    expect(results.every((result) => result.text.length <= 160)).toBe(true);
  });

  it("does not let a derived fact_kr literal suppress a canonical English source lookup", () => {
    addExchange(
      "fact-kr-source",
      "identifier-source-session",
      projectPath,
      "The queue records E_KR_ONLY_STATUS in the lease journal.",
    );
    insertFact(db, {
      fact: "The queue records a status in the lease journal.",
      fact_kr: "E_KR_ONLY_STATUS가 lease journal에 기록됩니다.",
      category: "knowledge",
      scope_type: "project",
      scope_project: projectPath,
      source_exchange_ids: [],
      embedding,
      project_id: projectId,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      promotion_state: "workstream",
      promotion_evidence: "experimental",
    });

    const results = searchHumanSourceIdentifiersInScope(
      db,
      "Find E_KR_ONLY_STATUS",
      currentScope(),
      2,
    );
    expect(results).toHaveLength(1);
    expect(results[0].exchangeId).toBe("fact-kr-source");
  });

  it("fails closed for assistant-only, recall-influenced, compaction, synthetic, and excluded rows", () => {
    bindSharedSession("assistant-only-session");
    addExchange(
      "assistant-only",
      "assistant-only-session",
      projectPath,
      "",
      { assistantMessage: "E_ASSISTANT_ONLY appears only in this assistant answer" },
    );
    bindSharedSession("recall-human-session");
    addExchange(
      "recall-human",
      "recall-human-session",
      projectPath,
      "The user said E_RECALL_ALLOWED should be retried.",
      {
        assistantMessage: "A recalled answer mentioned E_RECALL_ALLOWED.",
        hasMemexRecall: true,
        provenance: ["human_assertion", "assistant_generated", "memex_recall"],
        timestamp: "2026-09-08T00:01:00.000Z",
      },
    );
    bindSharedSession("compaction-replay-session");
    addExchange(
      "compaction-replay",
      "compaction-replay-session",
      projectPath,
      "Earlier human prompt replayed from replacement history: E_COMPACTION_REPLAY",
      // `compacted` replacement_history records are discarded by the rollout
      // parser and cannot carry fresh human provenance if they reach storage.
      { provenance: ["assistant_generated"], hasMemexRecall: true },
    );
    bindSharedSession("synthetic-transport-session");
    addExchange(
      "synthetic-transport",
      "synthetic-transport-session",
      projectPath,
      "<local-command-stdout>E_SYNTHETIC_TRANSPORT</local-command-stdout>",
    );
    bindSharedSession("excluded-human-session");
    addExchange(
      "excluded-human",
      "excluded-human-session",
      projectPath,
      "Private conversation about E_EXCLUDED",
    );
    db.prepare(`
      INSERT INTO conversation_exclusions(session_id, source_path, reason, excluded_at)
      VALUES (?, ?, 'source_conversation_excluded', ?)
    `).run("excluded-human-session", path.join(root, "excluded.jsonl"), "2026-09-08T00:00:00.000Z");

    expect(searchHumanSourceIdentifiersInScope(db, "Find E_ASSISTANT_ONLY", currentScope(), 10)).toEqual([]);
    expect(searchHumanSourceIdentifiersInScope(db, "Find E_RECALL_ALLOWED", currentScope(), 10).map((result) => result.exchangeId))
      .toEqual(["recall-human"]);
    expect(searchHumanSourceIdentifiersInScope(db, "Find E_COMPACTION_REPLAY", currentScope(), 10)).toEqual([]);
    expect(searchHumanSourceIdentifiersInScope(db, "Find E_SYNTHETIC_TRANSPORT", currentScope(), 10)).toEqual([]);
    expect(searchHumanSourceIdentifiersInScope(db, "Find E_EXCLUDED", currentScope(), 10)).toEqual([]);
  });

  it("invalidates captured evidence when source content changes or the exchange is deleted", () => {
    addExchange(
      "mutable-source",
      "identifier-source-session",
      projectPath,
      "The queue records E_QUEUE_LEASE_EXPIRED in the lease journal.",
    );
    const scope = currentScope();
    const [evidence] = searchHumanSourceIdentifiersInScope(
      db,
      "Find E_QUEUE_LEASE_EXPIRED",
      scope,
      2,
    );
    expect(evidence).toBeTruthy();
    expect(validateHumanSourceIdentifierEvidence(db, evidence, scope)).toBe(true);

    db.prepare("UPDATE exchanges SET user_message = ? WHERE id = ?")
      .run("The queue now records a different status.", "mutable-source");
    expect(validateHumanSourceIdentifierEvidence(db, evidence, scope)).toBe(false);

    db.prepare("UPDATE exchanges SET user_message = ? WHERE id = ?")
      .run("The queue records E_QUEUE_LEASE_EXPIRED in the lease journal.", "mutable-source");
    expect(validateHumanSourceIdentifierEvidence(db, evidence, scope)).toBe(true);
    deleteExchange(db, "mutable-source");
    expect(validateHumanSourceIdentifierEvidence(db, evidence, scope)).toBe(false);
  });
});
