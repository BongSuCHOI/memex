import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { ensureExtractionTarget, settleStaleOpenExchanges } from "../src/continuity-store.js";
import { applyLatestLifecycleClosure } from "../src/continuity-core.js";
import { getExtractionConfig, pendingExtractionCoreQuery } from "../src/pending-extraction.js";

/**
 * Issue #149: five live sessions kept 2–28 closed exchanges behind one
 * mid-session `interrupted` exchange. The target builder fenced everything
 * after it and returned nothing; the pending query counted them anyway. The
 * fence must apply only to a trailing open/interrupted turn.
 */
let root = "";
let db: Database.Database;
const vector = new Array(384).fill(0.01);
const SESSION = "session-fence";

function put(id: string, closureState: "open" | "interrupted" | "closed" | "final", line: number, sidechain = false): void {
  insertExchange(db, {
    id, sessionId: SESSION, project: root, cwd: root, archivePath: path.join(root, "s.jsonl"),
    timestamp: new Date(Date.parse("2026-09-16T00:00:00Z") + line * 1000).toISOString(),
    userMessage: `question ${id}`, assistantMessage: `answer ${id}`, lineStart: line, lineEnd: line + 1,
    closureState, isSidechain: sidechain,
  }, vector);
}

function pendingSessions(): string[] {
  const { sql, params } = pendingExtractionCoreQuery(getExtractionConfig(), "continuity");
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map((row) => row.sid);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-extraction-fence-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

it("a mid-session interrupted turn is settled and the exchanges behind it become extraction items (#149)", () => {
  put("a", "closed", 1);
  put("b", "interrupted", 3);
  put("c", "closed", 5);
  put("d", "closed", 7);
  expect(pendingSessions()).toContain(SESSION);
  const target = ensureExtractionTarget(db, { sessionId: SESSION, project: root });
  expect(target).not.toBeNull();
  const items = db.prepare("SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal")
    .all(target!.targetId) as Array<{ exchange_id: string }>;
  // the session moved past the interrupted turn: it is settled as closed (new generation) and extracted with the rest
  expect(items.map((item) => item.exchange_id)).toEqual(["a", "b", "c", "d"]);
  expect(db.prepare("SELECT closure_state, content_generation FROM exchanges WHERE id = 'b'").get())
    .toEqual({ closure_state: "closed", content_generation: 2 });
});

it("a trailing open turn still fences, and both sides agree the session is not extractable", () => {
  put("a", "closed", 1);
  put("b", "open", 3);
  const target = ensureExtractionTarget(db, { sessionId: SESSION, project: root });
  expect(target).not.toBeNull();
  const items = db.prepare("SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal")
    .all(target!.targetId) as Array<{ exchange_id: string }>;
  expect(items.map((item) => item.exchange_id)).toEqual(["a"]);
  // only the trailing open turn: nothing to extract, and the pending query does not count it either
  db.prepare("DELETE FROM extraction_target_items WHERE target_id = ?").run(target!.targetId);
  db.prepare("DELETE FROM memory_jobs WHERE target_id = ?").run(target!.targetId);
  db.prepare("DELETE FROM extraction_targets WHERE target_id = ?").run(target!.targetId);
  db.prepare("DELETE FROM exchanges WHERE id = 'a'").run();
  expect(ensureExtractionTarget(db, { sessionId: SESSION, project: root })).toBeNull();
  expect(pendingSessions()).not.toContain(SESSION);
});

it("transcript order decides what \"later\" means, not insertion order", () => {
  // the later turn was ingested first (lower rowid); the interrupted turn still has a later turn behind it
  put("c", "closed", 5);
  put("b", "interrupted", 3);
  put("a", "closed", 1);
  expect(settleStaleOpenExchanges(db, SESSION)).toBe(1);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'b'").get()).toEqual({ closure_state: "closed" });
  // a trailing turn by transcript order is untouched even when it was inserted earliest
  put("d", "open", 7);
  expect(settleStaleOpenExchanges(db, SESSION)).toBe(0);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'd'").get()).toEqual({ closure_state: "open" });
});

it("a historical interrupt checkpoint cannot re-open a turn the session moved past", () => {
  put("a", "closed", 1);
  put("b", "interrupted", 3);
  put("c", "closed", 5);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at, closure_state, through_line)
    VALUES ('cp-interrupt', ?, 1, 'interrupt', 'captured', 'cp-interrupt-key', ?, 'interrupted', 4)`)
    .run(SESSION, now);
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(true);
  // the checkpoint's interrupted label is not applied to a turn with later turns; settlement closed it once
  expect(db.prepare("SELECT closure_state, content_generation FROM exchanges WHERE id = 'b'").get())
    .toEqual({ closure_state: "closed", content_generation: 2 });
  // idempotent: the historical checkpoint stays the latest one, and every later ingestion must be a no-op
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(false);
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(false);
  expect(db.prepare("SELECT closure_state, content_generation FROM exchanges WHERE id = 'b'").get())
    .toEqual({ closure_state: "closed", content_generation: 2 });
  // a trailing turn is still labelled by its checkpoint
  put("d", "closed", 7);
  db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at, closure_state, through_line, through_byte)
    VALUES ('cp-interrupt-2', ?, 2, 'interrupt', 'captured', 'cp-interrupt-2-key', ?, 'interrupted', 8, 1)`)
    .run(SESSION, new Date().toISOString());
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(true);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'd'").get()).toEqual({ closure_state: "interrupted" });
  const target = ensureExtractionTarget(db, { sessionId: SESSION, project: root })!;
  const items = db.prepare("SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal")
    .all(target.targetId) as Array<{ exchange_id: string }>;
  expect(items.map((item) => item.exchange_id)).toEqual(["a", "b", "c"]);
});

