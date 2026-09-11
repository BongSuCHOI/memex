/**
 * History, snapshots and rollback.
 *
 * `history.jsonl` is the ONLY path from a `gate:<sha8>` in a recall receipt back
 * to the rules that produced it — the hash is not reversible and is not synced —
 * so the `overlay` field and the from/to hash pair on every line are load
 * bearing, not decoration.
 *
 * The two overlays share a directory and a revision COUNTER SHAPE but not a
 * counter: `recall-gate` revision 1 and `extraction-rules` revision 1 are
 * different documents in different files, and a rollback of one must not touch
 * the other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_SNAPSHOT_LIMIT,
  addGatePattern,
  applyOverlayChange,
  clearQuarantine,
  listOverlayHistory,
  listOverlaySnapshots,
  readOverlaySnapshot,
  resetOverlay,
  resetOverlayLockObservations,
  rollbackOverlay,
  type HistoryEntry,
} from "../src/overlay-admin.js";
import { loadRecallGateOverlay, resetRecallGateOverlayCache } from "../src/recall-gate-overlay.js";
import { quarantinePattern, readQuarantine, resetQuarantineMemory } from "../src/overlay-matcher.js";
import { patternSourceSha8 } from "../src/overlay-regex.js";

let root: string;
let env: Record<string, string | undefined>;

/** Stand-in for the validator lane C owns: accept anything shaped like a doc. */
const rulesValidator = async (doc: unknown) => ({
  ok: true,
  issues: [],
  doc: doc as never,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-overlay-history-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  resetOverlayLockObservations();
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
});

afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
});

async function writeRules(value: Record<string, unknown>): Promise<number> {
  const result = await applyOverlayChange(
    "extraction-rules",
    { doc: { schema: "memex.extraction-rules-overlay", version: 1, ...value } },
    { surface: "cli", auditAction: "rules.set", validator: rulesValidator, probe: false },
  );
  return result.revision;
}

describe("per-overlay history", () => {
  it("keeps the two overlays' revision 1 in separate files", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await writeRules({ exclude_topics: ["급여"] });
    const gateSnapshot = path.join(root, "overlays", "history", "recall-gate", "1.json");
    const rulesSnapshot = path.join(root, "overlays", "history", "extraction-rules", "1.json");
    expect(fs.existsSync(gateSnapshot)).toBe(true);
    expect(fs.existsSync(rulesSnapshot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(gateSnapshot, "utf8")).schema).toBe("memex.recall-gate-overlay");
    expect(JSON.parse(fs.readFileSync(rulesSnapshot, "utf8")).schema).toBe("memex.extraction-rules-overlay");
  });

  it("tags every index line with its overlay, newest first per overlay", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await writeRules({ exclude_topics: ["급여"] });
    await addGatePattern({ intent: "trace", source: "추적" }, { surface: "cli", probe: false });
    const gate = listOverlayHistory("recall-gate");
    const rules = listOverlayHistory("extraction-rules");
    expect(gate.map((entry: HistoryEntry) => entry.to_revision)).toEqual([2, 1]);
    expect(rules.map((entry: HistoryEntry) => entry.to_revision)).toEqual([1]);
    expect(gate.every((entry) => entry.overlay === "recall-gate")).toBe(true);
  });

  it("records the from/to hash pair, which is the only way back from a receipt hash", async () => {
    const first = await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const second = await addGatePattern({ intent: "trace", source: "추적" }, { surface: "cli", probe: false });
    const [latest, earliest] = listOverlayHistory("recall-gate");
    expect(earliest.from_hash).toBeNull();
    expect(earliest.to_hash).toBe(first.hash);
    expect(latest.from_hash).toBe(first.hash);
    expect(latest.to_hash).toBe(second.hash);
    expect(latest.added).toHaveLength(1);
  });

  it("never writes rule text into the index", async () => {
    await addGatePattern(
      { intent: "memory", source: "사내\\s*급여", note: "민감한 메모" },
      { surface: "cli", probe: false },
    );
    const raw = fs.readFileSync(path.join(root, "overlays", "history.jsonl"), "utf8");
    expect(raw).not.toContain("사내");
    expect(raw).not.toContain("민감한 메모");
    expect(raw).toContain("recall-gate");
  });

  it("keeps at most 20 snapshots per overlay, dropping the oldest", async () => {
    for (let i = 0; i < HISTORY_SNAPSHOT_LIMIT + 3; i++) {
      await addGatePattern({ intent: "memory", source: `배포${i}` }, { surface: "cli", probe: false });
    }
    const kept = listOverlaySnapshots("recall-gate");
    expect(kept).toHaveLength(HISTORY_SNAPSHOT_LIMIT);
    expect(kept[0]).toBe(4);
    expect(kept[kept.length - 1]).toBe(HISTORY_SNAPSHOT_LIMIT + 3);
    expect(readOverlaySnapshot("recall-gate", 1)).toBeNull();
    expect(readOverlaySnapshot("recall-gate", HISTORY_SNAPSHOT_LIMIT + 3)).not.toBeNull();
  });
});

