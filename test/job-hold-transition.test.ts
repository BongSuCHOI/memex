import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  HOLD_REASONS,
  clearJobHold,
  ensureModelBudgetSchema,
  heldJobSummary,
  holdMemoryJob,
  releaseExtractionClaimOnHold,
  releaseHeldJobs,
  type HoldReason,
} from "../src/model-budget.js";
import { claimMemoryJobById } from "../src/continuity-store.js";
import { initDatabase } from "../src/db.js";

/**
 * THE PUBLIC CONTRACT for HOLD (decision H2/G1).
 *
 * Two features hold work for unrelated reasons — a rejected model selection
 * (#31) and extraction rules that are invalid or could not be checked (#30 G1,
 * fail-closed). They must reach the IDENTICAL state transition, because the
 * thing that must be true is the same in both cases: a held job is not a
 * failure. It stays `pending`, its attempts are refunded, no failure row is
 * written, and `max_attempts` can never turn it into a dead letter.
 *
 * So the helpers are reason-agnostic and this file is the contract the other
 * lane imports against. If these assertions hold, a second near-copy of the
 * transition is never needed — and that is the real protection, because a copy
 * is what would silently stop refunding attempts.
 */

let root: string;
let db: Database.Database;

/** Queue rows are written directly: this contract is about the TRANSITION, and
 *  driving a real extraction here would test the extractor instead. */
function seedJob(
  jobId: string,
  options: {
    targetId?: string | null;
    checkpointId?: string | null;
    attempts?: number;
  } = {},
): void {
  const now = new Date().toISOString();
  if (options.checkpointId) {
    db.prepare(`
      INSERT INTO checkpoints
        (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at)
      VALUES (?, 'S1', 1, 'extraction', 'pending', ?, ?)
    `).run(options.checkpointId, `cp-${options.checkpointId}`, now);
  }
  if (options.targetId) {
    db.prepare(`
      INSERT INTO extraction_targets
        (target_id, session_id, project, from_rowid, through_rowid, item_count,
         policy_version, state, attempts, idempotency_key, created_at, updated_at)
      VALUES (?, 'S1', '/tmp/p', 1, 9, 9, 'v1', 'pending', 0, ?, ?, ?)
    `).run(options.targetId, `target-${options.targetId}`, now, now);
  }
  db.prepare(`
    INSERT INTO memory_jobs
      (job_id, kind, partition_key, checkpoint_id, target_id, policy_version,
       state, available_at, attempts, max_attempts, idempotency_key,
       created_at, updated_at)
    VALUES (?, 'fact_extract', ?, ?, ?, 'v1', 'pending', ?, ?, 5, ?, ?, ?)
  `).run(
    jobId,
    // One partition per job: the claim gate drains a partition strictly in
    // order, so sharing one would make the second seed unclaimable for reasons
    // that have nothing to do with holds.
    `part-${jobId}`,
    options.checkpointId ?? null,
    options.targetId ?? null,
    now,
    options.attempts ?? 0,
    `idem-${jobId}`,
    now,
    now,
  );
}

