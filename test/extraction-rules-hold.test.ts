/**
 * The pre-claim HOLD, and why it can never become a dead letter (#30 §3.5.2, D4/R8).
 *
 * `failMemoryJob` turns the last attempt into `dead` and the range into
 * `failed-visible`. A rule file with a typo is not the conversation's fault, and
 * a design where a config error walks the queue to `dead` loses that
 * conversation's memory permanently. The structural answer is not "retry more"
 * but "never spend an attempt": the gate sits BEFORE
 * `claimExtractionTargetWithReason`, so `max_attempts` is unreachable no matter
 * how many times the pass runs.
 *
 * The second half is that a hold must be VISIBLE. A held job is neither `retry`
 * nor `dead`, so every existing status surface reports it as ordinary pending
 * work — `hold_reason` is what stops that being a silent stop.
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
import {
  extractionRulesChecks,
  loadExtractionRules,
  releaseExtractionRulesHold,
  resetExtractionRules,
  resetExtractionRulesCache,
  rollbackExtractionRules,
  setExtractionRules,
} from "../src/extraction-rules.js";
import { heldJobSummary } from "../src/model-budget.js";
import { resetQuarantineMemory } from "../src/overlay-matcher.js";
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
  script,
  seedExchanges,
  writeRules,
} from "./extraction-rules-fixture.js";

const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";

let root: string;
let db: Database.Database;

function breakOverlay(): void {
  fs.mkdirSync(path.join(root, "overlays"), { recursive: true });
  fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ this is not json");
  resetExtractionRulesCache();
}

function makeClaimable(): void {
  // The hold sets a one-hour safety-net backoff; a release moves it forward, and
  // these tests exercise the release explicitly.
  db.prepare("UPDATE memory_jobs SET available_at = ? WHERE kind = 'fact_extract'").run(
    new Date(Date.now() - 1_000).toISOString(),
  );
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-hold-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "test-model";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);
  resetMatcherScript();
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: "Riverpod was chosen for state management." });
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

describe("an unreadable overlay holds BEFORE the claim", () => {
  it("spends no provider call, no attempt and no lease", async () => {
    breakOverlay();
    const result = await runFactExtraction(db, SESSION, PROJECT);

    expect(result.skipped).toBe("extraction_rules_invalid");
    expect(result.rulesIssue).toBe("OVERLAY_UNREADABLE");
    // The gate is before the claim, so the model is never reached.
    expect(script.calls).toBe(0);

    const after = claimSnapshot(db);
    expect(after.jobState).toBe("pending");
    expect(after.jobAttempts).toBe(0);
    expect(after.jobLeaseOwner).toBeNull();
    expect(after.targetState).toBe("pending");
    expect(after.targetAttempts).toBe(0);
    expect(after.checkpointState).not.toBe("processing");
    expect(after.failedRanges).toBe(0);
    expect(after.extractionLog).toBe(0);
    expect(after.jobHoldReason).toBe("extraction_rules_invalid");
  });

  it("can NEVER reach dead, however many passes run past max_attempts", async () => {
    breakOverlay();
    db.prepare("UPDATE memory_jobs SET max_attempts = 2 WHERE kind = 'fact_extract'").run();

    for (let round = 0; round < 6; round++) {
      makeClaimable();
      const result = await runFactExtraction(db, SESSION, PROJECT);
      expect(result.skipped, `round ${round}`).toBe("extraction_rules_invalid");
      const after = claimSnapshot(db);
      expect(after.jobState, `round ${round}`).toBe("pending");
      expect(after.jobAttempts, `round ${round}`).toBe(0);
      expect(after.targetState, `round ${round}`).not.toBe("dead");
    }
    expect(script.calls).toBe(0);
  });

  it("sets a safety-net backoff so an unattended machine still recovers", async () => {
    breakOverlay();
    await runFactExtraction(db, SESSION, PROJECT);
    const availableAt = Date.parse(
      (db.prepare("SELECT available_at FROM memory_jobs WHERE kind = 'fact_extract'").get() as {
        available_at: string;
      }).available_at,
    );
    // An hour out: the fix normally arrives through a rules write that releases
    // the hold at once, and this only matters when it does not.
    expect(availableAt).toBeGreaterThan(Date.now() + 50 * 60_000);
  });

  it("is reported by doctor as a FAIL on both checks", async () => {
    breakOverlay();
    await runFactExtraction(db, SESSION, PROJECT);
    const checks = extractionRulesChecks(heldJobSummary(db));
    expect(checks[0]).toMatchObject({ name: "extraction-rules-overlay", status: "fail" });
    expect(checks[0].detail).toContain("EXTRACTION IS HELD");
    expect(checks[1]).toMatchObject({ name: "extraction-rules-hold", status: "fail" });
    expect(checks[1].detail).toContain("1 job(s) held");
  });
});

describe("no matcher plus a never_extract pattern holds before the claim", () => {
  it("refuses to claim work it could not possibly check", async () => {
    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetExtractionRulesCache();
    // `worker_threads` cannot give us a worker at all, so the probe fails as well
    // — which is exactly the case this gate exists for: the check could not
    // complete later either, so claiming the work would only burn a model call.
    resetMatcherScript("worker-dead", true);

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.skipped).toBe("extraction_rules_unavailable");
    expect(script.calls).toBe(0);
    const after = claimSnapshot(db);
    expect(after.jobAttempts).toBe(0);
    expect(after.jobHoldReason).toBe("extraction_rules_unavailable");
  });

  it("does NOT hold when there is no never_extract pattern to run", async () => {
    writeRules(root, rulesDoc([], { exclude_topics: ["급여"] }));
    resetExtractionRulesCache();
    resetMatcherScript("worker-dead");
    // `exclude_topics` is advisory — it goes in the prompt and enforces nothing —
    // so a missing matcher is irrelevant and holding would be pure obstruction.
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBe(1);
  });
});

describe("resume", () => {
  it("releases every extraction hold and only ours", async () => {
    breakOverlay();
    await runFactExtraction(db, SESSION, PROJECT);
    // Someone else's hold, which must survive: a fixed rule set says nothing
    // about a rejected model selection.
    db.prepare(
      "UPDATE memory_jobs SET hold_reason = 'model_config_rejected' WHERE kind = 'capsule_update'",
    ).run();

    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetExtractionRulesCache();
    expect(await releaseExtractionRulesHold(db)).toBe(1);

    expect(claimSnapshot(db).jobHoldReason).toBeNull();
    expect(
      heldJobSummary(db).filter((row) => row.reason.startsWith("extraction_rules_")),
    ).toEqual([]);
  });

  it("runs to completion after the file is fixed", async () => {
    breakOverlay();
    expect((await runFactExtraction(db, SESSION, PROJECT)).skipped).toBe("extraction_rules_invalid");

    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetExtractionRulesCache();
    await releaseExtractionRulesHold(db);
    makeClaimable();

    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBe(1);
    const after = claimSnapshot(db);
    expect(after.jobHoldReason).toBeNull();
    expect(after.jobState).toBe("completed");
    expect(after.targetRulesHash).toMatch(/^rules:[0-9a-f]{8}$/);
  });

  it("holds again — still at attempt 0 — when the fix is not a fix", async () => {
    breakOverlay();
    await runFactExtraction(db, SESSION, PROJECT);
    await releaseExtractionRulesHold(db);
    makeClaimable();
    // Still broken.
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.skipped).toBe("extraction_rules_invalid");
    expect(claimSnapshot(db).jobAttempts).toBe(0);
  });
});

describe("the write path releases the hold it can fix", () => {
  it("validates, writes a revision, invalidates the cache and resumes the queue", async () => {
    breakOverlay();
    await runFactExtraction(db, SESSION, PROJECT);
    expect(claimSnapshot(db).jobHoldReason).toBe("extraction_rules_invalid");

    const result = await setExtractionRules(
      {
        schema: "memex.extraction-rules-overlay",
        version: 1,
        never_extract_patterns: [{ id: "user.secret", source: PATTERN, flags: "", scope: "both" }],
      },
      { surface: "cli", probe: false, db },
    );

    expect(result.revision).toBe(1);
    expect(result.hash).toMatch(/^rules:[0-9a-f]{8}$/);
    // The release is part of the write, not a thing an operator has to remember.
    expect(result.released).toBe(1);
    expect(claimSnapshot(db).jobHoldReason).toBeNull();
    // The loader sees it immediately: the write is tmp+rename, so the
    // mtime/size/ino cache key moved.
    expect(loadExtractionRules().global.neverExtract.map((p) => p.id)).toEqual(["user.secret"]);

    makeClaimable();
    const run = await runFactExtraction(db, SESSION, PROJECT);
    expect(run.skipped).toBeUndefined();
    expect(run.saved).toBe(1);
  });

  it("refuses an invalid document and changes nothing", async () => {
    const { OverlayInvalidError } = await import("../src/overlay-admin.js");
    await expect(
      setExtractionRules(
        {
          schema: "memex.extraction-rules-overlay",
          version: 1,
          // A quantified group: rejected by the shared grammar.
          never_extract_patterns: [{ id: "bad", source: "(a+)+$", flags: "" }],
        },
        { surface: "cli", probe: false, db },
      ),
    ).rejects.toThrow(OverlayInvalidError);
    expect(fs.existsSync(path.join(root, "overlays", "extraction-rules.json"))).toBe(false);
  });

  it("resets to the empty document and rolls back to a previous revision", async () => {
    await setExtractionRules(
      {
        schema: "memex.extraction-rules-overlay",
        version: 1,
        never_extract_patterns: [{ id: "user.secret", source: PATTERN, flags: "", scope: "both" }],
      },
      { surface: "cli", probe: false, db },
    );
    const applied = loadExtractionRules().hash;

    const reset = await resetExtractionRules({ surface: "cli", expectedRevision: 1, db });
    expect(reset.revision).toBe(2);
    expect(loadExtractionRules().global.neverExtract).toEqual([]);
    // The file is still there with a revision and a snapshot, so the reset is a
    // change that can be undone rather than a disappearance.
    expect(fs.existsSync(path.join(root, "overlays", "extraction-rules.json"))).toBe(true);

    const back = await rollbackExtractionRules(1, { surface: "cli", expectedRevision: 2, db });
    expect(back.revision).toBe(3);
    expect(back.hash).toBe(applied);
    expect(loadExtractionRules().global.neverExtract.map((p) => p.id)).toEqual(["user.secret"]);
  });

  it("still writes when there is no database, and the backoff covers the rest", async () => {
    const result = await setExtractionRules(
      { schema: "memex.extraction-rules-overlay", version: 1, exclude_topics: ["급여"] },
      { surface: "cli", probe: false },
    );
    expect(result.revision).toBe(1);
    expect(result.released).toBe(0);
  });
});
