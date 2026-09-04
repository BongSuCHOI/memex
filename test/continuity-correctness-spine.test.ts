import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings.js")>();
  return {
    ...actual,
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () => new Array(384).fill(0.01),
  };
});

import { deleteExchange, initDatabase, insertExchange } from "../src/db.js";
import { ingestPrefixExchanges } from "../src/archive-ingestion.js";
import {
  CONTINUITY_SCHEMA_VERSION,
  claimExtractionTarget,
  claimMemoryJobById,
  commitExtractionPage,
  completeMemoryJob,
  createCheckpointWithJob,
  ensureContinuitySchema,
  ensureExtractionTarget,
  failMemoryJob,
  readExtractionTargetItems,
  recordExtractionFailure,
  supersedeStaleExtractionTarget,
} from "../src/continuity-store.js";
import type { ConversationExchange } from "../src/types.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";

let root: string;
let db: Database.Database;

function exchange(id: string, lineEnd: number, message = `decision-${id}`): ConversationExchange {
  return {
    id,
    project: "/project",
    timestamp: `2026-09-03T00:00:${lineEnd.toString().padStart(2, "0")}Z`,
    userMessage: message,
    assistantMessage: `ack-${message}`,
    archivePath: "/archive/session.jsonl",
    lineStart: lineEnd,
    lineEnd,
    sessionId: "session-1",
    cwd: "/project",
    closureState: "closed",
  };
}

function put(value: ConversationExchange): boolean {
  return insertExchange(db, value, new Array(384).fill(0.01));
}

