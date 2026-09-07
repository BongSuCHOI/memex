import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { buildRehydrationContext, ensureSessionMemoryState } from "../src/continuity-core.js";

let root: string;
let db: Database.Database;
let workstream: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rehydrate-budget-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: "budget", project: root }).workstreamId;
  insertExchange(db, {
    id: "request", sessionId: "budget", project: root, cwd: root,
    timestamp: new Date().toISOString(), archivePath: "fixture",
    userMessage: "Resume the pending migration", assistantMessage: "Next: verify the journal",
    lineStart: 1, lineEnd: 2,
  }, new Array(384).fill(0.01));
  const carry: Array<[string, number, number]> = [];
  for (let i = 0; i < 12; i++) {
    const id = `correction-${i}`;
    db.prepare(`INSERT INTO facts
      (id, fact, category, scope_type, scope_project, source_exchange_ids,
       created_at, updated_at, semantic_generation)
      VALUES (?, ?, 'knowledge', 'project', ?, '[]', ?, ?, 2)`)
      .run(id, `${id} ${"x".repeat(250)}`, root, new Date().toISOString(), new Date().toISOString());
    carry.push([id, 1, 1]);
  }
  db.prepare("UPDATE session_memory_state SET carry_fact_revisions_json = ?, latest_checkpoint_id = 'latest'")
    .run(JSON.stringify(carry));
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

it.each([500, 2_000].flatMap((budget) =>
  ["fresh", "stale", "oversized", "empty", "missing"].map((kind) => ({ budget, kind })),
))("reserves work context under correction pressure: $kind / $budget", ({ budget, kind }) => {
  if (kind !== "missing") {
    db.prepare(`INSERT INTO work_capsules
      (workstream_id, generation, objective, current_state, next_actions_json, through_checkpoint_id, updated_at)
      VALUES (?, 1, ?, ?, ?, ?, ?)`)
      .run(workstream,
        kind === "empty" ? "" : "Ship migration" + (kind === "oversized" ? "x".repeat(480) : ""),
        kind === "empty" ? "" : "x".repeat(500),
        kind === "empty" ? "[]" : JSON.stringify(["Verify journal" + "x".repeat(480)]),
        kind === "stale" ? "older" : "latest", new Date().toISOString());
  }
  const result = buildRehydrationContext(db, { sessionId: "budget", maxChars: budget });
  expect(result.context.length).toBeLessThanOrEqual(budget);
  if (["empty", "missing"].includes(kind)) {
    expect(result.capsuleGeneration).toBe(0);
    expect(result.context).toContain("DETERMINISTIC TAIL BATON");
    expect(result.context).toContain("Resume the pending migration");
  } else {
    expect(result.capsuleGeneration).toBe(1);
    expect(result.context).toContain("[WORK NOW]");
    expect(result.context).toContain("Objective: Ship migration");
    expect(result.context).toContain("Next: Verify journal");
    if (kind === "stale") expect(result.context).toContain("DETERMINISTIC TAIL BATON");
  }
  expect(result.projectRevisionComplete).toBe(false);
  for (const [id, generation] of result.factRevisions) {
    expect(result.context).toContain(id);
    expect(generation).toBe(2);
  }
});
