/**
 * The read side: schema, limits, cache invalidation, and the FAIL-SAFE contract.
 *
 * The gate overlay fails OPEN on purpose (G1): a file that will not load must
 * leave the built-ins running and the prompt served, because the gate decides
 * what is RECALLED, never what is stored. It must also say so out loud — doctor
 * fails, and the label carries a suffix — so "the operator's rules are silently
 * off" cannot be the quiet outcome.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OVERLAY_LIMITS,
  currentRecallGateRevision,
  gateCatalog,
  loadRecallGateOverlay,
  recallGateOverlayChecks,
  recallGateOverlayHash,
  resetRecallGateOverlayCache,
  validateRecallGateOverlayDoc,
  toUserIntentHits,
} from "../src/recall-gate-overlay.js";
import { resetQuarantineMemory } from "../src/overlay-matcher.js";
import { patternSourceSha8 } from "../src/overlay-regex.js";
import { detectPromptIntents } from "../src/recall-gate.js";

let root: string;
let overlayFile: string;
let quarantineFile: string;
let env: Record<string, string | undefined>;

function doc(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "memex.recall-gate-overlay",
    version: 1,
    revision: 1,
    updated_at: "2026-09-10T12:03:41.118Z",
    updated_by: { surface: "cli" },
    ...extra,
  };
}

function write(value: unknown): void {
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
  fs.writeFileSync(overlayFile, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  resetRecallGateOverlayCache();
}

function errorCodes(value: unknown): string[] {
  return validateRecallGateOverlayDoc(value).issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.code);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-gate-overlay-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
    MEMEX_DISABLE_OVERLAYS: process.env.MEMEX_DISABLE_OVERLAYS,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  overlayFile = path.join(root, "overlays", "recall-gate.json");
  quarantineFile = path.join(root, "overlays", "quarantine.json");
  resetQuarantineMemory();
  resetRecallGateOverlayCache();
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

describe("recall-gate overlay validation", () => {
  it("accepts a complete document and fills in the pattern id", () => {
    const result = validateRecallGateOverlayDoc(
      doc({
        patterns: {
          add: [{ intent: "memory", source: "배포\\s*이력", flags: "i", note: "배포 이력은 항상 회수" }],
          disable: ["memory.kr.다시"],
        },
        words: { add: { ack: ["ㅇㅈ"] }, disable: { ack: ["확인"] } },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.doc?.patterns?.add?.[0].id).toMatch(/^user\.[0-9a-f]{8}$/);
    expect(result.doc?.patterns?.disable).toEqual(["memory.kr.다시"]);
    expect(result.doc?.words?.add?.ack).toEqual(["ㅇㅈ"]);
  });

  it("rejects the envelope failures without partially applying anything", () => {
    expect(errorCodes("not an object at all")).toContain("OVERLAY_NOT_OBJECT");
    expect(errorCodes([])).toContain("OVERLAY_NOT_OBJECT");
    expect(errorCodes({ ...doc(), schema: "memex.something-else" })).toContain("OVERLAY_SCHEMA_MISMATCH");
    expect(errorCodes({ ...doc(), version: 2 })).toContain("OVERLAY_VERSION_UNSUPPORTED");
    // An unknown version stops right there: no patterns are read at all.
    const future = validateRecallGateOverlayDoc({
      ...doc({ patterns: { add: [{ intent: "memory", source: "배포", flags: "i" }] } }),
      version: 99,
    });
    expect(future.doc).toBeNull();
  });

  it("refuses a file over the byte limit before any domain check", () => {
    const result = validateRecallGateOverlayDoc(doc(), { bytes: OVERLAY_LIMITS.fileBytes + 1 });
    expect(result.issues.map((issue) => issue.code)).toEqual(["OVERLAY_TOO_LARGE"]);
  });

  it("flags each structural failure with a code and a path", () => {
    const result = validateRecallGateOverlayDoc(
      doc({
        patterns: {
          add: [
            { intent: "nope", source: "x" },
            { intent: "memory", source: "a".repeat(OVERLAY_LIMITS.patternSource + 1), flags: "i" },
            { id: "user.dup", intent: "memory", source: "배포", flags: "i" },
            { id: "user.dup", intent: "memory", source: "계획", flags: "i" },
          ],
        },
        words: { add: { nosuchlexicon: ["x"], ack: ["has space"] } },
      }),
    );
    const byCode = new Map(result.issues.map((issue) => [issue.code, issue]));
    expect(byCode.get("INTENT_UNKNOWN")?.path).toBe("patterns.add[0].intent");
    expect(byCode.get("PATTERN_TOO_LONG")?.path).toBe("patterns.add[1].source");
    expect(byCode.get("PATTERN_DUPLICATE_ID")?.path).toBe("patterns.add[3].id");
    expect(byCode.get("LEXICON_UNKNOWN")?.path).toBe("words.add.nosuchlexicon");
    expect(byCode.get("WORD_INVALID")?.path).toBe("words.add.ack[0]");
    expect(result.ok).toBe(false);
  });

  it("enforces the count limits, globally and per intent", () => {
    const many = Array.from({ length: OVERLAY_LIMITS.counts.patternsAdd + 1 }, (_, i) => ({
      id: `user.${i}`, intent: "memory", source: `x${i}`, flags: "i",
    }));
    expect(errorCodes(doc({ patterns: { add: many } }))).toContain("PATTERN_COUNT_EXCEEDED");
    const perIntent = Array.from({ length: OVERLAY_LIMITS.counts.patternsAddPerIntent + 1 }, (_, i) => ({
      id: `user.t${i}`, intent: "trace", source: `y${i}`, flags: "i",
    }));
    expect(errorCodes(doc({ patterns: { add: perIntent } }))).toContain("PATTERN_COUNT_EXCEEDED");
  });

  it("warns — never errors — on an unknown disable id or an unknown top-level field", () => {
    const result = validateRecallGateOverlayDoc(
      doc({ patterns: { disable: ["memory.kr.nope"] }, config: { driftJaccard: 0.2 } }),
    );
    expect(result.ok).toBe(true);
    const codes = result.issues.map((issue) => issue.code);
    expect(codes).toContain("DISABLE_ID_UNKNOWN");
    // Forward compatibility: 0.7.1 adds `config` and 0.7.0 must ignore it quietly.
    expect(codes).toContain("OVERLAY_UNKNOWN_FIELD");
    expect(result.issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("warns when a user regex is byte-identical to a built-in, but only on a write", () => {
    const shadow = doc({ patterns: { add: [{ intent: "memory", source: "\\bwhy\\b", flags: "i" }] } });
    expect(validateRecallGateOverlayDoc(shadow).issues.map((i) => i.code)).not.toContain("PATTERN_SHADOWED");
    expect(validateRecallGateOverlayDoc(shadow, { forWrite: true }).issues.map((i) => i.code))
      .toContain("PATTERN_SHADOWED");
  });
});

describe("recall-gate overlay hash", () => {
  it("ignores revision, updated_at, updated_by and key order", () => {
    const rules = { patterns: { add: [{ id: "user.a", intent: "memory" as const, source: "배포", flags: "i" }] } };
    const a = validateRecallGateOverlayDoc(doc({ ...rules, revision: 1 })).doc!;
    const b = validateRecallGateOverlayDoc(
      doc({ ...rules, revision: 99, updated_at: "2030-01-01T00:00:00.000Z", updated_by: { surface: "web-ui" } }),
    ).doc!;
    expect(recallGateOverlayHash(a)).toBe(recallGateOverlayHash(b));
    expect(recallGateOverlayHash(a)).toMatch(/^gate:[0-9a-f]{8}$/);
  });

  it("moves when a rule actually changes", () => {
    const a = validateRecallGateOverlayDoc(
      doc({ patterns: { add: [{ intent: "memory", source: "배포", flags: "i" }] } }),
    ).doc!;
    const b = validateRecallGateOverlayDoc(
      doc({ patterns: { add: [{ intent: "memory", source: "배포 계획", flags: "i" }] } }),
    ).doc!;
    expect(recallGateOverlayHash(a)).not.toBe(recallGateOverlayHash(b));
  });

  it("is insensitive to the ORDER of disables and words, but not of patterns", () => {
    const left = validateRecallGateOverlayDoc(
      doc({ patterns: { disable: ["memory.kr.왜", "trace.kr.왜"] }, words: { add: { ack: ["b", "a"] } } }),
    ).doc!;
    const right = validateRecallGateOverlayDoc(
      doc({ patterns: { disable: ["trace.kr.왜", "memory.kr.왜"] }, words: { add: { ack: ["a", "b"] } } }),
    ).doc!;
    expect(recallGateOverlayHash(left)).toBe(recallGateOverlayHash(right));
    // Pattern ORDER is alternation order, which changes matching, so it counts.
    const first = validateRecallGateOverlayDoc(
      doc({ patterns: { add: [{ intent: "memory", source: "a" }, { intent: "memory", source: "b" }] } }),
    ).doc!;
    const second = validateRecallGateOverlayDoc(
      doc({ patterns: { add: [{ intent: "memory", source: "b" }, { intent: "memory", source: "a" }] } }),
    ).doc!;
    expect(recallGateOverlayHash(first)).not.toBe(recallGateOverlayHash(second));
  });
});

describe("recall-gate overlay load", () => {
  it("reports absence as the built-in default, with no issues", () => {
    const loaded = loadRecallGateOverlay();
    expect(loaded).toMatchObject({ present: false, hash: null, revision: 0, patterns: [], issues: [] });
    expect(currentRecallGateRevision()).toBe(0);
  });

  it("loads a valid overlay and exposes hash, revision and patterns", () => {
    write(doc({ revision: 8, patterns: { add: [{ id: "user.x", intent: "memory", source: "배포", flags: "i" }] } }));
    const loaded = loadRecallGateOverlay();
    expect(loaded.present).toBe(true);
    expect(loaded.revision).toBe(8);
    expect(loaded.hash).toMatch(/^gate:[0-9a-f]{8}$/);
    expect(loaded.patterns).toEqual([
      { id: "user.x", intent: "memory", source: "배포", flags: "i", overlay: "recall-gate" },
    ]);
    expect(currentRecallGateRevision()).toBe(8);
  });

  it("falls back to the built-ins on a damaged file, without throwing", () => {
    write("{ this is not json");
    const loaded = loadRecallGateOverlay();
    expect(loaded.present).toBe(true);
    expect(loaded.hash).toBeNull();
    expect(loaded.patterns).toEqual([]);
    expect(loaded.issues.some((issue) => issue.code === "OVERLAY_UNREADABLE")).toBe(true);
    // The gate still works exactly as it did before the overlay existed.
    expect(detectPromptIntents("왜 그랬어").memory).toBe(true);
  });

  it("ignores the overlay ENTIRELY when any issue is an error — never half of it", () => {
    write(
      doc({
        patterns: {
          add: [
            { id: "user.good", intent: "memory", source: "배포", flags: "i" },
            { id: "user.bad", intent: "memory", source: "(a+)+$", flags: "i" },
          ],
        },
        words: { add: { ack: ["ㅇㅈ"] } },
      }),
    );
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns).toEqual([]);
    expect(loaded.words.add.ack).toEqual([]);
    expect(loaded.hash).toBeNull();
    expect(loaded.issues.some((issue) => issue.code === "REGEX_QUANTIFIED_GROUP")).toBe(true);
  });

  it("refuses to read through a symbolic link", () => {
    const real = path.join(root, "elsewhere.json");
    fs.writeFileSync(real, JSON.stringify(doc()));
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    fs.symlinkSync(real, overlayFile);
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns).toEqual([]);
    expect(loaded.issues[0].code).toBe("OVERLAY_UNREADABLE");
    expect(loaded.issues[0].message).toMatch(/symbolic link/);
  });

  it("invalidates its cache when the overlay file changes", () => {
    write(doc({ revision: 1, patterns: { add: [{ id: "user.a", intent: "memory", source: "배포", flags: "i" }] } }));
    expect(loadRecallGateOverlay().revision).toBe(1);
    const before = loadRecallGateOverlay();
    // Same key: the very same object comes back, proving the cache is used.
    expect(loadRecallGateOverlay()).toBe(before);
    fs.writeFileSync(
      overlayFile,
      JSON.stringify(doc({ revision: 2, patterns: { add: [{ id: "user.b", intent: "trace", source: "추적", flags: "i" }] } })),
    );
    const after = loadRecallGateOverlay();
    expect(after).not.toBe(before);
    expect(after.revision).toBe(2);
    expect(after.patterns.map((pattern) => pattern.id)).toEqual(["user.b"]);
  });

  it("invalidates its cache when the QUARANTINE file changes", () => {
    const source = "배포";
    write(doc({ patterns: { add: [{ id: "user.a", intent: "memory", source, flags: "i" }] } }));
    expect(loadRecallGateOverlay().patterns).toHaveLength(1);
    fs.writeFileSync(
      quarantineFile,
      JSON.stringify({
        schema: "memex.overlay-quarantine",
        version: 1,
        entries: [{
          overlay: "recall-gate", pattern_id: "user.a", source_sha8: patternSourceSha8(source, "i"),
          at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
        }],
      }),
    );
    // No reset: the cache key itself has to notice.
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns).toEqual([]);
    expect(loaded.quarantined.map((entry) => entry.pattern_id)).toEqual(["user.a"]);
  });

  it("MEMEX_DISABLE_OVERLAYS=1 reads nothing at all", () => {
    write(doc({ patterns: { add: [{ id: "user.a", intent: "memory", source: "배포", flags: "i" }] } }));
    expect(loadRecallGateOverlay().present).toBe(true);
    process.env.MEMEX_DISABLE_OVERLAYS = "1";
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay()).toMatchObject({ present: false, hash: null, patterns: [] });
  });

  it("does not start a probe worker on the load path", () => {
    // The probe is a measuring worker and the load path runs on every prompt; the
    // parser alone is pure, linear and terminating. A pattern the probe would
    // reject still LOADS — it is the 50 ms execution box that catches it.
    write(doc({ patterns: { add: [{ id: "user.slowish", intent: "memory", source: "^a+b?a+b?a+$", flags: "" }] } }));
    const started = Date.now();
    const loaded = loadRecallGateOverlay();
    expect(Date.now() - started).toBeLessThan(100);
    expect(loaded.patterns.map((pattern) => pattern.id)).toEqual(["user.slowish"]);
  });
});

describe("gate plumbing", () => {
  it("exposes the catalogue and the limit table", () => {
    const catalog = gateCatalog();
    expect(catalog.builtin.length).toBeGreaterThan(50);
    expect(catalog.words.ack.length).toBeGreaterThan(10);
    expect(catalog.limits.counts.patternsAdd).toBe(64);
  });

  it("builds no hits object at all when the overlay changes nothing", () => {
    const loaded = loadRecallGateOverlay();
    expect(toUserIntentHits(loaded, { intents: {} })).toBeUndefined();
  });

  it("carries the word lists even when the matcher found nothing", () => {
    write(doc({ words: { add: { ack: ["ㅇㅈ"] }, disable: { ack: ["확인"] } } }));
    const hits = toUserIntentHits(loadRecallGateOverlay(), { intents: {} });
    expect(hits?.words?.add?.ack).toEqual(["ㅇㅈ"]);
    expect(hits?.words?.disable?.ack).toEqual(["확인"]);
    expect(detectPromptIntents("ㅇㅈ", hits).acknowledgement).toBe(true);
  });

  it("carries the disable list so the gate recomposes the built-ins", () => {
    write(doc({ patterns: { disable: ["memory.kr.왜"] } }));
    const hits = toUserIntentHits(loadRecallGateOverlay(), { intents: {} });
    expect(hits?.disabledPatterns).toEqual(["memory.kr.왜"]);
    expect(detectPromptIntents("왜 그랬어", hits).memory).toBe(false);
  });
});

describe("doctor checks", () => {
  it("says built-in defaults when there is no overlay", async () => {
    const checks = await recallGateOverlayChecks();
    expect(checks.map((check) => check.name)).toEqual([
      "recall-gate-overlay", "overlay-pattern-quarantine", "overlay-matcher",
    ]);
    expect(checks[0]).toMatchObject({ status: "ok", detail: "absent — built-in defaults only" });
    expect(checks[1].status).toBe("ok");
    // No user pattern to run is a warn, not an ok: there is nothing to prove.
    expect(checks[2]).toMatchObject({ status: "warn", detail: "no user pattern to run" });
  });

  it("FAILS loudly when the overlay is invalid, naming the built-in fallback", async () => {
    write("{ broken");
    const checks = await recallGateOverlayChecks();
    const overlay = checks.find((check) => check.name === "recall-gate-overlay")!;
    expect(overlay.status).toBe("fail");
    expect(overlay.detail).toMatch(/BUILT-IN DEFAULTS/);
    expect(overlay.detail).toMatch(/memex gate validate/);
  });

  it("FAILS when a pattern is quarantined — a silently disabled rule is not a warning", async () => {
    const source = "배포";
    write(doc({ patterns: { add: [{ id: "user.a", intent: "memory", source, flags: "i" }] } }));
    fs.writeFileSync(
      quarantineFile,
      JSON.stringify({
        schema: "memex.overlay-quarantine",
        version: 1,
        entries: [{
          overlay: "recall-gate", pattern_id: "user.a", source_sha8: patternSourceSha8(source, "i"),
          at: new Date().toISOString(), elapsed_ms: 50, input_chars: 10, surface: "daemon",
        }],
      }),
    );
    resetRecallGateOverlayCache();
    const checks = await recallGateOverlayChecks();
    const quarantine = checks.find((check) => check.name === "overlay-pattern-quarantine")!;
    expect(quarantine.status).toBe("fail");
    expect(quarantine.detail).toMatch(/user\.a/);
    expect(quarantine.detail).toMatch(/NOT applied/);
    // The overlay check itself stays ok/warn: the rest of it is still applied.
    expect(checks.find((check) => check.name === "recall-gate-overlay")!.status).not.toBe("fail");
  });

  it("reports the matcher as available when a real worker can run the patterns", async () => {
    write(doc({ patterns: { add: [{ id: "user.a", intent: "memory", source: "배포", flags: "i" }] } }));
    const checks = await recallGateOverlayChecks();
    expect(checks.find((check) => check.name === "overlay-matcher")).toMatchObject({
      status: "ok", detail: "pattern matcher worker available",
    });
  });

  it("FAILS the matcher check when the worker cannot be used, and says both directions", async () => {
    write(doc({ patterns: { add: [{ id: "user.a", intent: "memory", source: "배포", flags: "i" }] } }));
    const checks = await recallGateOverlayChecks(async () => false);
    const matcher = checks.find((check) => check.name === "overlay-matcher")!;
    expect(matcher.status).toBe("fail");
    expect(matcher.detail).toMatch(/fail-safe/);
    expect(matcher.detail).toMatch(/fail-closed/);
  });
});
