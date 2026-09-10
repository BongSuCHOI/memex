/**
 * G1 — a `never_extract` check that does not finish stores NOTHING (#30 §3.4(6), R5b).
 *
 * This is the correction v4 made to v3, and it is the sharpest edge in the
 * design. v3 had two paths here and both were wrong:
 *
 *   - an execution timeout quarantined the slow pattern and saved what the
 *     SURVIVING patterns allowed, so a forbidden string could be stored for the
 *     sole reason that the rule forbidding it was slow;
 *   - a dead worker blocked everything and committed, and `commitMarker` marks
 *     the page processed — so input nobody managed to inspect was FINALISED, and
 *     the completion path means the next claim never looks at it again.
 *
 * So the contract is: no facts, no watermark, no failed range, no attempt, lease
 * released, the job visibly held, and the SAME input checked again next time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  const { codexMock } = await import("./extraction-rules-fixture.js");
  return { ...actual, ...codexMock(actual) };
});
vi.mock("../src/overlay-matcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/overlay-matcher.js")>();
  const { matcherMock } = await import("./extraction-rules-fixture.js");
  return { ...actual, ...matcherMock(actual) };
});
vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase } from "../src/db.js";
import { runFactExtraction } from "../src/fact-extractor.js";
import { resetExtractionRulesCache } from "../src/extraction-rules.js";
import { releaseHeldJobs } from "../src/model-budget.js";
import { resetQuarantineMemory, replaceQuarantine } from "../src/overlay-matcher.js";
import {
  PROJECT,
  SESSION,
  claimSnapshot,
  factCandidate,
  pinOverlayEnv,
  resetMatcherScript,
  resetScript,
  restoreOverlayEnv,
  rulesDoc,
  scanWholeDatabase,
  seedExchanges,
  writeRules,
  type MatcherMode,
} from "./extraction-rules-fixture.js";

const SECRET = "sk-live-AbCdEf0123456789";
const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";

let root: string;
let db: Database.Database;

/** The three ways the check can fail to finish, and the reason each must record. */
const CASES: Array<{ mode: MatcherMode; reason: string; quarantines: boolean; label: string }> = [
  {
    mode: "execution-timeout",
    reason: "extraction_rules_invalid",
    quarantines: true,
    label: "an execution timeout attributed to one pattern",
  },
  {
    mode: "startup-timeout",
    reason: "extraction_rules_unavailable",
    quarantines: false,
    label: "a queue-wait / startup timeout that names no pattern",
  },
  {
    mode: "worker-dead",
    reason: "extraction_rules_unavailable",
    quarantines: false,
    label: "a dead worker",
  },
];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-unavail-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "test-model";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);
  resetMatcherScript();
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: `The deploy key is ${SECRET} and Riverpod was chosen.` });
  writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
  resetExtractionRulesCache();
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  restoreOverlayEnv();
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_LLM_RETRY_BASE_MS;
  delete process.env.MEMEX_CODEX_MODEL;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(CASES)("$label", ({ mode, reason, quarantines }) => {
  it(`stores nothing, holds with ${reason} and consumes no attempt`, async () => {
    resetMatcherScript(mode);

    const result = await runFactExtraction(db, SESSION, PROJECT);

    expect(result.skipped).toBe(reason);
    expect(result.saved).toBe(0);

    const after = claimSnapshot(db);
    // Nothing stored, and the string is nowhere.
    expect(after.facts).toBe(0);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
    // The watermark did NOT advance: `commitMarker` was never reached, so the
    // same input is still unprocessed and will be claimed again.
    expect(after.processedGenerations).toBe(0);
    expect(after.extractionLog).toBe(0);
    // Not a failure: no failed range, and the claim's attempt is REFUNDED on
    // both tables, so the queue is back exactly where a fresh one starts.
    expect(after.failedRanges).toBe(0);
    expect(after.jobAttempts).toBe(0);
    expect(after.targetAttempts).toBe(0);
    expect(after.jobState).toBe("pending");
    expect(after.targetState).toBe("pending");
    // The claim is fully returned: lease released, checkpoint off `processing`.
    expect(after.jobLeaseOwner).toBeNull();
    expect(after.targetLeaseOwner).toBeNull();
    expect(after.checkpointState).not.toBe("processing");
    // And it is VISIBLE, which is the whole point of a hold over a silent stop.
    expect(after.jobHoldReason).toBe(reason);
  });

  it(quarantines
    ? "quarantines exactly the pattern the worker was running"
    : "quarantines NOTHING — no pattern can be shown to have been running", async () => {
    resetMatcherScript(mode);
    await runFactExtraction(db, SESSION, PROJECT);
    resetExtractionRulesCache();
    const { readQuarantine } = await import("../src/overlay-matcher.js");
    const rows = readQuarantine();
    if (quarantines) {
      expect(rows.map((row) => row.pattern_id)).toEqual(["user.secret"]);
      expect(rows[0].overlay).toBe("extraction-rules");
    } else {
      expect(rows).toEqual([]);
    }
  });

  it("re-checks the same input on the next claim instead of skipping it", async () => {
    resetMatcherScript(mode);
    await runFactExtraction(db, SESSION, PROJECT);

    // Whatever released the hold — a rules edit, `quarantine clear`, the backoff.
    replaceQuarantine([]);
    resetQuarantineMemory();
    resetExtractionRulesCache();
    expect(releaseHeldJobs(db, reason as "extraction_rules_invalid")).toBe(1);
    db.prepare("UPDATE memory_jobs SET available_at = ? WHERE kind = 'fact_extract'").run(
      new Date(Date.now() - 1_000).toISOString(),
    );
    resetMatcherScript("ok");
    resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);

    const second = await runFactExtraction(db, SESSION, PROJECT);

    // The same input was claimed again and CHECKED — the forbidden candidate is
    // dropped this time rather than quietly stored or quietly skipped.
    expect(second.skipped).toBeUndefined();
    expect(second.extracted).toBe(1);
    expect(second.saved).toBe(0);
    const after = claimSnapshot(db);
    expect(after.facts).toBe(0);
    expect(after.jobHoldReason).toBeNull();
    expect(after.processedGenerations).toBeGreaterThan(0);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });
});

