import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { initDatabase } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATION_LIST_FINGERPRINT } from "../src/schema-version.js";
import { CONTINUITY_SCHEMA_VERSION } from "../src/continuity-store.js";

/**
 * Issue #166 — `initDatabase()` re-ran the whole migration pass on EVERY open,
 * and the pass is not free: on a 92 MB fixture (15,000 exchanges) one open cost
 * 1,040 ms, of which the DDL was under 1 ms. The rest was data backfill that had
 * nothing left to do — `UPDATE exchanges SET project_id …` (371 ms, one
 * statement), `refreshExchangeMetadata`'s per-row UPDATE (15,000 calls, 197 ms),
 * the COMMITs of those dirty pages (173 ms) and the row scan that drives them
 * (146 ms). Five hooks opening that database at SessionStart is where the work
 * Mac's 930 ms lock wait and its skipped captures came from.
 *
 * So the pass is gated on `PRAGMA user_version`: it runs when the file is older
 * than the code, sets the version in the same transaction, and is skipped
 * entirely afterwards.
 */

let root: string;
let dbPath: string;

/** Every SQL statement one call executes, in order. */
function recordSql<T>(run: () => T): { result: T; sql: string[] } {
  const sql: string[] = [];
  const probe = new Database(":memory:");
  const statementProto = Object.getPrototypeOf(probe.prepare("SELECT 1"));
  probe.close();
  const originals: Array<[Record<string, unknown>, string, unknown]> = [];
  const wrap = (target: Record<string, unknown>, name: string, text: (self: unknown, args: unknown[]) => unknown) => {
    const original = target[name] as (...args: unknown[]) => unknown;
    originals.push([target, name, original]);
    target[name] = function (this: unknown, ...args: unknown[]) {
      sql.push(String(text(this, args) ?? "").replace(/\s+/g, " ").trim());
      return original.apply(this, args);
    };
  };
  wrap(Database.prototype as unknown as Record<string, unknown>, "exec", (_self, args) => args[0]);
  wrap(Database.prototype as unknown as Record<string, unknown>, "pragma", (_self, args) => `PRAGMA ${args[0]}`);
  for (const method of ["run", "get", "all", "iterate"]) {
    wrap(statementProto as Record<string, unknown>, method, (self) => (self as { source?: string }).source);
  }
  try {
    return { result: run(), sql };
  } finally {
    for (const [target, name, original] of originals) target[name] = original;
  }
}

/** Statements that CHANGE the database — what a current file must not run. */
function mutating(sql: string[]): string[] {
  return sql.filter((text) =>
    /^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text) ||
    /^PRAGMA (table_info|user_version = )/i.test(text));
}

function userVersion(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

/** `rows` exchanges, so the per-row backfill of the pass has real work. */
function seedExchanges(rows: number): void {
  const db = initDatabase();
  try {
    const insert = db.prepare(`
      INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message,
        archive_path, line_start, line_end)
      VALUES (?, '/project', '2026-09-18T00:00:00.000Z', ?, ?, '/archive.jsonl', 1, 2)
    `);
    db.transaction(() => {
      for (let i = 0; i < rows; i++) insert.run(randomUUID(), `ask ${i}`, `answer ${i}`);
    })();
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-schema-fast-"));
  dbPath = path.join(root, "home", "conversation-index", "db.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = dbPath;
  delete process.env.MEMEX_SCHEMA_ALWAYS_MIGRATE;
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("schema migration fast path (issue #166)", () => {
  it("migrates a brand-new database once and records the schema version", () => {
    const first = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    expect(first.sql.some((text) => /^CREATE TABLE IF NOT EXISTS exchanges/i.test(text))).toBe(true);
    expect(userVersion()).toBe(CURRENT_SCHEMA_VERSION);

    // The second open of an unchanged file must not touch the schema at all.
    const second = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    expect(mutating(second.sql)).toEqual([]);
    expect(userVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("migrates an old database exactly once", () => {
    initDatabase().close();
    const old = new Database(dbPath);
    old.pragma("user_version = 1");
    old.close();

    const again = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    expect(mutating(again.sql).length).toBeGreaterThan(0);
    expect(userVersion()).toBe(CURRENT_SCHEMA_VERSION);

    const third = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    expect(mutating(third.sql)).toEqual([]);
  });

  it("leaves nothing for the second open to do on a database with rows", () => {
    seedExchanges(3_000);
    // The file is current again after seedExchanges' own open, so force the
    // full pass to measure both halves of the change on the same file.
    const reset = new Database(dbPath);
    reset.pragma("user_version = 0");
    reset.close();

    const migrateStart = Date.now();
    initDatabase().close();
    const migrateMs = Date.now() - migrateStart;

    const fastStart = Date.now();
    const fast = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    const fastMs = Date.now() - fastStart;

    expect(mutating(fast.sql)).toEqual([]);
    // The open that has nothing to do costs pragmas, not a table walk.
    expect(fastMs).toBeLessThan(60);
    expect(fastMs).toBeLessThan(migrateMs);
  }, 60_000);

  it("pins the migration list to CURRENT_SCHEMA_VERSION", () => {
    // A future migration that forgets the version bump would open every existing
    // database on the fast path and never run — so the list is fingerprinted.
    const fingerprintOf = (statements: string[]) =>
      createHash("sha256").update(statements.join("\n")).digest("hex").slice(0, 16);

    const first = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    const fingerprint = fingerprintOf(first.sql);
    expect(fingerprint).toBe(MIGRATION_LIST_FINGERPRINT);

    // Deterministic: a second brand-new file must produce the same list.
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    const other = recordSql(() => {
      const db = initDatabase();
      db.close();
    });
    expect(fingerprintOf(other.sql)).toBe(fingerprint);

    // The whole-schema version is deliberately above the continuity schema
    // version that `ensureContinuitySchema` writes as its own stage marker.
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(CONTINUITY_SCHEMA_VERSION);
  });
});
