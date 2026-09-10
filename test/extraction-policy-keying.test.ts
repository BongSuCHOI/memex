/**
 * The rule hash must NEVER reach the scheduling key (#30 §3.5.1, R2 — critical).
 *
 * `FACT_EXTRACTION_POLICY_VERSION` is part of the
 * `exchange_extraction_state(exchange_id, content_generation, policy_version)`
 * primary key, and both `ensureExtractionTarget()` and
 * `pendingExtractionCoreQuery()` decide "already processed" by matching it. Fold a
 * rule hash in and one edited character in a local JSON file marks the ENTIRE
 * corpus unprocessed: every session re-extracts, at full model cost, silently.
 *
 * The issue text originally proposed exactly that, which is why this guard is a
 * test and not a comment. It pins the constant, and it pins the observable
 * consequence: with an overlay applied, the same input still produces the same
 * `target_id` and the same item set — only `rules_hash` differs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import { initDatabase } from "../src/db.js";
import {
  FACT_EXTRACTION_POLICY_VERSION,
  ensureExtractionTarget,
  setExtractionTargetRulesHash,
} from "../src/continuity-store.js";
import { pendingExtractionCoreQuery, getExtractionConfig } from "../src/pending-extraction.js";
import {
  effectiveExtractionPolicyVersion,
  EXTRACTION_POLICY_VERSION,
} from "../src/fact-extractor.js";
import {
  composeEffectivePolicyVersion,
  extractionRulesHash,
  resetExtractionRulesCache,
} from "../src/extraction-rules.js";
import {
  PROJECT,
  SESSION,
  pinOverlayEnv,
  restoreOverlayEnv,
  rulesDoc,
  seedExchanges,
  writeRules,
} from "./extraction-rules-fixture.js";

let root: string;
let db: Database.Database;

interface TargetShape {
  targetId: string;
  itemCount: number;
  items: string[];
  policyVersion: string;
}

function describeTarget(): TargetShape {
  const target = ensureExtractionTarget(db, {
    sessionId: SESSION,
    project: PROJECT,
    policyVersion: FACT_EXTRACTION_POLICY_VERSION,
  })!;
  const items = (db.prepare(
    "SELECT exchange_id FROM extraction_target_items WHERE target_id = ? ORDER BY ordinal",
  ).all(target.targetId) as Array<{ exchange_id: string }>).map((row) => row.exchange_id);
  return {
    targetId: target.targetId,
    itemCount: target.itemCount,
    items,
    policyVersion: target.policyVersion,
  };
}

/** Everything the continuity pending query keys on, as one string. */
function pendingQueryKey(): string {
  const { sql, params } = pendingExtractionCoreQuery(getExtractionConfig(), "continuity");
  return `${sql}\n${JSON.stringify(params)}`;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-policy-keying-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetExtractionRulesCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: "Riverpod was chosen for state management.", count: 8 });
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  restoreOverlayEnv();
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the scheduling key", () => {
  it("is the bare constant, with no overlay hash anywhere in it", () => {
    expect(FACT_EXTRACTION_POLICY_VERSION).toBe("continuity-fact-v1");
    writeRules(root, rulesDoc([{ id: "user.secret", source: "\\bsk-[A-Za-z0-9_-]{16,}" }]));
    resetExtractionRulesCache();
    expect(extractionRulesHash()).toMatch(/^rules:[0-9a-f]{8}$/);
    // Still the bare constant after the overlay is applied.
    expect(FACT_EXTRACTION_POLICY_VERSION).toBe("continuity-fact-v1");
    expect(FACT_EXTRACTION_POLICY_VERSION).not.toContain("rules:");
  });

  it("produces an IDENTICAL target for identical input, with and without rules", () => {
    const without = describeTarget();
    // Throw the target away so the next call rebuilds it from the exchanges.
    db.prepare("DELETE FROM memory_jobs").run();
    db.prepare("DELETE FROM extraction_targets").run();
    db.prepare("DELETE FROM exchange_extraction_state").run();

    writeRules(root, rulesDoc([{ id: "user.secret", source: "\\bsk-[A-Za-z0-9_-]{16,}" }]));
    resetExtractionRulesCache();
    const withRules = describeTarget();

    // `target_id` is sha256 over session, fences, POLICY and the item identity.
    // If the rule hash had leaked into the policy, this id would move and every
    // previously processed generation would look unprocessed.
    expect(withRules.targetId).toBe(without.targetId);
    expect(withRules.items).toEqual(without.items);
    expect(withRules.itemCount).toBe(without.itemCount);
    expect(withRules.policyVersion).toBe("continuity-fact-v1");
  });

  it("leaves processed generations processed after a rule change", () => {
    describeTarget();
    db.prepare(
      "UPDATE exchange_extraction_state SET state = 'processed' WHERE policy_version = ?",
    ).run(FACT_EXTRACTION_POLICY_VERSION);
    const processed = Number(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM exchange_extraction_state WHERE state = 'processed'",
      ).get() as { n: number }).n,
    );
    expect(processed).toBeGreaterThan(0);

    writeRules(root, rulesDoc([{ id: "user.secret", source: "ghp_[A-Za-z0-9]{8,}" }]));
    resetExtractionRulesCache();

    // No new target: every generation is still accounted for under this policy.
    db.prepare("DELETE FROM memory_jobs").run();
    db.prepare("DELETE FROM extraction_targets").run();
    expect(
      ensureExtractionTarget(db, {
        sessionId: SESSION,
        project: PROJECT,
        policyVersion: FACT_EXTRACTION_POLICY_VERSION,
      }),
    ).toBeNull();
    // And the pending query — the other place that decides "already processed" —
    // still keys on the bare constant.
    expect(pendingQueryKey()).toContain("continuity-fact-v1");
    expect(pendingQueryKey()).not.toContain("rules:");
  });
});

