import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { getExtractionConfig, pendingExtractionCoreQuery } from "../src/pending-extraction.js";
import { getPipelineStatus } from "../src/pipeline-status.js";

/**
 * Issue #177 item 1 — the pending-extraction cwd exclusion was exact-match
 * while the extractor's own rule is a path BOUNDARY.
 *
 * `pendingExtractionCoreQuery` excluded a session only when `x.cwd = ?` equalled
 * an excluded project exactly, but `isExcludedProject` (src/fact-extractor.ts)
 * excludes on `project === p || project.startsWith(p + "/")`. A session whose
 * cwd is a SUBDIRECTORY of an excluded project was therefore selected by the
 * hook and by the worker and only dropped inside the extractor — which writes no
 * marker the continuity-mode query reads, so the session stayed pending forever.
 * After #175 that permanently pending lane reopens the automatic maintenance
 * budget on every wake (up to 20 worker spawns/hour, no model call, so the 24h
 * cap never trips) and can starve eligible sessions out of the LIMIT 40 page.
 *
 * The boundary must not become a raw prefix either: a SIBLING project that
 * merely starts with the same characters (`/pother` beside `/p`) stays eligible.
 *
 * Both query modes are fixed, so both are asserted here.
 */
let root = "";
let db: Database.Database;
const vector = new Array(384).fill(0.01);
const MODES = ["legacy", "continuity"] as const;

/** Two closed exchanges (the default `BACKFILL_MIN_EXCHANGES` is 2). */
function seed(sessionId: string, cwd: string | null): void {
  for (const line of [1, 3]) {
    insertExchange(db, {
      id: `${sessionId}-${line}`,
      sessionId,
      project: cwd ?? "/unset",
      cwd: cwd ?? "/unset",
      archivePath: path.join(root, `${sessionId}.jsonl`),
      timestamp: new Date(Date.parse("2026-09-20T00:00:00Z") + line * 1000).toISOString(),
      userMessage: `question ${line}`,
      assistantMessage: `answer ${line}`,
      lineStart: line,
      lineEnd: line + 1,
      closureState: "closed",
    }, vector);
  }
  // `cwd: null` is a real archive shape (pre-cwd rows); it must stay eligible.
  if (cwd === null) {
    db.prepare("UPDATE exchanges SET cwd = NULL WHERE session_id = ?").run(sessionId);
  }
}

function pending(mode: "legacy" | "continuity"): string[] {
  const { sql, params } = pendingExtractionCoreQuery(getExtractionConfig(), mode);
  return (db.prepare(sql).all(...params) as Array<{ sid: string }>).map((row) => row.sid);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-exclude-boundary-"));
  // Every root the code can reach stays inside the fixture — never ~/.config/memex.
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.BACKFILL_EXCLUDE_PROJECTS = "/p";
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.BACKFILL_EXCLUDE_PROJECTS;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("issue #177 — pending-extraction cwd exclusion is a path boundary", () => {
  it("expands three parameters per excluded term (the boundary form)", () => {
    const { params } = pendingExtractionCoreQuery(getExtractionConfig());
    expect(
      params,
      "one term needs (= ?, length(?), ? || '/') — the exact-match form bound only one",
    ).toEqual(["/p", "/p", "/p"]);
  });

  for (const mode of MODES) {
    it(`${mode}: the excluded project itself is not pending`, () => {
      seed("sess-exact", "/p");
      seed("sess-other", "/q");
      expect(pending(mode)).toEqual(["sess-other"]);
    });

    it(`${mode}: a SUBDIRECTORY of an excluded project is not pending`, () => {
      seed("sess-child", "/p/child/deeper");
      seed("sess-other", "/q");
      const ids = pending(mode);
      expect(
        ids,
        "the extractor drops /p/child/deeper silently, so selecting it means pending forever",
      ).not.toContain("sess-child");
      expect(ids).toContain("sess-other");
    });

    it(`${mode}: a sibling that merely shares the prefix stays pending`, () => {
      seed("sess-sibling", "/pother");
      seed("sess-sibling-deep", "/pother/src");
      const ids = pending(mode);
      expect(ids, "a raw prefix would swallow a distinct sibling project").toContain("sess-sibling");
      expect(ids).toContain("sess-sibling-deep");
    });

    it(`${mode}: one excluded-subpath exchange excludes the whole session (any-exchange rule)`, () => {
      seed("sess-mixed", "/q");
      db.prepare(
        `UPDATE exchanges SET cwd = '/p/child'
          WHERE session_id = 'sess-mixed'
            AND id = (SELECT MAX(id) FROM exchanges WHERE session_id = 'sess-mixed')`,
      ).run();
      expect(pending(mode)).not.toContain("sess-mixed");
    });

    it(`${mode}: a NULL-cwd session is unaffected by the exclusion`, () => {
      seed("sess-null", null);
      seed("sess-other", "/q");
      // A NULL cwd makes every exclusion term evaluate to NULL, so the row never
      // enters the NOT IN subquery — and the subquery's own
      // `x.session_id IS NOT NULL` guard (3-valued logic) still keeps a NULL
      // session_id out of it, which is the part that would silently drain
      // everything.
      const ids = pending(mode);
      expect(ids).toContain("sess-null");
      expect(ids).toContain("sess-other");
    });
  }

  it("pipeline-status reports an excluded SUBPATH session as excluded, not pending", () => {
    seed("sess-child", "/p/child");
    seed("sess-other", "/q");
    // The status gate row is the other consumer of the exclusion list; while it
    // was exact-match the SAME session was counted `pending` here and dropped
    // inside the extractor, so the two halves of one status output disagreed.
    const status = getPipelineStatus({ dbPath: process.env.MEMEX_DB_PATH, db });
    expect(status.extraction.excludedProject).toBe(1);
    expect(status.extraction.pending).toBe(1);
  });
});
