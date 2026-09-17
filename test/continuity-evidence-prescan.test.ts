// Issue #162 — `appendSessionEvidence` out of transaction: pre-scan first.
//
// The observed failure: a hook-spawned worker paging a ~1,400-exchange session
// re-read every exchange of that session inside ONE `BEGIN IMMEDIATE`, on every
// page. The continuity hook, whose host kills it at 3 s, waited on that write
// lock with a 5 s busy_timeout and was killed ("Hook failed — hook timed out
// after 3s").
//
// `insertExchange` already appends each exchange's evidence as it commits, so
// this function is a BACKFILL for exchanges that predate their session binding.
// The tests below delete evidence rows to reproduce exactly that gap.
//
// What this file proves:
//   - the steady state (evidence complete) opens NO write transaction at all
//   - one missing exchange still produces exactly one insert, in one transaction
//   - the pre-scan is only a FILTER: a rebind, a generation bump or a privacy
//     purge landing between the scan and the transaction can never produce a
//     stale insert, because `appendExchangeEvidence` re-checks inside the lock
//   - the in-transaction caller (rebind, refreshWorkspaceEvidence) still gets
//     today's full scan
import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { appendSessionEvidence } from "../src/continuity-evidence.js";
import { createWorkstream, rebindSessionWorkstream } from "../src/continuity-identity.js";

let root: string;
let db: Database.Database;
let scopes: ReturnType<typeof ensureSessionMemoryState>;
const vector = new Array(384).fill(0.01);
const SESSION = "session-scan";

function transcript(session: string): string {
  return path.join(root, `${session}.jsonl`);
}

// Distinct line ranges: two exchanges sharing a line range with different
// content are the same conversation position re-written, and `insertExchange`
// then gives the later one a new immutable content generation. These are
// distinct exchanges, so they get distinct positions.
let nextLine = 2;
function put(id: string): void {
  const line = nextLine++;
  insertExchange(db, {
    id, sessionId: SESSION, project: root, cwd: root, archivePath: transcript(SESSION),
    timestamp: new Date().toISOString(), userMessage: id, assistantMessage: "",
    lineStart: line, lineEnd: line,
  }, vector);
}

function generationOf(exchangeId: string): number {
  return (db.prepare("SELECT content_generation FROM exchanges WHERE id = ?")
    .get(exchangeId) as { content_generation: number }).content_generation;
}

/** Reproduce the backfill gap: an exchange whose evidence row is missing. */
function dropEvidence(exchangeId: string): void {
  db.prepare("DELETE FROM workstream_evidence WHERE exchange_id = ?").run(exchangeId);
}

type EvidenceRow = { workstream_id: string; exchange_id: string; content_generation: number };

function evidenceRows(): EvidenceRow[] {
  return db.prepare(`SELECT workstream_id, exchange_id, content_generation
    FROM workstream_evidence ORDER BY seq`).all() as EvidenceRow[];
}

/**
 * Count write transactions this connection actually OPENS. `db.transaction()`
 * only builds the function; `.immediate()` is what takes the write lock, so
 * both are counted separately — the steady state must reach neither.
 */
function spyTransactions(): { created: number; immediate: number; onCreate?: () => void } {
  const original = db.transaction.bind(db);
  const calls: { created: number; immediate: number; onCreate?: () => void } = { created: 0, immediate: 0 };
  (db as unknown as { transaction: unknown }).transaction = (fn: (...args: unknown[]) => unknown) => {
    calls.created++;
    const tx = original(fn as never) as unknown as Record<string, unknown> & ((...a: unknown[]) => unknown);
    // Fires AFTER the candidate scan and BEFORE the lock is taken: the window
    // every "re-check inside the transaction" claim below depends on.
    calls.onCreate?.();
    const wrapped = ((...args: unknown[]) => tx(...args)) as unknown as Record<string, unknown>;
    wrapped.immediate = (...args: unknown[]) => {
      calls.immediate++;
      return (tx.immediate as (...a: unknown[]) => unknown)(...args);
    };
    wrapped.deferred = tx.deferred;
    wrapped.exclusive = tx.exclusive;
    return wrapped;
  };
  return calls;
}

/** Every SQL string this connection prepares, for the in-transaction path. */
function spyPrepare(): string[] {
  const seen: string[] = [];
  const original = db.prepare.bind(db);
  (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
    seen.push(sql);
    return original(sql);
  };
  return seen;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-prescan-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  nextLine = 2;
  scopes = ensureSessionMemoryState(db, { sessionId: SESSION, project: root });
  fs.writeFileSync(
    transcript(SESSION),
    JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd: root } }) + "\n",
  );
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

it("a 300-exchange session with complete evidence opens no write transaction", () => {
  for (let i = 0; i < 300; i++) put(`ex-${String(i).padStart(3, "0")}`);
  const before = evidenceRows();
  expect(before.length).toBe(300);

  const calls = spyTransactions();
  appendSessionEvidence(db, SESSION);

  expect(calls.created).toBe(0);
  expect(calls.immediate).toBe(0);
  expect(evidenceRows()).toEqual(before);
});