function columnSet(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(({ name }) => name),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-continuity-p1-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
  db = initDatabase();
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // already closed
  }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Continuity v1 schema and migration", () => {
  it("is additive, explicitly versioned, rerunnable, and preserves exchange rowid", () => {
    put(exchange("e1", 1));
    const before = db.prepare("SELECT rowid FROM exchanges WHERE id = 'e1'").get() as {
      rowid: number;
    };

    ensureContinuitySchema(db);
    ensureContinuitySchema(db);

    const after = db.prepare(`
      SELECT rowid, exchange_seq, content_hash, content_generation, closure_state
      FROM exchanges WHERE id = 'e1'
    `).get() as Record<string, unknown>;
    expect(after.rowid).toBe(before.rowid);
    expect(after.exchange_seq).toBe(1);
    expect(after.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(after.content_generation).toBe(1);
    expect(after.closure_state).toBe("closed");
    expect(db.pragma("user_version", { simple: true })).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(
      (db.prepare("SELECT value FROM continuity_schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value,
    ).toBe(String(CONTINUITY_SCHEMA_VERSION));
  });

  it("upgrades a released-shape exchange table and survives repeated startup", () => {
    db.close();
    fs.rmSync(process.env.MEMEX_DB_PATH!);
    const legacy = new Database(process.env.MEMEX_DB_PATH!);
    legacy.exec(`
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL, assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL, line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL, embedding BLOB, last_indexed INTEGER,
        parent_uuid TEXT, is_sidechain BOOLEAN DEFAULT 0, session_id TEXT,
        cwd TEXT, git_branch TEXT, codex_version TEXT, thinking_level TEXT,
        thinking_disabled BOOLEAN, thinking_triggers TEXT,
        embedding_version INTEGER NOT NULL DEFAULT 0,
        provenance TEXT NOT NULL DEFAULT '["human_assertion","assistant_generated"]',
        assistant_learnable BOOLEAN NOT NULL DEFAULT 0,
        has_memex_recall BOOLEAN NOT NULL DEFAULT 0
      );
      INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, session_id)
      VALUES ('legacy-e', '/legacy', '2026-01-01T00:00:00Z', 'human', 'assistant',
              '/legacy.jsonl', 1, 2, 'legacy-s');
    `);
    legacy.close();

    db = initDatabase();
    const first = db.prepare(`
      SELECT rowid, content_generation, content_hash FROM exchanges WHERE id = 'legacy-e'
    `).get() as Record<string, unknown>;
    db.close();
    db = initDatabase();
    const second = db.prepare(`
      SELECT rowid, content_generation, content_hash FROM exchanges WHERE id = 'legacy-e'
    `).get() as Record<string, unknown>;
    expect(second).toEqual(first);
  });

  it("rolls an interrupted schema transaction back and reruns cleanly", () => {
    const crashPath = path.join(root, "migration-crash.sqlite");
    const migrationDb = new Database(crashPath);
    migrationDb.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE exchanges (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL, assistant_message TEXT NOT NULL,
        archive_path TEXT NOT NULL, line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL, session_id TEXT
      );
      CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY, exchange_id TEXT NOT NULL, tool_name TEXT NOT NULL,
        tool_input TEXT, tool_result TEXT, is_error BOOLEAN, timestamp TEXT
      );
      INSERT INTO exchanges VALUES
        ('e', '/p', '2026-01-01T00:00:00Z', 'u', 'a', '/a', 1, 2, 's');
    `);
    expect(() => ensureContinuitySchema(migrationDb, {
      afterStructuralDdl: () => { throw new Error("kill-after-ddl"); },
    })).toThrow("kill-after-ddl");
    expect(migrationDb.pragma("user_version", { simple: true })).toBe(0);
    expect(
      migrationDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memory_jobs'").get(),
    ).toBeUndefined();

    ensureContinuitySchema(migrationDb);
    expect(migrationDb.pragma("user_version", { simple: true })).toBe(CONTINUITY_SCHEMA_VERSION);
    expect(migrationDb.prepare(`
      SELECT rowid, content_generation, closure_state FROM exchanges WHERE id = 'e'
    `).get()).toEqual({ rowid: 1, content_generation: 1, closure_state: "closed" });
    migrationDb.close();
  });

  it("upgrades the Phase 1 Continuity schema with journal rewrite guards", () => {
    db.exec("ALTER TABLE journal_streams DROP COLUMN source_mtime_ms");
    db.exec("ALTER TABLE journal_streams DROP COLUMN source_guard_start");
    db.exec("ALTER TABLE journal_streams DROP COLUMN source_guard_hash");
    db.pragma("user_version = 1");
    expect(() => ensureContinuitySchema(db, {
      afterMigrationStage: (stage) => {
        if (stage === "journal-source-guard-columns") throw new Error("kill-guard-migration");
      },
    })).toThrow("kill-guard-migration");
    expect(columnSet(db, "journal_streams").has("source_mtime_ms")).toBe(false);
    expect(columnSet(db, "journal_streams").has("source_guard_start")).toBe(false);
    expect(columnSet(db, "journal_streams").has("source_guard_hash")).toBe(false);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    const stages: string[] = [];
    ensureContinuitySchema(db, {
      afterMigrationStage: (stage) => stages.push(stage),
    });
    expect(columnSet(db, "journal_streams").has("source_mtime_ms")).toBe(true);
    expect(columnSet(db, "journal_streams").has("source_guard_start")).toBe(true);
    expect(columnSet(db, "journal_streams").has("source_guard_hash")).toBe(true);
    expect(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_exclusions'",
    ).get()).toEqual({ 1: 1 });
    expect(stages).toContain("journal-source-mtime-column");
    expect(stages).toContain("journal-source-guard-columns");
    expect(db.pragma("user_version", { simple: true })).toBe(CONTINUITY_SCHEMA_VERSION);
  });

  it("rolls back every migration write-stage crash and preserves durable legacy rows", () => {
    const stages = [
      "exchange-seq-column",
      "content-hash-column",
      "content-generation-column",
      "closure-state-column",
      "parser-version-column",
      "continuity-tables",
      "continuity-core-tables",
      "identity-tables",
      "identity-columns",
      "identity-backfill",
      "identity-triggers",
      "chronicle-table",
      "chronicle-backfill",
      "incident-tables",
      "telemetry-table",
      "chronicle-indexes",
      "continuity-indexes",
      "continuity-core-indexes",
      "fts-rebuild",
      "exchange-metadata",
      "schema-meta",
      "user-version",
    ] as const;
    for (const stage of stages) {
      const migrationDb = new Database(path.join(root, `migration-${stage}.sqlite`));
      migrationDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE exchanges (
          id TEXT PRIMARY KEY, project TEXT NOT NULL, timestamp TEXT NOT NULL,
          user_message TEXT NOT NULL, assistant_message TEXT NOT NULL,
          archive_path TEXT NOT NULL, line_start INTEGER NOT NULL,
          line_end INTEGER NOT NULL, session_id TEXT
        );
        CREATE TABLE tool_calls (
          id TEXT PRIMARY KEY, exchange_id TEXT NOT NULL, tool_name TEXT NOT NULL,
          tool_input TEXT, tool_result TEXT, is_error BOOLEAN, timestamp TEXT
        );
        CREATE TABLE facts (id TEXT PRIMARY KEY, source_exchange_ids TEXT NOT NULL);
        CREATE TABLE fact_revisions (id TEXT PRIMARY KEY, fact_id TEXT NOT NULL, payload TEXT);
        CREATE TABLE recall_events (id TEXT PRIMARY KEY, session_id TEXT, payload TEXT);
        INSERT INTO exchanges VALUES
          ('legacy-e', '/p', '2026-01-01T00:00:00Z', 'human', 'assistant', '/a', 1, 2, 's');
        INSERT INTO facts VALUES ('fact-1', '["legacy-e"]');
        INSERT INTO fact_revisions VALUES ('revision-1', 'fact-1', 'before');
        INSERT INTO recall_events VALUES ('recall-1', 's', 'before');
      `);
      if (stage === "fts-rebuild") {
        migrationDb.exec(`
          CREATE VIRTUAL TABLE exchanges_fts USING fts5(
            user_message, assistant_message,
            content='exchanges', content_rowid='rowid'
          );
        `);
      }
      expect(() => ensureContinuitySchema(migrationDb, {
        afterMigrationStage: (observed) => {
          if (observed === stage) throw new Error(`kill-${stage}`);
        },
      })).toThrow(`kill-${stage}`);
      expect(migrationDb.pragma("user_version", { simple: true })).toBe(0);
      expect(columnSet(migrationDb, "exchanges").has("exchange_seq")).toBe(false);
      expect(migrationDb.prepare(
        "SELECT id, source_exchange_ids FROM facts",
      ).all()).toEqual([{ id: "fact-1", source_exchange_ids: '["legacy-e"]' }]);
      expect(migrationDb.prepare("SELECT payload FROM fact_revisions").get()).toEqual({ payload: "before" });
      expect(migrationDb.prepare("SELECT payload FROM recall_events").get()).toEqual({ payload: "before" });

      ensureContinuitySchema(migrationDb);
      expect(migrationDb.pragma("user_version", { simple: true })).toBe(CONTINUITY_SCHEMA_VERSION);
      expect(migrationDb.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 1 });
      migrationDb.close();
    }
  });
});

