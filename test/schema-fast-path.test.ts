import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applySchemaMigrations, initDatabase } from "../src/db.js";
import { schemaVersionCheck } from "../src/lifecycle.js";
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

  /**
   * #166 review — the taxonomy uniqueness migration swallows its own failure on
   * purpose ("a database that still refuses the constraint must not brick
   * startup"), but the version write was unconditional: a database left without
   * the unique index recorded version 8 anyway, and the fast path then never
   * retried the repair. A swallowed failure may cost the repair, never the retry.
   */
  it("does not record the schema version when a migration was skipped", () => {
    const indexExists = (name: string): boolean => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
      } finally {
        db.close();
      }
    };

    initDatabase().close();
    const seed = new Database(dbPath);
    // A file from before the domain index existed, carrying two case-duplicate
    // domains whose categories collide when the merge reassigns them: the merge
    // transaction rolls back on the category index that IS already there.
    seed.exec(`
      DROP INDEX IF EXISTS idx_ontology_domains_name;
      INSERT INTO ontology_domains (id, name, created_at)
        VALUES ('d-keep', 'Infra', '2026-01-01T00:00:00.000Z'),
               ('d-dup', 'infra', '2026-01-02T00:00:00.000Z');
      INSERT INTO ontology_categories (id, domain_id, name, created_at)
        VALUES ('c-keep', 'd-keep', 'Cache', '2026-01-01T00:00:00.000Z'),
               ('c-dup', 'd-dup', 'Cache', '2026-01-02T00:00:00.000Z');
      PRAGMA user_version = 0;
    `);
    seed.close();

    initDatabase().close();
    // The repair did not happen, so the version must not claim it did.
    expect(indexExists("idx_ontology_domains_name")).toBe(false);
    expect(userVersion()).toBeLessThan(CURRENT_SCHEMA_VERSION);

    // Remove the conflict: the next open completes the pass and records it.
    const repaired = new Database(dbPath);
    repaired.exec("DELETE FROM ontology_categories WHERE id = 'c-dup'; DELETE FROM ontology_domains WHERE id = 'd-dup';");
    repaired.close();

    initDatabase().close();
    expect(indexExists("idx_ontology_domains_name")).toBe(true);
    expect(userVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  /**
   * #166 third review — the fast-path decision was made BEFORE `BEGIN IMMEDIATE`,
   * so several openers of an old database (five hooks at SessionStart, plus the
   * sync-import that runs there) all read a version below the current one and then
   * ran the whole heavy pass one after another — the first-session contention this
   * issue is about, reintroduced. The authoritative read belongs inside the lock.
   */
  it("re-reads the version inside the write lock, so a second opener runs nothing", () => {
    const winner = initDatabase();
    try {
      expect(userVersion()).toBe(CURRENT_SCHEMA_VERSION);
      // A second connection while the first is still open: it must take the lock,
      // see the version the winner committed, and execute no migration at all.
      const second = recordSql(() => {
        const db = initDatabase();
        db.close();
      });
      expect(mutating(second.sql)).toEqual([]);
      expect(second.sql.some((text) => /^PRAGMA user_version = /i.test(text))).toBe(false);
    } finally {
      winner.close();
    }
  });

  it("runs exactly one migration pass when two processes open an old database at once", async () => {
    initDatabase().close();
    const stale = new Database(dbPath);
    stale.pragma("user_version = 0");
    stale.close();

    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const child = path.join(root, "open-once.mjs");
    fs.writeFileSync(child, [
      "import path from 'node:path';",
      "import { pathToFileURL } from 'node:url';",
      "const dist = pathToFileURL(path.join(process.argv[2], 'dist', 'db.js')).href;",
      "const { applySchemaMigrations } = await import(dist);",
      "const result = applySchemaMigrations();",
      "process.stdout.write(JSON.stringify({ migrated: result.migrated, version: result.version }));",
    ].join("\n"));

    const open = () => new Promise<{ migrated: boolean; version: number }>((resolve, reject) => {
      const proc = spawn(process.execPath, [child, repoRoot], {
        env: { ...process.env, MEMEX_HOME: path.join(root, "home"), MEMEX_DB_PATH: dbPath },
      });
      let out = "";
      let err = "";
      proc.stdout.on("data", (chunk) => { out += chunk; });
      proc.stderr.on("data", (chunk) => { err += chunk; });
      proc.on("error", reject);
      proc.on("exit", (code) => code === 0
        ? resolve(JSON.parse(out))
        : reject(new Error(`exit ${code}: ${err}`)));
    });

    const [a, b] = await Promise.all([open(), open()]);
    // One migrates, the other waits on BEGIN IMMEDIATE and then has nothing to do.
    expect([a.migrated, b.migrated].filter(Boolean)).toHaveLength(1);
    expect(a.version).toBe(CURRENT_SCHEMA_VERSION);
    expect(b.version).toBe(CURRENT_SCHEMA_VERSION);
  }, 60_000);

  it("reports whether the pass actually ran, not whether it was needed", () => {
    initDatabase().close();
    // Nothing to do: `migrated` must be false even though the file was current
    // before this call too — the claim is about THIS call's work.
    expect(applySchemaMigrations()).toMatchObject({ migrated: false, skipped: [] });
    const stale = new Database(dbPath);
    stale.pragma("user_version = 0");
    stale.close();
    expect(applySchemaMigrations()).toMatchObject({
      migrated: true, version: CURRENT_SCHEMA_VERSION, skipped: [],
    });
  });

  /** #166 third review — doctor could not say what the update's exit 3 meant. */
  it("doctor reports the schema version without migrating anything", () => {
    expect(schemaVersionCheck().detail).toMatch(/unknown/);

    initDatabase().close();
    const current = schemaVersionCheck();
    expect(current.name).toBe("schema-version");
    expect(current.status).toBe("ok");
    expect(current.detail).toContain(`current (v${CURRENT_SCHEMA_VERSION})`);

    const behind = new Database(dbPath);
    behind.pragma("user_version = 7");
    behind.close();
    const pending = schemaVersionCheck();
    expect(pending.status).toBe("warn");
    expect(pending.detail).toContain(`pending migrations: v7 < v${CURRENT_SCHEMA_VERSION}`);
    expect(pending.detail).toContain("memex update");
    // Reading the version may never migrate: the file stays where it was.
    expect(userVersion()).toBe(7);
  });

  it("pins the migration list to CURRENT_SCHEMA_VERSION", () => {
    // A future migration that forgets the version bump would open every existing
    // database on the fast path and never run — so the list is fingerprinted.
    // The envelope (BEGIN/COMMIT/SAVEPOINT) and the version gate are not
    // migrations: fingerprinting them would demand a schema bump for a change to
    // how the pass is decided, which is not a schema change.
    const fingerprintOf = (statements: string[]) =>
      createHash("sha256").update(
        statements.filter((text) =>
          !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(text) &&
          !/^PRAGMA user_version/i.test(text)).join("\n"),
      ).digest("hex").slice(0, 16);

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
