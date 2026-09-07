import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { computeInjectContext } from "../src/inject-core.js";
import * as embeddings from "../src/embeddings.js";
import { ensureSessionMemoryState, handleContinuityHook } from "../src/continuity-core.js";
import { bindSessionWorkstream, commitHotEvidenceCursor, createWorkstream, indexHotEvidenceForSession,
  readHotEvidence, rebindSessionWorkstream } from "../src/continuity-identity.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";

let root: string;
let db: Database.Database;
let scope: ReturnType<typeof ensureSessionMemoryState>;
const session = "cursor-reader";
const sibling = "cursor-writer";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-hot-cursor-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  db = initDatabase();
  scope = ensureSessionMemoryState(db, { sessionId: session, project: root });
  bindSessionWorkstream(db, { sessionId: sibling, projectId: scope.projectId, workspaceId: scope.workspaceId,
    projectPath: root, explicitWorkstreamId: scope.workstreamId });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(root, { recursive: true, force: true });
});
function put(id: string, text = id, owner = sibling): void {
  insertExchange(db, { id, sessionId: owner, project: root, cwd: root,
    timestamp: new Date().toISOString(), userMessage: text, assistantMessage: "",
    archivePath: path.join(root, `${owner}.jsonl`), lineStart: 1, lineEnd: 2,
  }, embeddings.stubEmbedding(text));
  indexHotEvidenceForSession(db, owner);
}
function cursor(): number {
  return (db.prepare("SELECT hot_evidence_cursor n FROM session_memory_state WHERE session_id = ?")
    .get(session) as { n: number }).n;
}
function inject(prompt = "계속") { return computeInjectContext(prompt, root, "daemon", session); }

it("drains the query-limited suffix on acknowledgement prompts with zero embeddings", async () => {
  for (let i = 0; i < 5; i++) put(`hot-${i}`);
  // Equal timestamps must not collapse separate committed items.
  db.prepare("UPDATE hot_evidence SET created_at = '2026-09-07T00:00:00.000Z'").run();
  const before = embeddings.embeddingCallStats();
  const outputs = [await inject(), await inject(), await inject()];
  for (let i = 0; i < 5; i++) expect(outputs.join("\n").match(new RegExp(`hot-${i}`, "g"))).toHaveLength(1);
  expect(await inject()).toBe("");
  expect(embeddings.embeddingCallStats().modelCalls - before.modelCalls).toBe(0);
});

it("does not advance across a budget cutoff and retries after corrections drain", async () => {
  put("pending", "pending sibling evidence " + "e".repeat(200));
  const revisions: Array<[string, number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const id = `fact-${i}`;
    db.prepare(`INSERT INTO facts (id, fact, category, scope_type, scope_project, project_id,
      source_exchange_ids, created_at, updated_at, semantic_generation)
      VALUES (?, ?, 'knowledge', 'project', ?, ?, '[]', ?, ?, 2)`)
      .run(id, `${id} ${"c".repeat(300)}`, root, scope.projectId, new Date().toISOString(), new Date().toISOString());
    revisions.push([id, 1, 1]);
  }
  db.prepare("UPDATE session_memory_state SET resident_fact_revisions_json = ? WHERE session_id = ?")
    .run(JSON.stringify(revisions), session);
  db.prepare("INSERT INTO work_capsules(workstream_id, generation, objective, current_state, updated_at) VALUES (?,1,?,?,?)")
    .run(scope.workstreamId, "o".repeat(180), "s".repeat(50), new Date().toISOString());
  const first = await inject();
  expect(first).toContain("MEMEX CORRECTION");
  expect(first).toContain("WORK NOW");
  expect(first).not.toContain("pending sibling evidence");
  expect(cursor()).toBe(0);
  const outputs = [await inject(), await inject(), await inject()];
  expect(outputs.join("\n")).toContain("pending sibling evidence");
  expect(cursor()).toBeGreaterThan(0);
});

it("leaves evidence inserted during the embedding await for the next prompt", async () => {
  put("first");
  const original = embeddings.generateEmbedding;
  vi.spyOn(embeddings, "generateEmbedding").mockImplementationOnce(async (...args) => {
    put("late");
    return original(...args);
  });
  const first = await inject("Search memory for the deployment decision");
  expect(first).toContain("first");
  expect(first).not.toContain("late");
  expect(await inject()).toContain("late");
});

it("rolls back the whole injection when fetched evidence is purged during await", async () => {
  put("private", "private evidence");
  const original = embeddings.generateEmbedding;
  vi.spyOn(embeddings, "generateEmbedding").mockImplementationOnce(async (...args) => {
    purgeConversationFromIndex(db, { archivePath: path.join(root, `${sibling}.jsonl`), sessionId: sibling });
    return original(...args);
  });
  expect(await inject("Search memory for the deployment decision")).toBe("");
  expect(cursor()).toBe(0);
});

it("compact/resume advances only its emitted prefix, then prompts drain the rest", async () => {
  for (let i = 0; i < 5; i++) put(`compact-${i}`);
  const first = handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "compact" }, { db });
  expect(first.stdout).toContain("compact-0");
  expect(first.stdout).toContain("compact-2");
  expect(first.stdout).not.toContain("compact-3");
  const next = await inject();
  expect(next).toContain("compact-3");
  expect(next).toContain("compact-4");
  expect(next).not.toContain("compact-0");
});

it("a fresh Capsule with correction pressure cannot acknowledge unrendered rehydration evidence", () => {
  put("pending");
  db.prepare("INSERT INTO work_capsules(workstream_id, generation, objective, current_state, next_actions_json, updated_at) VALUES (?,1,?,?,?,?)")
    .run(scope.workstreamId, "o".repeat(500), "s".repeat(500), JSON.stringify(["n".repeat(500)]), new Date().toISOString());
  for (let i = 0; i < 15; i++) db.prepare(`INSERT INTO facts
    (id, fact, category, scope_type, scope_project, project_id, promotion_state, source_exchange_ids, created_at, updated_at)
    VALUES (?, ?, 'knowledge', 'project', ?, ?, 'legacy-project', '[]', ?, ?)`)
    .run(`correction-${i}`, "c".repeat(260), root, scope.projectId, new Date().toISOString(), new Date().toISOString());
  const context = handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, cwd: root, source: "resume" }, { db });
  expect(context.stdout).toContain("WORK NOW");
  // Whether one short row fits or not, cursor must reflect actual emission.
  expect(cursor() > 0).toBe(context.stdout.includes("pending"));
});

it("sequence commit rejects epoch/rebind races and sequence IDs are never reused after deletion", async () => {
  put("one");
  await inject();
  const old = cursor();
  db.prepare("DELETE FROM hot_evidence").run();
  put("two");
  const hot = readHotEvidence(db, { projectId: scope.projectId, workstreamId: scope.workstreamId, afterSeq: old });
  expect(Number(hot[0].seq)).toBeGreaterThan(old);
  const target = createWorkstream(db, { projectId: scope.projectId, workspaceId: scope.workspaceId,
    projectPath: root, ownerSessionId: "owner", workstreamId: "other-stream" });
  rebindSessionWorkstream(db, { sessionId: session, workstreamId: target });
  expect(cursor()).toBe(0);
  expect(() => db.transaction(() => commitHotEvidenceCursor(db, { sessionId: session,
    projectId: scope.projectId, workstreamId: scope.workstreamId, contextEpoch: 0,
    fromSeq: old, emittedSeqs: [Number(hot[0].seq)],
  })).immediate()).toThrow("scope or cursor changed");
  expect(cursor()).toBe(0);
});
