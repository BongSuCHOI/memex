/**
 * A blocked candidate is a DROP, not a failure (#30 §3.4(4), D2, R10).
 *
 * v2 made the rule change abort the claim. That looks conservative and is the
 * opposite: `saveExtractedFactsDetailed`'s catch rethrows, the caller reaches
 * `recordExtractionFailure(errorKind:'internal', retry:true)`, and on the last
 * attempt `continuity-store` turns the range into `failed-visible`. A user
 * tightening their own rules would have permanently marked their conversation as
 * failed to extract.
 *
 * So the assertions here are mostly about what must NOT exist: no exception, no
 * `extraction_failed_ranges` row, no attempt consumed, nothing `dead` — while the
 * forbidden candidate is still not stored. These run through the real
 * `runFactExtraction`, because every one of those is written by the claim path.
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
import {
  PROJECT,
  SESSION,
  claimSnapshot,
  factCandidate,
  resetScript,
  rulesDoc,
  scanWholeDatabase,
  script,
  seedExchanges,
  writeRules,
} from "./extraction-rules-fixture.js";

const SECRET = "sk-live-AbCdEf0123456789";
const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";

let root: string;
let db: Database.Database;

function auditLines(): Array<Record<string, unknown>> {
  const file = path.join(root, "logs", "ui-audit.jsonl");
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}


beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-boundary-"));
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "test-model";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetExtractionRulesCache();
  resetScript();
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: `The deploy key is ${SECRET} and Riverpod was chosen.` });
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_LLM_RETRY_BASE_MS;
  delete process.env.MEMEX_CODEX_MODEL;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("tightening a rule during the model call blocks at the commit", () => {
  it("drops the candidate with no failure, no attempt and no exception", async () => {
    resetScript([
      factCandidate(`The deploy key is ${SECRET}`, SECRET),
      factCandidate("Riverpod was chosen for state management", "Riverpod"),
    ]);
    // The overlay did not exist at claim time; it appears while the model runs.
    script.onCall = (stage) => {
      if (stage !== "extract") return;
      writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    };

    const result = await runFactExtraction(db, SESSION, PROJECT);

    // No exception reached the caller at all.
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBe(1);

    const after = claimSnapshot(db);
    // The forbidden sentence is not stored; the innocent one is.
    expect(after.facts).toBe(1);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
    expect(
      (db.prepare("SELECT fact FROM facts").get() as { fact: string }).fact,
    ).toBe("Riverpod was chosen for state management");

    // And the page is COMPLETE: the input was fully inspected, so refusing to
    // store part of it is success, not something to retry forever.
    expect(after.failedRanges).toBe(0);
    expect(after.jobState).toBe("completed");
    expect(after.jobHoldReason).toBeNull();
    expect(after.processedGenerations).toBeGreaterThan(0);
  });

  it("leaves ONE audit line with ids and counts only — never the text", async () => {
    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);

    await runFactExtraction(db, SESSION, PROJECT);

    const blocked = auditLines().filter((line) => line.action === "rules.blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0].blocked).toBe(1);
    expect(blocked[0].patterns).toBe("user.secret");
    expect(String(blocked[0].to_hash)).toMatch(/^rules:[0-9a-f]{8}$/);
    // The audit writer must not leak what the rule refused to store.
    expect(JSON.stringify(blocked[0])).not.toContain(SECRET);
  });

  it("records the claim-time rules_hash on the target", async () => {
    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);
    await runFactExtraction(db, SESSION, PROJECT);
    expect(claimSnapshot(db).targetRulesHash).toMatch(/^rules:[0-9a-f]{8}$/);
  });

  it("leaves rules_hash NULL when no overlay applies", async () => {
    resetScript([factCandidate("Riverpod was chosen for state management", "Riverpod")]);
    await runFactExtraction(db, SESSION, PROJECT);
    expect(claimSnapshot(db).targetRulesHash).toBeNull();
  });
});

describe("the last attempt is not special", () => {
  it("does not become failed-visible when the rules change on it", async () => {
    // One attempt left: under the v2 design this is where a rule edit turned the
    // conversation's range terminal.
    db.prepare("UPDATE memory_jobs SET max_attempts = 1 WHERE kind = 'fact_extract'").run();
    resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);
    script.onCall = (stage) => {
      if (stage !== "extract") return;
      writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    };

    const result = await runFactExtraction(db, SESSION, PROJECT);

    expect(result.skipped).toBeUndefined();
    const after = claimSnapshot(db);
    expect(after.jobState).not.toBe("dead");
    expect(after.targetState).not.toBe("dead");
    expect(after.failedRanges).toBe(0);
    expect(after.facts).toBe(0);
  });
});

describe("a broken overlay file at the storage boundary", () => {
  it("commits with the claim-time snapshot and leaves a rules.stale-read line", async () => {
    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    resetScript([
      factCandidate(`The deploy key is ${SECRET}`, SECRET),
      factCandidate("Riverpod was chosen for state management", "Riverpod"),
    ]);
    script.onCall = (stage) => {
      if (stage !== "extract") return;
      fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ broken");
    };

    const result = await runFactExtraction(db, SESSION, PROJECT);

    // The claim is NOT held: a file that broke after the claim does not undo
    // rules this claim already captured.
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBe(1);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
    expect(auditLines().map((line) => line.action)).toContain("rules.stale-read");
  });
});

describe("no overlay means no change at all", () => {
  it("saves exactly what 0.6.9 would and touches no rule machinery", async () => {
    resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);
    const result = await runFactExtraction(db, SESSION, PROJECT);
    expect(result.saved).toBe(1);
    expect(claimSnapshot(db).facts).toBe(1);
    // No clause in the prompt when there is nothing to say.
    expect(script.systemPrompts[0]).not.toContain("User rule overlay");
    expect(auditLines().filter((line) => String(line.action).startsWith("rules."))).toEqual([]);
  });

  it("MEMEX_DISABLE_OVERLAYS=1 ignores a present overlay rather than holding", async () => {
    writeRules(root, rulesDoc([{ id: "user.secret", source: PATTERN }]));
    process.env.MEMEX_DISABLE_OVERLAYS = "1";
    resetExtractionRulesCache();
    resetScript([factCandidate(`The deploy key is ${SECRET}`, SECRET)]);

    const result = await runFactExtraction(db, SESSION, PROJECT);

    // "No overlay", explicitly not "broken overlay": the benchmark harness runs
    // in this mode and must behave exactly like an installation with no file.
    expect(result.skipped).toBeUndefined();
    expect(result.saved).toBe(1);
    expect(claimSnapshot(db).jobHoldReason).toBeNull();
  });
});
