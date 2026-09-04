import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { ensureExtractionTarget, readExtractionTargetItems } from "../src/continuity-store.js";
import { pendingExtractionCoreQuery } from "../src/pending-extraction.js";

/**
 * A legacy SEED marker was inferred from the existence of any one fact and
 * advanced to the session live MAX(rowid). That cannot prove the remaining
 * exchanges were ever presented to the extractor. Continuity therefore treats
 * it only as a compatibility hint and targets every generation without an
 * explicit processed state.
 */

const SESSION_ID = "01b00001-aaaa-4bbb-8ccc-ccccccccccc1";
const PROJECT = "/tmp/backfill-seed-watermark/project";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("legacy extraction marker migration", () => {
  it.each([-1, -2])(
    "does not promote unseen generations to processed for marker %s",
    (legacyMarker) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-backfill-seed-"));
    const home = path.join(tmp, "home");
    const priorDb = process.env.MEMEX_DB_PATH;
    const priorHome = process.env.MEMEX_HOME;
    process.env.MEMEX_DB_PATH = path.join(home, "conversation-index", "db.sqlite");
    process.env.MEMEX_HOME = home;
    const db = initDatabase();
    try {
      const ids: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const id = `seed-exchange-${i}`;
        ids.push(id);
        db.prepare(`
          INSERT INTO exchanges
            (id, project, timestamp, user_message, assistant_message, archive_path,
             line_start, line_end, session_id, cwd, is_sidechain)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(
          id,
          PROJECT,
          new Date(Date.now() + i * 1000).toISOString(),
          `질문 ${i}`,
          `답변 ${i}`,
          "/tmp/seed-fixture.jsonl",
          i,
          i,
          SESSION_ID,
          PROJECT,
        );
      }
      insertFact(db, {
        fact: "시드 대상 사실",
        category: "decision",
        scope_type: "project",
        scope_project: PROJECT,
        source_exchange_ids: [ids[0]],
        embedding: null,
      });
      const maxRowid = (db.prepare(
        "SELECT MAX(rowid) AS rowid FROM exchanges WHERE session_id = ?",
      ).get(SESSION_ID) as { rowid: number }).rowid;
      db.prepare(`
        INSERT INTO extraction_log
          (session_id, processed_at, extracted, saved, last_exchange_rowid)
        VALUES (?, ?, ?, ?, ?)
      `).run(SESSION_ID, new Date().toISOString(), legacyMarker, legacyMarker, maxRowid);

      const pending = pendingExtractionCoreQuery({
        minExchanges: 2,
        excludeProjects: [],
      }, "continuity");
      expect(db.prepare(pending.sql).all(...pending.params)).toEqual([
        expect.objectContaining({ sid: SESSION_ID }),
      ]);
      const target = ensureExtractionTarget(db, {
        sessionId: SESSION_ID,
        project: PROJECT,
      })!;
      expect(readExtractionTargetItems(db, target.targetId, 0, 10).map(
        (item) => item.exchange_id,
      )).toEqual(ids);
      expect(db.prepare(`
        SELECT COUNT(*) AS n FROM exchange_extraction_state
        WHERE state = 'processed'
      `).get()).toEqual({ n: 0 });
    } finally {
      db.close();
      if (priorDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = priorDb;
      if (priorHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = priorHome;
    }
  });
});