describe("a quarantined never_extract pattern holds ALL extraction", () => {
  it("blocks the NEXT claim before it starts, with no attempt", async () => {
    resetMatcherScript("execution-timeout");
    await runFactExtraction(db, SESSION, PROJECT);
    const held = claimSnapshot(db);
    expect(held.jobHoldReason).toBe("extraction_rules_invalid");

    // Clear the hold marker but NOT the quarantine: the rule is still off, so
    // there is no "drop the slow pattern and carry on" path to fall into.
    releaseHeldJobs(db, "extraction_rules_invalid");
    db.prepare("UPDATE memory_jobs SET available_at = ? WHERE kind = 'fact_extract'").run(
      new Date(Date.now() - 1_000).toISOString(),
    );
    resetExtractionRulesCache();
    resetMatcherScript("ok");

    const second = await runFactExtraction(db, SESSION, PROJECT);

    expect(second.skipped).toBe("extraction_rules_invalid");
    const after = claimSnapshot(db);
    expect(after.jobAttempts).toBe(0);
    expect(after.targetAttempts).toBe(0);
    expect(after.jobState).toBe("pending");
    expect(after.jobHoldReason).toBe("extraction_rules_invalid");
    expect(after.facts).toBe(0);
    expect(after.failedRanges).toBe(0);
  });

  it("resumes once the quarantine is cleared", async () => {
    resetMatcherScript("execution-timeout");
    await runFactExtraction(db, SESSION, PROJECT);

    replaceQuarantine([]);
    resetQuarantineMemory();
    resetExtractionRulesCache();
    releaseHeldJobs(db, "extraction_rules_invalid");
    db.prepare("UPDATE memory_jobs SET available_at = ? WHERE kind = 'fact_extract'").run(
      new Date(Date.now() - 1_000).toISOString(),
    );
    resetMatcherScript("ok");
    resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);

    const second = await runFactExtraction(db, SESSION, PROJECT);
    expect(second.skipped).toBeUndefined();
    expect(second.saved).toBe(1);
    expect(claimSnapshot(db).jobHoldReason).toBeNull();
  });
});