describe("checkpoint outbox and lease", () => {
  const input = {
    checkpoint: {
      checkpointId: "cp-1",
      sessionId: "session-1",
      ordinal: 1,
      kind: "stop" as const,
      idempotencyKey: "checkpoint:cp-1",
      fromCursor: 0,
      throughCursor: 1,
    },
    job: {
      kind: "fact_extract",
      partitionKey: "session:session-1",
      policyVersion: "p1",
      priority: 20,
      idempotencyKey: "job:cp-1",
    },
    now: "2026-09-03T00:00:00.000Z",
  };

  it("rolls back checkpoint and job at every injected half-state boundary", () => {
    for (const boundary of ["checkpoint", "job"] as const) {
      expect(() =>
        createCheckpointWithJob(db, {
          ...input,
          afterCheckpoint: boundary === "checkpoint"
            ? () => { throw new Error("crash-after-checkpoint"); }
            : undefined,
          afterJob: boundary === "job"
            ? () => { throw new Error("crash-after-job"); }
            : undefined,
        }),
      ).toThrow(`crash-after-${boundary}`);
      expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM memory_jobs").get() as { n: number }).n).toBe(0);
    }
  });

  it("rejects idempotency-key reuse for a different semantic checkpoint or job", () => {
    createCheckpointWithJob(db, input);
    expect(() => createCheckpointWithJob(db, {
      ...input,
      checkpoint: { ...input.checkpoint, throughCursor: 2 },
    })).toThrow(/checkpoint idempotency collision/);
    expect(() => createCheckpointWithJob(db, {
      ...input,
      job: { ...input.job, partitionKey: "session:other" },
    })).toThrow(/job idempotency collision/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_jobs").get()).toEqual({ n: 1 });
  });

  it("deduplicates delivery and rejects stale or expired owners", () => {
    const first = createCheckpointWithJob(db, input);
    for (let delivery = 2; delivery <= 10; delivery++) {
      const duplicate = createCheckpointWithJob(db, input);
      expect(duplicate.jobId).toBe(first.jobId);
      expect(duplicate.created).toBe(false);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_jobs").get() as { n: number }).n).toBe(1);

    const t0 = new Date("2026-09-03T00:00:00.000Z");
    const owner1 = claimMemoryJobById(db, {
      jobId: first.jobId,
      owner: "owner-1",
      now: t0,
      leaseMs: 1000,
    });
    expect(owner1).not.toBeNull();
    expect(
      completeMemoryJob(db, {
        jobId: first.jobId,
        owner: "owner-1",
        leaseGeneration: owner1!.lease_generation,
        now: new Date(t0.getTime() + 1001),
      }),
    ).toBe(false);
    expect(
      failMemoryJob(db, {
        jobId: first.jobId,
        owner: "owner-1",
        leaseGeneration: owner1!.lease_generation,
        error: "late failure",
        retry: false,
        now: new Date(t0.getTime() + 1001),
      }),
    ).toBe(false);
    const owner2 = claimMemoryJobById(db, {
      jobId: first.jobId,
      owner: "owner-2",
      now: new Date(t0.getTime() + 1001),
    });
    expect(owner2!.lease_generation).toBeGreaterThan(owner1!.lease_generation);
    expect(
      completeMemoryJob(db, {
        jobId: first.jobId,
        owner: "owner-1",
        leaseGeneration: owner1!.lease_generation,
        now: new Date(t0.getTime() + 1002),
      }),
    ).toBe(false);
    expect(
      completeMemoryJob(db, {
        jobId: first.jobId,
        owner: "owner-2",
        leaseGeneration: owner2!.lease_generation,
        now: new Date(t0.getTime() + 1002),
      }),
    ).toBe(true);
  });

  it("keeps retry and dead jobs discoverable after restart", () => {
    const created = createCheckpointWithJob(db, input);
    const claimed = claimMemoryJobById(db, {
      jobId: created.jobId,
      owner: "owner",
      now: new Date(input.now),
    })!;
    expect(
      failMemoryJob(db, {
        jobId: created.jobId,
        owner: "owner",
        leaseGeneration: claimed.lease_generation,
        error: "provider",
        retry: true,
        now: new Date(input.now),
      }),
    ).toBe(true);
    expect(
      (db.prepare("SELECT state FROM memory_jobs WHERE job_id = ?").get(created.jobId) as {
        state: string;
      }).state,
    ).toBe("retry");
  });

  it("applies backoff and promotes an exhausted retry budget to dead", () => {
    const created = createCheckpointWithJob(db, {
      ...input,
      checkpoint: { ...input.checkpoint, checkpointId: "cp-budget", idempotencyKey: "cp-budget" },
      job: { ...input.job, idempotencyKey: "job-budget", maxAttempts: 2 },
    });
    const t0 = new Date(input.now);
    const first = claimMemoryJobById(db, {
      jobId: created.jobId, owner: "o1", now: t0,
    })!;
    expect(failMemoryJob(db, {
      jobId: created.jobId,
      owner: "o1",
      leaseGeneration: first.lease_generation,
      error: "again",
      retry: true,
      now: t0,
    })).toBe(true);
    const retryRow = db.prepare(
      "SELECT state, available_at FROM memory_jobs WHERE job_id = ?",
    ).get(created.jobId) as { state: string; available_at: string };
    expect(retryRow.state).toBe("retry");
    expect(retryRow.available_at > t0.toISOString()).toBe(true);
    const second = claimMemoryJobById(db, {
      jobId: created.jobId,
      owner: "o2",
      now: new Date(retryRow.available_at),
    })!;
    expect(failMemoryJob(db, {
      jobId: created.jobId,
      owner: "o2",
      leaseGeneration: second.lease_generation,
      error: "exhausted",
      retry: true,
      now: new Date(retryRow.available_at),
    })).toBe(true);
    expect(db.prepare(
      "SELECT state FROM memory_jobs WHERE job_id = ?",
    ).get(created.jobId)).toEqual({ state: "dead" });
  });

  it("dead-letters an expired final extraction attempt with its exact remaining range", () => {
    put(exchange("lease-e1", 1));
    put(exchange("lease-e2", 2));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
      now: input.now,
    })!;
    db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE job_id = ?").run(target.jobId);
    const t0 = new Date(input.now);
    expect(claimExtractionTarget(db, target, "crashed-owner", t0)).not.toBeNull();
    expect(claimMemoryJobById(db, {
      jobId: target.jobId,
      owner: "recovery-owner",
      now: new Date(t0.getTime() + 30 * 60_000 + 1),
    })).toBeNull();
    expect(db.prepare(
      "SELECT state, lease_owner FROM memory_jobs WHERE job_id = ?",
    ).get(target.jobId)).toEqual({ state: "dead", lease_owner: null });
    expect(db.prepare(`
      SELECT from_ordinal, through_ordinal, state, error_kind
      FROM extraction_failed_ranges WHERE target_id = ?
    `).get(target.targetId)).toEqual({
      from_ordinal: 1,
      through_ordinal: 2,
      state: "failed-visible",
      error_kind: "lease_expired",
    });
    expect(db.prepare(
      "SELECT state FROM checkpoints WHERE checkpoint_id = (SELECT checkpoint_id FROM memory_jobs WHERE job_id = ?)",
    ).get(target.jobId)).toEqual({ state: "failed-visible" });
  });

  it("serializes live jobs in the same session partition", () => {
    const first = createCheckpointWithJob(db, input);
    const second = createCheckpointWithJob(db, {
      ...input,
      checkpoint: { ...input.checkpoint, checkpointId: "cp-2", ordinal: 2, idempotencyKey: "cp-2" },
      job: { ...input.job, idempotencyKey: "job-2" },
    });
    const now = new Date(input.now);
    const owner1 = claimMemoryJobById(db, { jobId: first.jobId, owner: "one", now })!;
    expect(claimMemoryJobById(db, { jobId: second.jobId, owner: "two", now })).toBeNull();
    expect(completeMemoryJob(db, {
      jobId: first.jobId,
      owner: "one",
      leaseGeneration: owner1.lease_generation,
      now,
    })).toBe(true);
    expect(claimMemoryJobById(db, { jobId: second.jobId, owner: "two", now })).not.toBeNull();
  });

  it("uses checkpoint ordinal, not arrival time, to order a session partition", () => {
    const later = createCheckpointWithJob(db, {
      ...input,
      checkpoint: {
        ...input.checkpoint,
        checkpointId: "cp-later",
        ordinal: 2,
        idempotencyKey: "cp-later",
      },
      job: { ...input.job, idempotencyKey: "job-later" },
      now: "2026-09-03T00:00:00.000Z",
    });
    const earlier = createCheckpointWithJob(db, {
      ...input,
      checkpoint: {
        ...input.checkpoint,
        checkpointId: "cp-earlier",
        ordinal: 1,
        idempotencyKey: "cp-earlier",
      },
      job: { ...input.job, idempotencyKey: "job-earlier" },
      now: "2026-09-03T00:00:01.000Z",
    });
    const now = new Date("2026-09-03T00:00:02.000Z");
    expect(claimMemoryJobById(db, {
      jobId: later.jobId,
      owner: "later",
      now,
    })).toBeNull();
    expect(claimMemoryJobById(db, {
      jobId: earlier.jobId,
      owner: "earlier",
      now,
    })).not.toBeNull();
  });
});