describe("rollback", () => {
  it("restores an earlier revision as a NEW revision, leaving the history intact", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await addGatePattern({ intent: "trace", source: "추적" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns).toHaveLength(2);

    const rolled = await rollbackOverlay("recall-gate", 1, { surface: "cli" });
    // Rolling back moves FORWARD: revision 3 holds revision 1's rules.
    expect(rolled.revision).toBe(3);
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.revision).toBe(3);
    expect(loaded.patterns.map((pattern) => pattern.source)).toEqual(["배포"]);
    expect(listOverlayHistory("recall-gate")[0].action).toBe("gate.rollback");
  });

  it("touches only the overlay it was asked about", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await writeRules({ exclude_topics: ["급여"] });
    await writeRules({ exclude_topics: ["급여", "인사 평가"] });
    await rollbackOverlay("extraction-rules", 1, { surface: "cli", validator: rulesValidator });
    const rules = JSON.parse(
      fs.readFileSync(path.join(root, "overlays", "extraction-rules.json"), "utf8"),
    );
    expect(rules.exclude_topics).toEqual(["급여"]);
    expect(rules.revision).toBe(3);
    resetRecallGateOverlayCache();
    // The gate overlay is exactly where it was.
    expect(loadRecallGateOverlay().revision).toBe(1);
    expect(loadRecallGateOverlay().patterns).toHaveLength(1);
  });

  it("refuses a revision whose snapshot is gone, and names what is kept", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await expect(rollbackOverlay("recall-gate", 99, { surface: "cli" })).rejects.toThrow(/no snapshot/);
    await expect(rollbackOverlay("recall-gate", 99, { surface: "cli" })).rejects.toThrow(/kept: 1/);
  });
});

describe("reset", () => {
  it("empties the overlay as a new revision rather than deleting the file", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const reset = await resetOverlay("recall-gate", { surface: "cli" });
    expect(reset.revision).toBe(2);
    expect(fs.existsSync(path.join(root, "overlays", "recall-gate.json"))).toBe(true);
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns).toEqual([]);
    expect(loaded.revision).toBe(2);
    // Still rollbackable, which is the point of not deleting.
    await rollbackOverlay("recall-gate", 1, { surface: "cli" });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns).toHaveLength(1);
  });

  it("resets the extraction-rules overlay with the validator its lane owns", async () => {
    // overlay-admin.ts has no idea what a valid extraction-rules document is —
    // lane C owns that. The reset path has to carry the validator through, or it
    // throws "pass it as opts.validator" on a document it was handed.
    await writeRules({ exclude_topics: ["급여"] });
    const reset = await resetOverlay("extraction-rules", {
      surface: "cli",
      emptyDoc: { schema: "memex.extraction-rules-overlay", version: 1, exclude_topics: [] },
      validator: rulesValidator,
    });
    expect(reset.revision).toBe(2);
    const written = JSON.parse(fs.readFileSync(path.join(root, "overlays", "extraction-rules.json"), "utf8"));
    expect(written.exclude_topics).toEqual([]);
    expect(listOverlayHistory("extraction-rules")[0].action).toBe("rules.reset");
  });

  it("refuses an extraction-rules reset with no empty document to write", async () => {
    await expect(resetOverlay("extraction-rules", { surface: "cli" })).rejects.toThrow(/emptyDoc/);
  });

  it("scoped to one intent, leaves the other intents alone", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await addGatePattern({ intent: "trace", source: "추적" }, { surface: "cli", probe: false });
    await resetOverlay("recall-gate", { surface: "cli", intent: "memory" });
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns.map((pattern) => pattern.intent)).toEqual(["trace"]);
  });

  it("re-enables the built-ins of the intent it resets", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const { disableGatePattern } = await import("../src/overlay-admin.js");
    await disableGatePattern("memory.kr.왜", { surface: "cli", probe: false });
    await disableGatePattern("trace.kr.왜", { surface: "cli", probe: false });
    await resetOverlay("recall-gate", { surface: "cli", intent: "memory" });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().disabled).toEqual(["trace.kr.왜"]);
  });
});

