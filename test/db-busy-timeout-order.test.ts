import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Issue #162 (R3) — the bounded wait has to be in force for the connection's
 * OWN setup, not only for the caller's statements.
 *
 * Through 0.7.23 `initializeConnection` set `busy_timeout = 5000` and
 * `initDatabase({busyTimeoutMs})` re-set it AFTER `journal_mode = WAL` and the
 * whole migration pass. A hook with a 1 s budget therefore still spent up to
 * 5 s inside init while the host killed it at 3 s. The order below is the fix,
 * so it is asserted directly.
 */
const pragmas = vi.hoisted(() => [] as string[]);

vi.mock("better-sqlite3", async (importOriginal) => {
  const actual = (await importOriginal<{ default: new (...args: unknown[]) => unknown }>()).default;
  class RecordingDatabase extends (actual as new (...args: never[]) => {
    pragma(source: string, options?: unknown): unknown;
  }) {
    pragma(source: string, options?: unknown): unknown {
      pragmas.push(String(source).trim());
      return super.pragma(source, options);
    }
  }
  return { default: RecordingDatabase };
});

let root: string;

beforeEach(() => {
  pragmas.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-pragma-order-"));
  process.env.MEMEX_HOME = path.join(root, "memex-home");
  process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("initDatabase busy_timeout ordering", () => {
  it("applies the requested busy_timeout before WAL and every other init pragma", async () => {
    const { initDatabase } = await import("../src/db.js");
    const db = initDatabase({ busyTimeoutMs: 137 });
    try {
      expect(pragmas[0]).toBe("busy_timeout = 137");
      const wal = pragmas.findIndex((p) => p.startsWith("journal_mode"));
      expect(wal).toBeGreaterThan(0);
      // Nothing may re-raise the wait afterwards.
      expect(pragmas.filter((p) => p.startsWith("busy_timeout"))).toEqual([
        "busy_timeout = 137",
      ]);
      expect(db.pragma("busy_timeout", { simple: true })).toBe(137);
    } finally {
      db.close();
    }
  });

  it("keeps the 5 s default first when no budget is given", async () => {
    const { initDatabase } = await import("../src/db.js");
    const db = initDatabase();
    try {
      expect(pragmas[0]).toBe("busy_timeout = 5000");
    } finally {
      db.close();
    }
  });
});
