import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { suppressConsole } from "./test-utils.js";

/**
 * Issue #166 (gate regression) — the `PRAGMA user_version` fast path turned a
 * latent writer bug into a shipped one.
 *
 * `insertFact` never set `lifecycle_updated_at`, so the column default `''`
 * survived the insert; the every-open migration pass then ran
 * `UPDATE facts SET lifecycle_updated_at = updated_at WHERE lifecycle_updated_at = ''`
 * and repaired it before anything read the row. With the pass skipped for a
 * current file, the Web UI's "import confirm" gate failed: a freshly exported
 * facts.jsonl carried `"lifecycle_updated_at":""` and the importer rejected the
 * device's own archive with "row failed protocol v4 schema validation".
 *
 * Two tests, two levels. The first drives the real loop in ONE process, without
 * the re-open that used to hide the bug. The second holds every data-normalizing
 * statement of the pass to the invariant that makes the fast path safe: it must
 * be a no-op on rows the current writers produce.
 */

vi.mock("../src/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/embeddings.js")>()),
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
}));

let temp: string;
let restoreConsole: () => void;

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-row-normalization-"));
  delete process.env.MEMEX_DB_PATH;
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_SYNC_DIR;
  delete process.env.MEMEX_SCHEMA_ALWAYS_MIGRATE;
  process.env.MEMEX_HOME = path.join(temp, "device-a");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  restoreConsole = suppressConsole();
});

afterEach(() => {
  restoreConsole();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("rows a current writer produces need no migration (issue #166 gate)", () => {
  it("exports a freshly written fact that the importer accepts, with no re-open", async () => {
    const { initDatabase } = await import("../src/db.js");
    const { insertFact } = await import("../src/fact-db.js");
    const control = await import("../src/sync-control.js");

    const deviceA = path.join(temp, "device-a");
    process.env.MEMEX_HOME = deviceA;
    const db = initDatabase();
    try {
      insertFact(db, {
        fact: "The runtime session store is Redis",
        category: "knowledge",
        scope_type: "global",
        scope_project: null,
        source_exchange_ids: [],
        embedding: new Array(384).fill(0.3),
      });
    } finally {
      db.close();
    }
    // The export runs in the SAME process: nothing re-opened the database, so
    // nothing ran the migration pass between the write and the read.
    const archive = control.exportGenerationArchive();
    expect(archive.counts.facts).toBe(1);

    // The other device previews the archive it was handed.
    const deviceB = path.join(temp, "device-b");
    process.env.MEMEX_HOME = deviceB;
    initDatabase().close();
    const preview = control.previewImportArchive(archive.path);
    expect(preview.rejected).toEqual([]);
    expect(preview.newFacts).toBe(1);
  }, 60_000);

  it("every data-normalizing migration statement is a no-op on freshly written rows", async () => {
    const { initDatabase, insertExchange, ROW_NORMALIZATION_INVARIANTS } =
      await import("../src/db.js");
    const { insertFact } = await import("../src/fact-db.js");

    const db = initDatabase();
    try {
      insertFact(db, {
        fact: "Deployments use blue green rollout",
        category: "decision",
        scope_type: "project",
        scope_project: temp,
        source_exchange_ids: [],
        embedding: new Array(384).fill(0.2),
      });
      insertExchange(db, {
        id: "ex-normalized",
        project: temp,
        cwd: temp,
        timestamp: "2026-09-18T00:00:00.000Z",
        userMessage: "Configure the redis session store",
        assistantMessage: "Wired the client",
        archivePath: path.join(temp, "rollout.jsonl"),
        lineStart: 1,
        lineEnd: 2,
        sessionId: "session-normalized",
        closureState: "closed",
        parserVersion: 2,
      }, new Array(384).fill(0.1));

      // Table-driven on purpose: a writer added later is covered the moment its
      // normalizer joins the list, and a writer that regresses fails here.
      expect(ROW_NORMALIZATION_INVARIANTS.length).toBeGreaterThan(5);
      const asserted: string[] = [];
      for (const invariant of ROW_NORMALIZATION_INVARIANTS) {
        if (invariant.repairSql) {
          asserted.push(invariant.name);
          expect(
            { name: invariant.name, changes: db.prepare(invariant.repairSql).run().changes },
          ).toEqual({ name: invariant.name, changes: 0 });
        }
        if (invariant.pendingSql) {
          asserted.push(invariant.name);
          expect({
            name: invariant.name,
            pending: Number((db.prepare(invariant.pendingSql).get() as { n: number }).n),
          }).toEqual({ name: invariant.name, pending: 0 });
        }
        // An entry with neither is documented as not load-bearing for new rows.
        if (!invariant.repairSql && !invariant.pendingSql) {
          expect(invariant.note, `${invariant.name} needs a note or an assertion`).toBeTruthy();
        }
      }
      expect(asserted.length).toBeGreaterThanOrEqual(6);
    } finally {
      db.close();
    }
  }, 60_000);
});
