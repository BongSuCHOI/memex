/**
 * D3 / G4 — the write lock.
 *
 * Three specific v2/v3 defects are pinned here, because each one was found by
 * reading rather than by a failing test:
 *
 *  1. The lock used to be released in a `finally` that ran BEFORE the async
 *     validation promise settled, so a concurrent writer could take the lock
 *     while the first writer was still probing. `return await body()` fixes it,
 *     and "the lock is held across an await" is asserted directly.
 *  2. The unreadable-lock observation set was rebuilt per call, so the second
 *     look was unreachable and a corrupt lock blocked writes for ever.
 *  3. After the second look removed a corrupt lock, the loop ended and the call
 *     raised `OverlayLockedError` anyway — the write the operator asked for never
 *     happened. G4 gives the removal one more acquisition attempt, and the test
 *     asserts the write LANDED in the same call.
 *
 * And the invariant that must never bend: a LIVE holder is not stolen from.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OverlayInvalidError,
  OverlayLockedError,
  OverlayStaleError,
  SECOND_LOOK_MS,
  addGatePattern,
  disableGatePattern,
  resetOverlayLockObservations,
  setGateWords,
  withOverlayLock,
} from "../src/overlay-admin.js";
import { currentRecallGateRevision, loadRecallGateOverlay, resetRecallGateOverlayCache } from "../src/recall-gate-overlay.js";
import { resetQuarantineMemory } from "../src/overlay-matcher.js";

let root: string;
let overlayFile: string;
let lockFile: string;
let env: Record<string, string | undefined>;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-overlay-lock-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  overlayFile = path.join(root, "overlays", "recall-gate.json");
  lockFile = `${overlayFile}.lock`;
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
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
  resetOverlayLockObservations();
  resetRecallGateOverlayCache();
});

/** A pid that cannot be alive: the highest pid, plus slack. */
const DEAD_PID = 4_194_303;

