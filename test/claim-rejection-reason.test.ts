import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
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

import { initDatabase, insertExchange } from "../src/db.js";
import {
  claimExtractionTargetWithReason,
  claimMemoryJobByIdWithReason,
  ensureExtractionTarget,
  type ExtractionTarget,
} from "../src/continuity-store.js";
import {
  CLAIM_REJECTION_REPORT,
  runFactExtraction,
} from "../src/fact-extractor.js";
import { ensureModelBudgetSchema } from "../src/model-budget.js";
import { formatPipelineStatus, getPipelineStatus } from "../src/pipeline-status.js";
import type { ConversationExchange } from "../src/types.js";

/**
 * Issue #11 — a refused claim must say why it was refused.
 *
 * Observed 2026-09-09 14:23Z: both pending targets had `lease_owner = NULL`,
 * no worker process, `attempts = 1` and `available_at = 15:03:52Z`, and the
 * foreground backfill reported both as "다른 러너가 처리 중". Three structurally
 * different refusals were collapsed into one label, so the operator waited an
 * hour for a runner that did not exist.
 */

let root: string;
let db: Database.Database;

const T0 = new Date("2026-09-09T14:03:52.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const HOUR = 60 * 60_000;

function exchange(id: string, lineEnd: number): ConversationExchange {
  return {
    id,
    project: "/project",
    timestamp: `2026-09-09T13:00:${lineEnd.toString().padStart(2, "0")}Z`,
    userMessage: `we decided to use postgres for ${id}`,
    assistantMessage: `ack ${id}`,
    archivePath: "/archive/session.jsonl",
    lineStart: lineEnd,
    lineEnd,
    sessionId: "session-1",
    cwd: "/project",
    closureState: "closed",
  };
}

function seedSession(): ExtractionTarget {
  insertExchange(db, exchange("e1", 1), new Array(384).fill(0.01));
  insertExchange(db, exchange("e2", 2), new Array(384).fill(0.01));
  return ensureExtractionTarget(db, {
    sessionId: "session-1",
    project: "/project",
    now: T0.toISOString(),
  })!;
}

function jobRow(jobId: string): {
  state: string;
  attempts: number;
  available_at: string;
  lease_owner: string | null;
  budget_id: string | null;
} {
  return db.prepare(`
    SELECT state, attempts, available_at, lease_owner, budget_id
    FROM memory_jobs WHERE job_id = ?
  `).get(jobId) as never;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-claim-reason-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "memex.sqlite");
  delete process.env.MEMEX_MODEL_BUDGET_ID;
  delete process.env.MEMEX_MAINTENANCE_WAVE_ID;
  db = initDatabase();
  ensureModelBudgetSchema(db);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  fs.rmSync(root, { recursive: true, force: true });
});
describe("issue #11 — a refused claim reports why", () => {
  it("reports retry backoff with its due time instead of a phantom runner", () => {
    const { jobId } = seedSession();
    // Exactly the observed row: no owner, no live lease, one hour of backoff.
    db.prepare(`
      UPDATE memory_jobs
      SET state = 'retry', attempts = 1, lease_owner = NULL, lease_until = NULL,
          available_at = ?
      WHERE job_id = ?
    `).run(at(HOUR).toISOString(), jobId);

    const outcome = claimMemoryJobByIdWithReason(db, {
      jobId,
      owner: "foreground",
      now: T0,
    });
    expect(outcome.job, "backoff must not hand out a claim").toBeNull();
    expect(outcome.rejection).toEqual({
      reason: "backoff",
      availableAt: at(HOUR).toISOString(),
    });
    // The label the CLI prints must follow the reason, not the other way round.
    expect(CLAIM_REJECTION_REPORT.backoff.label).toBe("DEFERRED");
    expect(CLAIM_REJECTION_REPORT.lease_held.label).toBe("HANDOFF");
    expect(CLAIM_REJECTION_REPORT.attempts_exhausted.label).toBe("SKIPPED");
  });

  it("still reports a live lease as a handoff", () => {
    const target = seedSession();
    // A real runner owns the lane: this is the one case the old label was
    // right about, and it must keep saying so.
    expect(claimExtractionTargetWithReason(db, target, "runner-a", T0).claim)
      .not.toBeNull();
    const blocked = claimMemoryJobByIdWithReason(db, {
      jobId: target.jobId,
      owner: "runner-b",
      now: at(1_000),
    });
    expect(blocked.job).toBeNull();
    expect(blocked.rejection).toEqual({ reason: "lease_held" });
    expect(
      (db.prepare("SELECT lease_owner FROM memory_jobs WHERE job_id = ?")
        .get(target.jobId) as { lease_owner: string }).lease_owner,
      "the handoff label is only honest when someone really holds the lease",
    ).toBe("runner-a");
  });

  it("reports an exhausted attempt cap as its own reason, not as a handoff", () => {
    const target = seedSession();
    const jobId = target.jobId;
    db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE job_id = ?").run(jobId);
    expect(
      claimExtractionTargetWithReason(db, target, "crashed-owner", T0).claim,
    ).not.toBeNull();

    // The crashed owner's lease expires; the final attempt is already spent.
    const expired = claimMemoryJobByIdWithReason(db, {
      jobId,
      owner: "recovery",
      now: at(30 * 60_000 + 1),
    });
    expect(expired.job).toBeNull();
    expect(expired.rejection).toEqual({ reason: "attempts_exhausted" });
    expect(CLAIM_REJECTION_REPORT.attempts_exhausted.escalate).toBe(true);
  });

  it("surfaces the reason through runFactExtraction for the backfill worker", async () => {
    const { jobId } = seedSession();
    db.prepare(`
      UPDATE memory_jobs SET state = 'retry', attempts = 1, available_at = ?
      WHERE job_id = ?
    `).run(at(HOUR).toISOString(), jobId);

    const result = await runFactExtraction(db, "session-1", "/project", {
      claimVariant: "worker",
    });
    expect(result.skipped).toBe("claim_not_acquired");
    expect(result.claimReason).toBe("backoff");
    expect(result.availableAt).toBe(at(HOUR).toISOString());
  });

  it("counts backoff sessions in status and names the earliest retry", () => {
    const { jobId } = seedSession();
    const due = at(HOUR).toISOString();
    db.prepare(`
      UPDATE memory_jobs SET state = 'retry', attempts = 1, available_at = ?
      WHERE job_id = ?
    `).run(due, jobId);

    const status = getPipelineStatus({ db, dbPath: process.env.MEMEX_DB_PATH });
    expect(status.extraction.backoff).toBe(1);
    expect(status.extraction.backoffEarliestAt).toBe(due);
    // Backoff is a breakdown of pending, never of the terminal `deferred`
    // bucket — mixing them would make "deferred work" mean two things.
    expect(status.extraction.deferred).toBe(0);
    expect(status.extraction.pending).toBeGreaterThan(0);
    const text = formatPipelineStatus(status);
    expect(text).toContain("1 backoff");
    expect(text).toContain(`earliest retry ${due}`);
  });
});