describe("fixed targets, pagination, generation, and closure", () => {
  it("uses the same canonical tool-tail order for insert and metadata refresh", () => {
    put({
      ...exchange("tool-order", 3),
      toolCalls: [
        {
          id: "tool-b",
          exchangeId: "tool-order",
          toolName: "read",
          toolInput: { path: "b" },
          toolResult: "B",
          isError: false,
          timestamp: "2026-09-03T00:00:00Z",
        },
        {
          id: "tool-a",
          exchangeId: "tool-order",
          toolName: "read",
          toolInput: { path: "a" },
          toolResult: "A",
          isError: false,
          timestamp: "2026-09-03T00:00:00Z",
        },
      ],
    });
    const before = db.prepare(
      "SELECT content_hash, content_generation FROM exchanges WHERE id = 'tool-order'",
    ).get();
    ensureExtractionTarget(db, { sessionId: "session-1", project: "/project" });
    expect(db.prepare(
      "SELECT content_hash, content_generation FROM exchanges WHERE id = 'tool-order'",
    ).get()).toEqual(before);
  });

  it("does not overrun a claim-time target when a new exchange arrives", () => {
    put(exchange("e1", 1));
    put(exchange("e2", 2));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "owner")!;
    put(exchange("e3", 3));
    const items = readExtractionTargetItems(db, target.targetId, 0, 10);
    expect(items.map((item) => item.exchange_id)).toEqual(["e1", "e2"]);
    expect(
      commitExtractionPage(db, {
        target: claimed.target,
        items,
        owner: claimed.owner,
        leaseGeneration: claimed.leaseGeneration,
        extracted: 0,
        saved: 0,
      }),
    ).toBe(true);
    expect(
      (db.prepare("SELECT last_exchange_rowid FROM extraction_log WHERE session_id = 'session-1'").get() as {
        last_exchange_rowid: number;
      }).last_exchange_rowid,
    ).toBe(target.throughRowid);
    const next = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    expect(readExtractionTargetItems(db, next.targetId, 0, 10).map((item) => item.exchange_id)).toEqual(["e3"]);
  });

  it("drains deterministic randomized pages contiguously without cursor gaps", () => {
    for (let i = 1; i <= 37; i++) put(exchange(`e${i}`, i));
    let target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const seen: number[] = [];
    let seed = 0x5eed;
    while (target.cursorOrdinal < target.itemCount) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const size = (seed % 7) + 1;
      const claimed = claimExtractionTarget(db, target, `owner-${seen.length}`)!;
      const items = readExtractionTargetItems(db, target.targetId, target.cursorOrdinal, size);
      seen.push(...items.map((item) => item.ordinal));
      expect(commitExtractionPage(db, {
        target: claimed.target,
        items,
        owner: claimed.owner,
        leaseGeneration: claimed.leaseGeneration,
        extracted: 0,
        saved: 0,
      })).toBe(true);
      target = ensureExtractionTarget(db, {
        sessionId: "session-1",
        project: "/project",
      }) ?? { ...target, cursorOrdinal: target.itemCount };
    }
    expect(seen).toEqual(Array.from({ length: 37 }, (_, index) => index + 1));
  });

  it("rejects a page that does not begin at the durable next ordinal", () => {
    for (let i = 1; i <= 3; i++) put(exchange(`gap-e${i}`, i));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "gap-owner")!;
    const skippedPrefix = readExtractionTargetItems(db, target.targetId, 1, 2);
    expect(commitExtractionPage(db, {
      target: claimed.target,
      items: skippedPrefix,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
      extracted: 0,
      saved: 0,
    })).toBe(false);
    expect(db.prepare(
      "SELECT cursor_ordinal, state FROM extraction_targets WHERE target_id = ?",
    ).get(target.targetId)).toEqual({ cursor_ordinal: 0, state: "running" });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM extraction_log WHERE session_id = 'session-1'",
    ).get()).toEqual({ n: 0 });
  });

  it("rolls back every page-commit write boundary before a clean retry", () => {
    put(exchange("crash-e1", 1));
    put(exchange("crash-e2", 2));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "page-owner")!;
    const items = readExtractionTargetItems(db, target.targetId, 0, 10);
    const stages = [
      "target-items",
      "generation-state",
      "target-cursor",
      "compatibility-watermark",
      "checkpoint",
      "job",
    ] as const;
    for (const stage of stages) {
      expect(() => commitExtractionPage(db, {
        target: claimed.target,
        items,
        owner: claimed.owner,
        leaseGeneration: claimed.leaseGeneration,
        extracted: 0,
        saved: 0,
        afterWrite: (observed) => {
          if (observed === stage) throw new Error(`crash-${stage}`);
        },
      })).toThrow(`crash-${stage}`);
      expect(db.prepare(
        "SELECT cursor_ordinal, state FROM extraction_targets WHERE target_id = ?",
      ).get(target.targetId)).toEqual({ cursor_ordinal: 0, state: "running" });
      expect(db.prepare(`
        SELECT state, COUNT(*) AS n FROM extraction_target_items
        WHERE target_id = ? GROUP BY state
      `).get(target.targetId)).toEqual({ state: "pending", n: 2 });
      expect(db.prepare(
        "SELECT COUNT(*) AS n FROM extraction_log WHERE session_id = 'session-1'",
      ).get()).toEqual({ n: 0 });
      expect(db.prepare(
        "SELECT state FROM memory_jobs WHERE job_id = ?",
      ).get(target.jobId)).toEqual({ state: "running" });
    }
    expect(commitExtractionPage(db, {
      target: claimed.target,
      items,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
      extracted: 0,
      saved: 0,
    })).toBe(true);
  });

  it("increments generation on growth and rejects stale generation completion", () => {
    put(exchange("e1", 1, "first"));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "stale-owner")!;
    const staleItems = readExtractionTargetItems(db, target.targetId, 0, 10);
    expect(put(exchange("e1", 2, "grown"))).toBe(true);
    expect(
      (db.prepare("SELECT content_generation FROM exchanges WHERE id = 'e1'").get() as {
        content_generation: number;
      }).content_generation,
    ).toBe(2);
    expect(commitExtractionPage(db, {
      target: claimed.target,
      items: staleItems,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
      extracted: 0,
      saved: 0,
    })).toBe(false);
    expect(supersedeStaleExtractionTarget(db, {
      targetId: target.targetId,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
    })).toBe(true);
    expect(db.prepare(
      "SELECT state FROM extraction_targets WHERE target_id = ?",
    ).get(target.targetId)).toEqual({ state: "superseded" });
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM extraction_failed_ranges",
    ).get()).toEqual({ n: 0 });
    const current = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    expect(readExtractionTargetItems(db, current.targetId, 0, 10)[0].content_generation).toBe(2);
  });

  it("supersedes a fixed target if canonical reconciliation removes its exchange", () => {
    put(exchange("removed-during-model", 1));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "delete-owner")!;
    const items = readExtractionTargetItems(db, target.targetId, 0, 10);
    deleteExchange(db, "removed-during-model");
    expect(commitExtractionPage(db, {
      target: claimed.target,
      items,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
      extracted: 0,
      saved: 0,
    })).toBe(false);
    expect(supersedeStaleExtractionTarget(db, {
      targetId: target.targetId,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
    })).toBe(true);
    expect(db.prepare(
      "SELECT state FROM extraction_targets WHERE target_id = ?",
    ).get(target.targetId)).toEqual({ state: "superseded" });
  });

  it("does not target open/interrupted exchanges or pass their rowids", () => {
    put(exchange("closed", 1));
    put({ ...exchange("open", 2), closureState: "open" });
    put(exchange("after-open", 3));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    expect(readExtractionTargetItems(db, target.targetId, 0, 10).map((item) => item.exchange_id)).toEqual(["closed"]);
    expect(target.throughRowid).toBe(
      (db.prepare("SELECT rowid FROM exchanges WHERE id = 'closed'").get() as { rowid: number }).rowid,
    );
  });

  it("honors an open fence below a legacy live-MAX watermark", () => {
    put(exchange("before-open", 1));
    put({ ...exchange("legacy-open", 2), closureState: "open" });
    put(exchange("after-legacy-open", 3));
    const maxRowid = (db.prepare(
      "SELECT MAX(rowid) AS n FROM exchanges WHERE session_id = 'session-1'",
    ).get() as { n: number }).n;
    db.prepare(`
      INSERT INTO extraction_log
        (session_id, processed_at, extracted, saved, last_exchange_rowid)
      VALUES ('session-1', ?, -1, -1, ?)
    `).run(new Date().toISOString(), maxRowid);

    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    expect(readExtractionTargetItems(db, target.targetId, 0, 10).map(
      (item) => item.exchange_id,
    )).toEqual(["before-open"]);
    expect(target.throughRowid).toBe(
      (db.prepare("SELECT rowid FROM exchanges WHERE id = 'before-open'").get() as { rowid: number }).rowid,
    );
  });

  it("records an exact failed-visible range without advancing completion", () => {
    put(exchange("e1", 1));
    put(exchange("e2", 2));
    const target = ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    })!;
    const claimed = claimExtractionTarget(db, target, "owner")!;
    const second = readExtractionTargetItems(db, target.targetId, 1, 1);
    expect(recordExtractionFailure(db, {
      targetId: target.targetId,
      items: second,
      payloadFingerprint: "fingerprint",
      errorKind: "deterministic",
      errorMessage: "irreducible",
      retry: false,
      owner: claimed.owner,
      leaseGeneration: claimed.leaseGeneration,
    })).toBe(true);
    expect(db.prepare(`
      SELECT from_ordinal, through_ordinal, state FROM extraction_failed_ranges
    `).get()).toEqual({ from_ordinal: 2, through_ordinal: 2, state: "failed-visible" });
    expect(db.prepare("SELECT state, cursor_ordinal FROM extraction_targets").get()).toEqual({
      state: "dead",
      cursor_ordinal: 0,
    });
  });
});