function job(jobId: string): Record<string, unknown> {
  return db.prepare("SELECT * FROM memory_jobs WHERE job_id = ?").get(jobId) as Record<string, unknown>;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-job-hold-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  db = initDatabase();
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  if (db.open) db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("holdMemoryJob is reason-agnostic", () => {
  for (const reason of HOLD_REASONS) {
    it(`performs the identical transition for ${reason}`, () => {
      seedJob("j1");
      const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
      expect(claim.state).toBe("running");
      expect(claim.attempts).toBe(1);

      const before = new Date();
      expect(
        holdMemoryJob(db, {
          jobId: "j1",
          owner: "o1",
          leaseGeneration: claim.lease_generation,
          reason,
          detail: "provider refused the envelope",
        }),
      ).toBe(true);

      const row = job("j1");
      // `pending`, never `retry`: a hold does not belong on the backoff ladder.
      expect(row.state).toBe("pending");
      expect(row.hold_reason).toBe(reason);
      // The claim's attempt is refunded — it bought nothing.
      expect(row.attempts).toBe(0);
      expect(row.lease_owner).toBeNull();
      expect(row.lease_until).toBeNull();
      // Immediately claimable: the session after the fix picks it up at once.
      expect(Date.parse(String(row.available_at))).toBeLessThanOrEqual(Date.now() + 1_000);
      expect(Date.parse(String(row.available_at))).toBeGreaterThanOrEqual(before.getTime() - 1_000);
      expect(String(row.last_error)).toContain(reason);
    });
  }

  it("refuses a reason outside the value set, with no write", () => {
    seedJob("j1");
    const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
    expect(() =>
      holdMemoryJob(db, {
        jobId: "j1",
        owner: "o1",
        leaseGeneration: claim.lease_generation,
        reason: "whatever_i_felt_like" as HoldReason,
        detail: "x",
      }),
    ).toThrow(/unknown hold reason/);
    expect(job("j1").state).toBe("running");
    expect(job("j1").hold_reason).toBeNull();
  });

  it("never overwrites another owner's claim (lease CAS)", () => {
    seedJob("j1");
    const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
    // Wrong generation, and wrong owner.
    expect(
      holdMemoryJob(db, {
        jobId: "j1", owner: "o1", leaseGeneration: claim.lease_generation + 1,
        reason: "model_config_rejected", detail: "stale",
      }),
    ).toBe(false);
    expect(
      holdMemoryJob(db, {
        jobId: "j1", owner: "someone-else", leaseGeneration: claim.lease_generation,
        reason: "model_config_rejected", detail: "stale",
      }),
    ).toBe(false);
    expect(job("j1").state).toBe("running");
  });

  it("leaves a checkpoint untouched — a hold is not a failure", () => {
    seedJob("j1", { checkpointId: "cp1" });
    db.prepare("UPDATE checkpoints SET state = 'captured' WHERE checkpoint_id = 'cp1'").run();
    const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
    holdMemoryJob(db, {
      jobId: "j1", owner: "o1", leaseGeneration: claim.lease_generation,
      reason: "extraction_rules_unavailable", detail: "worker died",
    });
    expect(
      (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = 'cp1'").get() as { state: string }).state,
    ).toBe("captured");
  });

  it("cannot reach `dead`, however many times it is held", () => {
    seedJob("j1");
    for (let round = 0; round < 8; round++) {
      const claim = claimMemoryJobById(db, { jobId: "j1", owner: `o${round}` })!;
      expect(claim, `round ${round} must still be claimable`).toBeTruthy();
      holdMemoryJob(db, {
        jobId: "j1", owner: `o${round}`, leaseGeneration: claim.lease_generation,
        reason: "model_config_rejected", detail: "same bad selection",
      });
      // max_attempts is 5; without the refund round 5 would refuse the claim
      // and the job would be dead-lettered for something that is not its fault.
      expect(job("j1").attempts).toBe(0);
      expect(job("j1").state).toBe("pending");
    }
  });
});

describe("releaseExtractionClaimOnHold", () => {
  for (const reason of HOLD_REASONS) {
    it(`returns job + target + checkpoint for ${reason}`, () => {
      seedJob("j1", { targetId: "t1", checkpointId: "cp1" });
      const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
      // Reproduce what claimExtractionTargetWithReason writes alongside the job.
      db.prepare(`
        UPDATE extraction_targets
        SET state = 'running', lease_owner = 'o1', lease_until = ?,
            lease_generation = ?, attempts = attempts + 1
        WHERE target_id = 't1'
      `).run(claim.lease_until, claim.lease_generation);
      db.prepare("UPDATE checkpoints SET state = 'processing' WHERE checkpoint_id = 'cp1'").run();

      expect(
        releaseExtractionClaimOnHold(db, {
          targetId: "t1",
          jobId: "j1",
          owner: "o1",
          leaseGeneration: claim.lease_generation,
          reason,
          detail: "model config rejected",
        }),
      ).toBe(true);

      expect(job("j1").state).toBe("pending");
      expect(job("j1").attempts).toBe(0);
      expect(job("j1").hold_reason).toBe(reason);

      const target = db.prepare("SELECT * FROM extraction_targets WHERE target_id = 't1'")
        .get() as Record<string, unknown>;
      expect(target.state).toBe("pending");
      expect(target.attempts).toBe(0);
      expect(target.lease_owner).toBeNull();
      expect(target.lease_until).toBeNull();

      // The claim's own `processing` marker is rolled back, nothing else.
      expect(
        (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = 'cp1'").get() as { state: string }).state,
      ).toBe("pending");

      // No failure row, no completion log: the session stays unfinished so the
      // next run retries it.
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM extraction_failed_ranges").get() as { n: number }).n,
      ).toBe(0);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM extraction_log").get() as { n: number }).n,
      ).toBe(0);
    });
  }

  it("leaves a checkpoint that is not `processing` exactly as found", () => {
    seedJob("j1", { targetId: "t1", checkpointId: "cp1" });
    const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
    db.prepare("UPDATE checkpoints SET state = 'processed' WHERE checkpoint_id = 'cp1'").run();
    releaseExtractionClaimOnHold(db, {
      targetId: "t1", jobId: "j1", owner: "o1", leaseGeneration: claim.lease_generation,
      reason: "model_config_rejected", detail: "x",
    });
    expect(
      (db.prepare("SELECT state FROM checkpoints WHERE checkpoint_id = 'cp1'").get() as { state: string }).state,
    ).toBe("processed");
  });

  it("refuses an unknown reason and a lost lease", () => {
    seedJob("j1", { targetId: "t1" });
    const claim = claimMemoryJobById(db, { jobId: "j1", owner: "o1" })!;
    expect(() =>
      releaseExtractionClaimOnHold(db, {
        targetId: "t1", jobId: "j1", owner: "o1", leaseGeneration: claim.lease_generation,
        reason: "nope" as HoldReason, detail: "x",
      }),
    ).toThrow(/unknown hold reason/);
    expect(
      releaseExtractionClaimOnHold(db, {
        targetId: "t1", jobId: "j1", owner: "thief", leaseGeneration: claim.lease_generation,
        reason: "model_config_rejected", detail: "x",
      }),
    ).toBe(false);
    expect(job("j1").state).toBe("running");
  });
});

describe("release and reporting", () => {
  function hold(jobId: string, reason: HoldReason): void {
    seedJob(jobId);
    const claim = claimMemoryJobById(db, { jobId, owner: `owner-${jobId}` })!;
    holdMemoryJob(db, {
      jobId, owner: `owner-${jobId}`, leaseGeneration: claim.lease_generation,
      reason, detail: reason,
    });
  }

  it("releaseHeldJobs lifts ONLY its own reason", () => {
    hold("jA", "model_config_rejected");
    hold("jB", "extraction_rules_invalid");
    hold("jC", "model_config_rejected");

    expect(releaseHeldJobs(db, "model_config_rejected")).toBe(2);
    expect(job("jA").hold_reason).toBeNull();
    expect(job("jC").hold_reason).toBeNull();
    // A fixed model selection must not release work waiting on a broken rule.
    expect(job("jB").hold_reason).toBe("extraction_rules_invalid");

    expect(releaseHeldJobs(db, "extraction_rules_invalid")).toBe(1);
    expect(job("jB").hold_reason).toBeNull();
    expect(releaseHeldJobs(db, "extraction_rules_invalid")).toBe(0);
  });

  it("clearJobHold touches hold_reason and nothing else", () => {
    hold("jA", "model_config_rejected");
    const before = job("jA");
    expect(clearJobHold(db, "jA")).toBe(true);
    const after = job("jA");
    expect(after.hold_reason).toBeNull();
    expect(after.state).toBe(before.state);
    expect(after.attempts).toBe(before.attempts);
    expect(after.available_at).toBe(before.available_at);
    // Idempotent: nothing left to clear.
    expect(clearJobHold(db, "jA")).toBe(false);
  });

  it("heldJobSummary reports per-reason counts and the oldest hold", () => {
    expect(heldJobSummary(db)).toEqual([]);
    hold("jA", "model_config_rejected");
    hold("jB", "model_config_rejected");
    hold("jC", "extraction_rules_unavailable");

    const summary = heldJobSummary(db);
    expect(summary.map((row) => [row.reason, row.jobs])).toEqual([
      ["extraction_rules_unavailable", 1],
      ["model_config_rejected", 2],
    ]);
    for (const row of summary) expect(row.oldestHeldAt).toBeTruthy();
  });

  it("does not count a held job that later completed or died", () => {
    hold("jA", "model_config_rejected");
    db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE job_id = 'jA'").run();
    expect(heldJobSummary(db)).toEqual([]);
  });
});

describe("schema migration", () => {
  it("adds hold_reason to a database that predates it, exactly once", () => {
    const legacy = path.join(root, "legacy.sqlite");
    const old = new Database(legacy);
    try {
      // A 0.6.x-shaped memory_jobs: no hold_reason column.
      old.exec(`
        CREATE TABLE memory_jobs (
          job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, partition_key TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL,
          lease_owner TEXT, lease_until TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
          last_error TEXT, idempotency_key TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
      `);
      const columns = () =>
        (old.prepare("PRAGMA table_info(memory_jobs)").all() as Array<{ name: string }>)
          .filter((row) => row.name === "hold_reason").length;
      expect(columns()).toBe(0);
      ensureModelBudgetSchema(old);
      expect(columns()).toBe(1);
      // Idempotent: a second migration must not attempt the ALTER again.
      ensureModelBudgetSchema(old);
      expect(columns()).toBe(1);
    } finally {
      old.close();
    }
  });
});