it("a sidechain turn is not evidence that the main line moved on (post-release #149)", () => {
  put("a", "closed", 1);
  put("b", "open", 3);
  put("side", "closed", 5, true);
  expect(settleStaleOpenExchanges(db, SESSION)).toBe(0);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'b'").get()).toEqual({ closure_state: "open" });
  // the checkpoint label still applies to b: only sidechain turns follow it
  db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at, closure_state, through_line)
    VALUES ('cp-side', ?, 1, 'interrupt', 'captured', 'cp-side-key', ?, 'interrupted', 4)`)
    .run(SESSION, new Date().toISOString());
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(true);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'b'").get()).toEqual({ closure_state: "interrupted" });
  // a main-line turn behind it settles b as before
  put("c", "closed", 7);
  expect(settleStaleOpenExchanges(db, SESSION)).toBe(1);
});

it("the fence is a transcript position: a trailing open turn inserted first does not hide earlier closed turns (post-release #149)", () => {
  put("c", "open", 7);      // trailing turn by transcript, lowest rowid
  put("a", "closed", 1);
  put("b", "closed", 3);
  const target = ensureExtractionTarget(db, { sessionId: SESSION, project: root });
  expect(target).not.toBeNull();
  const items = db.prepare("SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal")
    .all(target!.targetId) as Array<{ exchange_id: string }>;
  expect(items.map((item) => item.exchange_id)).toEqual(["a", "b"]);
  expect(db.prepare("SELECT closure_state FROM exchanges WHERE id = 'c'").get()).toEqual({ closure_state: "open" });
});

it("the checkpoint boundary is a main-line turn even when a sidechain turn is the last row within through_line", () => {
  put("a", "closed", 1);
  put("b", "open", 3);
  put("side", "closed", 5, true);
  db.prepare(`INSERT INTO checkpoints
      (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at, closure_state, through_line)
    VALUES ('cp-stop', ?, 1, 'stop', 'captured', 'cp-stop-key', ?, 'closed', 6)`)
    .run(SESSION, new Date().toISOString());
  expect(applyLatestLifecycleClosure(db, SESSION)).toBe(true);
  expect(db.prepare("SELECT closure_state, content_generation FROM exchanges WHERE id = 'b'").get())
    .toEqual({ closure_state: "closed", content_generation: 2 });
  expect(db.prepare("SELECT closure_state, content_generation FROM exchanges WHERE id = 'side'").get())
    .toEqual({ closure_state: "closed", content_generation: 1 });
  // b is now closed and extractable; the sidechain turn was always an item (closed, no fence)
  const target = ensureExtractionTarget(db, { sessionId: SESSION, project: root })!;
  const items = db.prepare("SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal")
    .all(target.targetId) as Array<{ exchange_id: string }>;
  expect(items.map((item) => item.exchange_id)).toEqual(["a", "b", "side"]);
});