it("one missing exchange is exactly one insert in exactly one transaction", () => {
  for (let i = 0; i < 300; i++) put(`ex-${String(i).padStart(3, "0")}`);
  dropEvidence("ex-100");
  expect(evidenceRows().length).toBe(299);

  const calls = spyTransactions();
  appendSessionEvidence(db, SESSION);

  expect(calls.immediate).toBe(1);
  const rows = evidenceRows();
  expect(rows.length).toBe(300);
  expect(rows.filter((row) => row.exchange_id === "ex-100")).toEqual([
    {
      workstream_id: scopes.workstreamId,
      exchange_id: "ex-100",
      content_generation: generationOf("ex-100"),
    },
  ]);
});

it("after a rebind the new workstream gets evidence for the same generation", () => {
  put("ex-moved");
  const target = createWorkstream(db, {
    projectId: scopes.projectId, workspaceId: scopes.workspaceId,
    projectPath: root, ownerSessionId: "owner", workstreamId: "target-stream",
  });
  rebindSessionWorkstream(db, { sessionId: SESSION, workstreamId: target });

  // The gap this backfill exists for, at its sharpest: the exchange has an
  // evidence row for the OLD workstream at the SAME generation, and none for
  // the workstream it now belongs to. Keying the "already has evidence" check
  // on (exchange_id, content_generation) alone would read that old row as
  // "done" and the new workstream would never get its evidence.
  dropEvidence("ex-moved");
  db.prepare("INSERT OR IGNORE INTO capsule_frontiers(workstream_id) VALUES (?)").run(scopes.workstreamId);
  db.prepare(`INSERT INTO workstream_evidence
    (workstream_id, exchange_id, source_session_id, workspace_id, content_generation,
     content_hash, part, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, 'stale-hash', 0, '{}', ?)`)
    .run(scopes.workstreamId, "ex-moved", SESSION, scopes.workspaceId,
      generationOf("ex-moved"), new Date().toISOString());

  const calls = spyTransactions();
  appendSessionEvidence(db, SESSION);

  expect(calls.immediate).toBe(1);
  const rows = evidenceRows().filter((row) => row.exchange_id === "ex-moved");
  expect(rows.some((row) =>
    row.workstream_id === target && row.content_generation === generationOf("ex-moved"))).toBe(true);
  // The old workstream's row is still there — it was not what unblocked this.
  expect(rows.some((row) => row.workstream_id === scopes.workstreamId)).toBe(true);
});

it("an exchange whose only evidence is a stale generation is still a candidate", () => {
  put("ex-regenerated");
  const before = generationOf("ex-regenerated");
  // The old generation's rows stay (they are immutable history); the exchange
  // now needs evidence for the generation it actually carries.
  db.prepare("UPDATE exchanges SET content_generation = ? WHERE id = ?").run(before + 1, "ex-regenerated");

  const calls = spyTransactions();
  appendSessionEvidence(db, SESSION);

  expect(calls.immediate).toBe(1);
  const generations = evidenceRows()
    .filter((row) => row.exchange_id === "ex-regenerated")
    .map((row) => row.content_generation)
    .sort();
  expect(generations).toEqual([before, before + 1]);
});

it("a generation bump between the scan and the transaction inserts only the live generation", () => {
  put("ex-bumped");
  dropEvidence("ex-bumped");
  const calls = spyTransactions();
  calls.onCreate = () => {
    db.prepare("UPDATE exchanges SET content_generation = 7 WHERE id = ?").run("ex-bumped");
  };

  appendSessionEvidence(db, SESSION);

  expect(calls.immediate).toBe(1);
  const rows = evidenceRows().filter((row) => row.exchange_id === "ex-bumped");
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((row) => row.content_generation === 7)).toBe(true);
});

it("a privacy exclusion between the scan and the transaction inserts nothing", () => {
  put("ex-private");
  dropEvidence("ex-private");
  const calls = spyTransactions();
  calls.onCreate = () => {
    db.prepare(`INSERT INTO conversation_exclusions(session_id, source_path, reason, excluded_at)
      VALUES (?, ?, 'user', ?)`).run(SESSION, transcript(SESSION), new Date().toISOString());
  };

  appendSessionEvidence(db, SESSION);

  expect(calls.immediate).toBe(1);
  expect(evidenceRows()).toEqual([]);
});

it("inside a caller's transaction the full scan is unchanged", () => {
  put("ex-inside");
  dropEvidence("ex-inside");
  const prepared = spyPrepare();
  db.transaction(() => appendSessionEvidence(db, SESSION)).immediate();

  expect(prepared.some((sql) => sql.includes("SELECT id FROM exchanges WHERE session_id = ?"))).toBe(true);
  expect(prepared.some((sql) => sql.includes("LEFT JOIN workstream_evidence v"))).toBe(false);
  expect(evidenceRows().map((row) => row.exchange_id)).toEqual(["ex-inside"]);
});