describe("monotonic prefix ingestion", () => {
  it("accepts CP2 then ignores CP1 without deletion or generation/line regression", async () => {
    const cp2 = [
      { ...exchange("e1", 10, "new"), contentGeneration: 2 },
      { ...exchange("e2", 20, "second"), contentGeneration: 1 },
    ];
    expect(await ingestPrefixExchanges(db, cp2)).toEqual({ indexed: 2, ignoredRegressions: 0 });
    const cp1 = [{ ...exchange("e1", 5, "old"), contentGeneration: 1 }];
    expect(await ingestPrefixExchanges(db, cp1)).toEqual({ indexed: 0, ignoredRegressions: 1 });
    expect(db.prepare(`
      SELECT id, line_end, content_generation, user_message FROM exchanges ORDER BY id
    `).all()).toEqual([
      { id: "e1", line_end: 10, content_generation: 2, user_message: "new" },
      { id: "e2", line_end: 20, content_generation: 1, user_message: "second" },
    ]);
  });
});

describe("privacy with queued Continuity work", () => {
  it("purges pending checkpoints, jobs, targets, and generations before source rows", () => {
    put(exchange("private-e", 1));
    ensureExtractionTarget(db, {
      sessionId: "session-1",
      project: "/project",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_jobs").get() as { n: number }).n).toBe(1);

    purgeConversationFromIndex(db, {
      archivePath: "/archive/session.jsonl",
      sessionId: "session-1",
    });

    for (const table of [
      "checkpoints",
      "memory_jobs",
      "extraction_targets",
      "extraction_target_items",
      "exchange_extraction_state",
      "exchanges",
    ]) {
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        table,
      ).toBe(0);
    }
  });
});