describe("quarantine clearing", () => {
  it("clears a quarantine row automatically once the operator edits the regex", async () => {
    // "Editing" a pattern is remove-then-add, because the id IS sha8(intent,
    // source, flags): a changed regex is a different pattern. The quarantine key
    // is (pattern_id, source_sha8), so the old row has nothing live behind it and
    // the next write reaps it — the operator does not have to clear it by hand.
    const { disableGatePattern } = await import("../src/overlay-admin.js");
    await addGatePattern({ intent: "memory", source: "배포\\s*이력", flags: "i" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    const id = loadRecallGateOverlay().patterns[0].id;
    quarantinePattern({
      overlay: "recall-gate",
      pattern_id: id,
      source_sha8: patternSourceSha8("배포\\s*이력", "i"),
      at: new Date().toISOString(),
      elapsed_ms: 50,
      input_chars: 100,
      surface: "daemon",
    });
    expect(readQuarantine()).toHaveLength(1);
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns).toEqual([]); // quarantined, so not applied

    const removed = await disableGatePattern(id, { surface: "cli", probe: false });
    expect(removed.quarantineCleared).toEqual([id]);
    expect(readQuarantine()).toEqual([]);

    // Re-added with the corrected regex: applied again, with no stale row.
    await addGatePattern({ intent: "memory", source: "배포\\s*기록", flags: "i" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns.map((pattern) => pattern.source)).toEqual(["배포\\s*기록"]);
    expect(readQuarantine()).toEqual([]);
  });

  it("reaps only the removed pattern's row, never a sibling's", async () => {
    const { disableGatePattern } = await import("../src/overlay-admin.js");
    await addGatePattern({ intent: "memory", source: "배포", flags: "i" }, { surface: "cli", probe: false });
    await addGatePattern({ intent: "trace", source: "추적", flags: "i" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    const [first, second] = loadRecallGateOverlay().patterns;
    for (const pattern of [first, second]) {
      quarantinePattern({
        overlay: "recall-gate", pattern_id: pattern.id,
        source_sha8: patternSourceSha8(pattern.source, pattern.flags),
        at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
      });
    }
    const removed = await disableGatePattern(first.id, { surface: "cli", probe: false });
    expect(removed.quarantineCleared).toEqual([first.id]);
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual([second.id]);
  });

  it("keeps a row whose pattern is unchanged", async () => {
    await addGatePattern({ intent: "memory", source: "배포", flags: "i" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    const id = loadRecallGateOverlay().patterns[0].id;
    quarantinePattern({
      overlay: "recall-gate", pattern_id: id, source_sha8: patternSourceSha8("배포", "i"),
      at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
    });
    // A write that adds an unrelated pattern must not clear it.
    const result = await setGateWordsForTest();
    expect(result.quarantineCleared).toEqual([]);
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual([id]);
  });

  it("clearQuarantine removes one pattern's rows, or all of them", async () => {
    quarantinePattern({
      overlay: "recall-gate", pattern_id: "user.a", source_sha8: "aaaaaaaa",
      at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
    });
    quarantinePattern({
      overlay: "recall-gate", pattern_id: "user.b", source_sha8: "bbbbbbbb",
      at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
    });
    // A dry run names the same rows and changes nothing.
    expect(await clearQuarantine("user.a", { dryRun: true })).toEqual({ cleared: 1, ids: ["user.a"], dryRun: true });
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual(["user.a", "user.b"]);

    expect(await clearQuarantine("user.a")).toEqual({ cleared: 1, ids: ["user.a"], dryRun: false });
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual(["user.b"]);
    expect(await clearQuarantine()).toEqual({ cleared: 1, ids: ["user.b"], dryRun: false });
    expect(readQuarantine()).toEqual([]);
    expect(await clearQuarantine()).toEqual({ cleared: 0, ids: [], dryRun: false });
    const audit = fs.readFileSync(path.join(root, "logs", "ui-audit.jsonl"), "utf8");
    expect(audit).toContain("gate.quarantine-clear");
  });
});

async function setGateWordsForTest() {
  const { setGateWords } = await import("../src/overlay-admin.js");
  return setGateWords("ack", { add: ["ㅇㅈ"] }, { surface: "cli", probe: false });
}