describe("the reporting identifier is separate and derived", () => {
  it("is the bare policy with no overlay and policy+hash with one", () => {
    expect(effectiveExtractionPolicyVersion()).toBe(EXTRACTION_POLICY_VERSION);
    writeRules(root, rulesDoc([{ id: "user.secret", source: "\\bsk-[A-Za-z0-9_-]{16,}" }]));
    resetExtractionRulesCache();
    const hash = extractionRulesHash()!;
    expect(effectiveExtractionPolicyVersion()).toBe(`${EXTRACTION_POLICY_VERSION}+${hash}`);
    expect(composeEffectivePolicyVersion(EXTRACTION_POLICY_VERSION, hash)).toBe(
      effectiveExtractionPolicyVersion(),
    );
    // It names the EXTRACTION policy, never the scheduling key.
    expect(effectiveExtractionPolicyVersion()).not.toContain(FACT_EXTRACTION_POLICY_VERSION);
  });
});

describe("extraction_targets.rules_hash", () => {
  it("is nullable, additive and the only thing a rule change moves", () => {
    const target = describeTarget();
    const read = (): string | null =>
      (db.prepare("SELECT rules_hash FROM extraction_targets WHERE target_id = ?")
        .get(target.targetId) as { rules_hash: string | null }).rules_hash;
    expect(read()).toBeNull();

    expect(setExtractionTargetRulesHash(db, target.targetId, "rules:9c1e4d07")).toBe(true);
    expect(read()).toBe("rules:9c1e4d07");
    // Idempotent: the claim path calls it unconditionally.
    expect(setExtractionTargetRulesHash(db, target.targetId, "rules:9c1e4d07")).toBe(false);
    expect(setExtractionTargetRulesHash(db, target.targetId, null)).toBe(true);
    expect(read()).toBeNull();

    // The identity of the target did not move with it.
    expect(describeTarget().targetId).toBe(target.targetId);
  });
});
