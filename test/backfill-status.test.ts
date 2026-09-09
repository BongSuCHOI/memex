import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getBackfillWorkStatus } from "../src/backfill-status.js";
import { FACT_EXTRACTION_POLICY_VERSION } from "../src/continuity-store.js";
import { initDatabase } from "../src/db.js";

describe("backfill completion status", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("separates a live extraction claim from terminal unresolved work", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-backfill-status-"));
    roots.push(root);
    const dbPath = path.join(root, "db.sqlite");
    const db = initDatabase({ dbPath });
    const insert = db.prepare(`
      INSERT INTO exchanges (
        id, project, timestamp, user_message, assistant_message,
        archive_path, line_start, line_end, session_id, cwd
      ) VALUES (?, '/tmp/project', ?, 'question', 'answer', '/tmp/source.jsonl', 1, 2, ?, '/tmp/project')
    `);
    for (const sessionId of ["active", "terminal"]) {
      insert.run(`${sessionId}-1`, "2026-09-09T00:00:00.000Z", sessionId);
      insert.run(`${sessionId}-2`, "2026-09-09T00:01:00.000Z", sessionId);
    }
    db.prepare(`
      INSERT INTO exchange_extraction_state
        (exchange_id, content_generation, policy_version, state)
      SELECT id, content_generation, ?, 'processed'
      FROM exchanges WHERE session_id = 'terminal'
    `).run(FACT_EXTRACTION_POLICY_VERSION);
    db.prepare(`
      INSERT INTO extraction_log
        (session_id, processed_at, extracted, saved, last_exchange_rowid)
      SELECT 'terminal', ?, -2, 0, MAX(rowid)
      FROM exchanges WHERE session_id = 'terminal'
    `).run("2026-09-09T00:02:00.000Z");
    db.prepare(`
      INSERT INTO memory_jobs (
        job_id, kind, partition_key, policy_version, state, available_at,
        lease_owner, lease_until, idempotency_key, created_at, updated_at
      ) VALUES (
        'active-job', 'fact_extract', 'session:active', ?, 'running', ?,
        'worker', ?, 'active-job', ?, ?
      )
    `).run(
      FACT_EXTRACTION_POLICY_VERSION,
      "2026-09-09T00:00:00.000Z",
      "2999-01-01T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
      "2026-09-09T00:00:00.000Z",
    );
    db.close();

    const status = getBackfillWorkStatus({ dbPath });
    expect(status.stages.extract).toBe(0);
    expect(status.active).toEqual({ total: 1, extract: 1 });
    expect(status.unresolved).toMatchObject({
      total: 1,
      extract: 1,
      legacyPermanentSessions: 1,
    });
  });
});