function plantLock(payload: unknown): void {
  fs.writeFileSync(lockFile, typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("withOverlayLock", () => {
  it("holds the lock across an await and releases it afterwards", async () => {
    let observedDuringBody: string | null = null;
    const result = await withOverlayLock(overlayFile, async () => {
      // The probe the real write path awaits happens HERE. v2 released before it.
      await delay(20);
      observedDuringBody = fs.readFileSync(lockFile, "utf8");
      return "done";
    });
    expect(result).toBe("done");
    expect(observedDuringBody).not.toBeNull();
    expect(JSON.parse(observedDuringBody!).pid).toBe(process.pid);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("refuses a second writer while the first is still inside its await", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = withOverlayLock(overlayFile, async () => {
      await gate;
      return "first";
    });
    // Let the first acquire.
    await delay(10);
    await expect(withOverlayLock(overlayFile, async () => "second")).rejects.toThrow(OverlayLockedError);
    release!();
    await expect(first).resolves.toBe("first");
  });

  it("NEVER steals a lock held by a live process", async () => {
    plantLock({ pid: process.pid, startedAt: new Date().toISOString() });
    await expect(withOverlayLock(overlayFile, async () => "never")).rejects.toThrow(OverlayLockedError);
    let error: unknown;
    try {
      await withOverlayLock(overlayFile, async () => "never");
    } catch (caught) {
      error = caught;
    }
    expect((error as OverlayLockedError).holderPid).toBe(process.pid);
    // The live holder's lock is still exactly where it was.
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid).toBe(process.pid);
  });

  it("replaces a lock whose holder is gone", async () => {
    plantLock({ pid: DEAD_PID, startedAt: new Date().toISOString() });
    await expect(withOverlayLock(overlayFile, async () => "taken")).resolves.toBe("taken");
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("recovers an UNREADABLE lock through the second look, in the SAME call", async () => {
    plantLock("this is not json");
    const started = Date.now();
    await expect(withOverlayLock(overlayFile, async () => "recovered")).resolves.toBe("recovered");
    // It really waited for the second look rather than deleting on sight — that
    // immediate delete is how 0.6.5 removed a LIVE holder's lock (#102).
    expect(Date.now() - started).toBeGreaterThanOrEqual(SECOND_LOOK_MS - 20);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("recovers an unreadable lock in a FRESH process's first call too", async () => {
    // A new CLI process starts with an empty observation map; it must still reach
    // the second look within one invocation.
    resetOverlayLockObservations();
    plantLock("");
    await expect(withOverlayLock(overlayFile, async () => "ok")).resolves.toBe("ok");
  });

  it("leaves an unreadable lock alone when a writer is still changing it", async () => {
    plantLock("partial");
    // A writer behind the lock: the stamp moves between the two looks.
    const mutate = setTimeout(() => plantLock("partial-but-longer-now"), SECOND_LOOK_MS / 2);
    await expect(withOverlayLock(overlayFile, async () => "ok")).rejects.toThrow(OverlayLockedError);
    clearTimeout(mutate);
    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it("does not remove a lock that a competitor reclaimed while we held it", async () => {
    await withOverlayLock(overlayFile, async () => {
      // Simulate another process deciding ours was stale and writing its own.
      plantLock({ pid: DEAD_PID, startedAt: new Date().toISOString() });
      return "ok";
    });
    // Ours was not there to remove, and the competitor's survived.
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid).toBe(DEAD_PID);
  });

  it("leaves no staging temp files behind, on success or on refusal", async () => {
    await withOverlayLock(overlayFile, async () => "ok");
    plantLock({ pid: process.pid, startedAt: new Date().toISOString() });
    await expect(withOverlayLock(overlayFile, async () => "no")).rejects.toThrow(OverlayLockedError);
    const leftovers = fs.readdirSync(path.dirname(overlayFile)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withOverlayLock(overlayFile, async () => {
        throw new Error("body failed");
      }),
    ).rejects.toThrow("body failed");
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe("G4 — a corrupt lock is recovered AND the write happens in the same call", () => {
  it("performs the requested write after clearing an unreadable lock", async () => {
    plantLock("corrupt, no pid here");
    const result = await addGatePattern(
      { intent: "memory", source: "배포\\s*이력", note: "배포 이력은 항상 회수" },
      { surface: "cli", probe: false },
    );
    // The point of G4: this is revision 1, not an OverlayLockedError.
    expect(result.revision).toBe(1);
    expect(result.hash).toMatch(/^gate:[0-9a-f]{8}$/);
    expect(fs.existsSync(overlayFile)).toBe(true);
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.patterns.map((pattern) => pattern.source)).toEqual(["배포\\s*이력"]);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("still refuses when the corrupt lock keeps changing under it", async () => {
    plantLock("corrupt");
    const mutate = setInterval(() => plantLock(`corrupt-${Date.now()}`), 40);
    await expect(
      addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false }),
    ).rejects.toThrow(OverlayLockedError);
    clearInterval(mutate);
    expect(fs.existsSync(overlayFile)).toBe(false);
  });
});

describe("revision CAS", () => {
  it("merges a delta inside the lock, so nothing read outside is written back", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    await addGatePattern({ intent: "trace", source: "추적" }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    const loaded = loadRecallGateOverlay();
    expect(loaded.revision).toBe(2);
    // The second write did not clobber the first.
    expect(loaded.patterns.map((pattern) => pattern.intent).sort()).toEqual(["memory", "trace"]);
  });

  it("rejects a stale expectedRevision without touching the file", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const before = fs.readFileSync(overlayFile, "utf8");
    await expect(
      addGatePattern({ intent: "memory", source: "계획" }, { surface: "cli", expectedRevision: 7, probe: false }),
    ).rejects.toThrow(OverlayStaleError);
    expect(fs.readFileSync(overlayFile, "utf8")).toBe(before);
    expect(currentRecallGateRevision()).toBe(1);
  });

  it("accepts a matching expectedRevision", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const result = await addGatePattern(
      { intent: "memory", source: "계획" },
      { surface: "cli", expectedRevision: 1, probe: false },
    );
    expect(result.revision).toBe(2);
  });

  it("refuses an invalid change and leaves the file untouched", async () => {
    await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    const before = fs.readFileSync(overlayFile, "utf8");
    await expect(
      addGatePattern({ intent: "memory", source: "(a+)+$" }, { surface: "cli", probe: false }),
    ).rejects.toThrow(OverlayInvalidError);
    expect(fs.readFileSync(overlayFile, "utf8")).toBe(before);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("refuses to write through a symbolic link", async () => {
    const elsewhere = path.join(root, "target.json");
    fs.writeFileSync(elsewhere, "{}");
    fs.symlinkSync(elsewhere, overlayFile);
    await expect(
      addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false }),
    ).rejects.toThrow(/symbolic link/);
    expect(fs.readFileSync(elsewhere, "utf8")).toBe("{}");
  });
});

describe("write API", () => {
  it("disables a built-in by id and removes a user pattern by id", async () => {
    const added = await addGatePattern({ intent: "memory", source: "배포" }, { surface: "cli", probe: false });
    expect(added.revision).toBe(1);
    await disableGatePattern("memory.kr.왜", { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().disabled).toEqual(["memory.kr.왜"]);
    // A user id is DELETED, not disabled — the built-in catalogue is the only
    // thing `disable` is for.
    const userId = loadRecallGateOverlay().patterns[0].id;
    await disableGatePattern(userId, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns).toEqual([]);
    expect(loadRecallGateOverlay().disabled).toEqual(["memory.kr.왜"]);
  });

  it("resolves a regex source to an id as a CLI convenience", async () => {
    await addGatePattern({ intent: "memory", source: "배포\\s*이력", flags: "i" }, { surface: "cli", probe: false });
    await disableGatePattern("배포\\s*이력", { surface: "cli", flags: "i", probe: false });
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns).toEqual([]);
  });

  it("adds and removes lexicon words", async () => {
    await setGateWords("ack", { add: ["ㅇㅈ"], disable: ["확인"] }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    let loaded = loadRecallGateOverlay();
    expect(loaded.words.add.ack).toEqual(["ㅇㅈ"]);
    expect(loaded.words.disable.ack).toEqual(["확인"]);
    await setGateWords("ack", { removeAdd: ["ㅇㅈ"] }, { surface: "cli", probe: false });
    resetRecallGateOverlayCache();
    loaded = loadRecallGateOverlay();
    expect(loaded.words.add.ack).toEqual([]);
    expect(loaded.words.disable.ack).toEqual(["확인"]);
  });

  it("writes one metadata-only ui-audit line per change, with no rule text", async () => {
    await addGatePattern(
      { intent: "memory", source: "배포\\s*이력", note: "사내 비밀 메모" },
      { surface: "cli", probe: false },
    );
    const audit = fs.readFileSync(path.join(root, "logs", "ui-audit.jsonl"), "utf8").trim().split("\n");
    expect(audit).toHaveLength(1);
    const line = JSON.parse(audit[0]);
    expect(line).toMatchObject({ action: "gate.pattern-add", overlay: "recall-gate", to_revision: 1 });
    // Neither the regex nor the operator's note may reach the audit log.
    expect(audit[0]).not.toContain("배포");
    expect(audit[0]).not.toContain("사내 비밀 메모");
  });
});
