import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { initDatabase } from "../src/db.js";
import { handleContinuityHook } from "../src/continuity-core.js";
import { getPipelineStatus } from "../src/pipeline-status.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema-version.js";
import { NO_TRANSCRIPT_CAPTURE_REASON } from "../src/hook-budget.js";

/**
 * Issue #168 (follow-up) — the `capture_gaps` rows 0.7.24/0.7.25 already opened.
 *
 * Those versions recorded a durable gap row for EVERY capture failure, including
 * the `codex exec --ephemeral` Stop/SessionEnd whose payload had no
 * `transcript_path`. Nothing was ever uncaptured there, so no later capture can
 * recover the row: `state = 'open'` would stand for ever, inflating
 * pipeline-status `captureGapsOpen` and advising the user that "the next
 * successful capture on that session closes them" about a session that has no
 * transcript to capture.
 *
 * The repair is narrow on purpose — only rows still open whose reason is that one
 * message — so a genuine skipped capture is never closed behind the user's back.
 */

const SESSION_EPHEMERAL = "session-codex-exec-ephemeral";
const SESSION_GENUINE = "session-real-transcript";

let root: string;
let home: string;
let dbPath: string;

function seedGaps(): void {
  const db = initDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO capture_gaps
        (gap_id, session_id, stream_epoch, source_path, event_kind, reason, state, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, 'open', ?)
    `);
    // What 0.7.24/0.7.25 wrote for an ephemeral session: no source path at all.
    insert.run(
      "gap-no-transcript", SESSION_EPHEMERAL, null, "stop",
      NO_TRANSCRIPT_CAPTURE_REASON, "2026-09-18T01:54:17.000Z",
    );
    // A real skipped capture, which must stay open and keep its reason.
    insert.run(
      "gap-genuine", SESSION_GENUINE, "/tmp/rollout.jsonl", "stop",
      "transcript prefix does not match the journal", "2026-09-18T01:55:00.000Z",
    );
  } finally {
    db.close();
  }
}

function gapRows(): Array<{ gap_id: string; state: string; reason: string; recovered_at: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare("SELECT gap_id, state, reason, recovered_at FROM capture_gaps ORDER BY gap_id")
      .all() as Array<{ gap_id: string; state: string; reason: string; recovered_at: string | null }>;
  } finally {
    db.close();
  }
}

/** Put the file back on the version BEFORE this repair, so the pass runs once. */
function stampPreviousSchemaVersion(): void {
  const db = new Database(dbPath);
  try {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION - 1}`);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-gap-repair-"));
  home = path.join(root, "memex-home");
  dbPath = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = home;
  process.env.MEMEX_DB_PATH = dbPath;
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_CONTINUITY_NO_WAKE = "1";
  delete process.env.MEMEX_SYNC_DIR;
  delete process.env.MEMEX_SCHEMA_ALWAYS_MIGRATE;
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_CONTINUITY_NO_WAKE;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the no-transcript capture gaps 0.7.24/0.7.25 left open (#168)", () => {
  it("the schema pass closes only the no-transcript row, once, on update", () => {
    seedGaps();
    stampPreviousSchemaVersion();

    // The update: one open that runs the pass because the file is behind.
    initDatabase().close();

    const rows = gapRows();
    expect(rows.map(({ gap_id, state }) => ({ gap_id, state }))).toEqual([
      { gap_id: "gap-genuine", state: "open" },
      { gap_id: "gap-no-transcript", state: "recovered" },
    ]);
    const repaired = rows.find((row) => row.gap_id === "gap-no-transcript")!;
    // The original reason is kept and the repair says which one closed it.
    expect(repaired.reason).toBe(
      `${NO_TRANSCRIPT_CAPTURE_REASON} — no transcript, nothing to capture`,
    );
    expect(repaired.recovered_at).toBeTruthy();
    // The genuine skip is untouched: same state, same wording, still no timestamp.
    const genuine = rows.find((row) => row.gap_id === "gap-genuine")!;
    expect(genuine.reason).toBe("transcript prefix does not match the journal");
    expect(genuine.recovered_at).toBeNull();

    // Idempotent: a later open on the current file must not append a second note.
    initDatabase().close();
    stampPreviousSchemaVersion();
    initDatabase().close();
    expect(gapRows().find((row) => row.gap_id === "gap-no-transcript")!.reason).toBe(
      `${NO_TRANSCRIPT_CAPTURE_REASON} — no transcript, nothing to capture`,
    );
  }, 60_000);

  it("pipeline-status counts only the genuine open gap afterwards", () => {
    seedGaps();
    stampPreviousSchemaVersion();

    // `getPipelineStatus` reads through `openReadDb` (readonly), so asking it
    // cannot itself be what runs the repair.
    expect(getPipelineStatus({ dbPath }).attention.terminal.captureGapsOpen).toBe(2);

    initDatabase().close();

    expect(getPipelineStatus({ dbPath }).attention.terminal.captureGapsOpen).toBe(1);
  }, 60_000);

  it("the hook's no-transcript path closes them without waiting for an update", () => {
    seedGaps();
    const db = initDatabase();
    try {
      handleContinuityHook(
        {
          session_id: SESSION_EPHEMERAL,
          cwd: "/project",
          hook_event_name: "Stop",
          turn_id: "turn-1",
        },
        { db },
      );
      const states = db
        .prepare("SELECT gap_id, state FROM capture_gaps ORDER BY gap_id")
        .all() as Array<{ gap_id: string; state: string }>;
      expect(states).toEqual([
        { gap_id: "gap-genuine", state: "open" },
        { gap_id: "gap-no-transcript", state: "recovered" },
      ]);
    } finally {
      db.close();
    }
  }, 60_000);
});
