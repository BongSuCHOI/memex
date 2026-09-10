/**
 * The D1 core: a slow user pattern cannot stop the matching thread.
 *
 * The planted pattern is the reviewer's counterexample. It is handed STRAIGHT to
 * `match()`, bypassing the grammar check on purpose — the point of these tests is
 * that the time box holds even for a pattern no structural rule rejects. (The
 * grammar parser does refuse this 9-quantifier form, and `overlay-regex.test.ts`
 * shows the 7-quantifier variant that it accepts.)
 *
 * Everything writes under a temp MEMEX_HOME / MEMEX_OVERLAY_DIR; the real data
 * root is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATCH_WALL_MS,
  oneShotMatcher,
  persistentMatcher,
  readQuarantine,
  resetQuarantineMemory,
  type MatcherHandle,
} from "../src/overlay-matcher.js";
import { loadRecallGateOverlay, resetRecallGateOverlayCache } from "../src/recall-gate-overlay.js";
import { patternSourceSha8 } from "../src/overlay-regex.js";

/** No groups, no backreferences, no overlapping adjacent quantified atoms. */
const COUNTEREXAMPLE = "^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$";
const EVIL_INPUT = "a".repeat(80) + "!";
const SLOW = [{ id: "user.slow", intent: "memory" as const, source: COUNTEREXAMPLE, flags: "" }];
const FAST = [{ id: "user.fast", intent: "memory" as const, source: "배포\\s*이력", flags: "i" }];

let root: string;
let env: Record<string, string | undefined>;
const handles: MatcherHandle[] = [];

function track(handle: MatcherHandle): MatcherHandle {
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-overlay-matcher-"));
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
  resetQuarantineMemory();
  resetRecallGateOverlayCache();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("overlay matcher time box", () => {
  it("returns inside the budget on the counterexample and quarantines exactly that pattern", async () => {
    const matcher = track(persistentMatcher());
    // Warm the worker first: spawn is its own budget (G3), and the 50 ms cap is
    // stated against the execution window.
    await matcher.match({ text: "warm", patterns: FAST });

    // Proof the thread is not stuck: this interval must keep firing DURING the
    // match. A regex that pinned the main thread would starve it.
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks++; }, 5);
    const wall = Date.now();
    const hits = await matcher.match({ text: EVIL_INPUT, patterns: SLOW, surface: "test" });
    const elapsed = Date.now() - wall;
    clearInterval(heartbeat);

    expect(hits.timedOut).toBe(true);
    expect(hits.unavailable).toBe(false);
    expect(hits.quarantined).toEqual(["user.slow"]);
    expect(hits.elapsedMs).toBeLessThan(MATCH_WALL_MS * 2);
    // A real stall is tens of seconds; anything in this range proves termination.
    expect(elapsed).toBeLessThan(MATCH_WALL_MS * 4);
    expect(ticks).toBeGreaterThan(0);

    const quarantine = readQuarantine();
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]).toMatchObject({
      overlay: "recall-gate",
      pattern_id: "user.slow",
      source_sha8: patternSourceSha8(COUNTEREXAMPLE, ""),
      elapsed_ms: MATCH_WALL_MS,
      surface: "test",
    });
    expect(quarantine[0].input_chars).toBe(EVIL_INPUT.length);
  });

  it("drops a quarantined pattern from the next load's compile set", async () => {
    const overlayFile = path.join(root, "overlays", "recall-gate.json");
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    // A pattern the grammar accepts, so it reaches `patterns` on a clean load.
    const source = "배포\\s*이력";
    fs.writeFileSync(
      overlayFile,
      JSON.stringify({
        schema: "memex.recall-gate-overlay",
        version: 1,
        revision: 1,
        patterns: { add: [{ id: "user.keep", intent: "memory", source, flags: "i" }] },
      }),
    );
    resetRecallGateOverlayCache();
    expect(loadRecallGateOverlay().patterns.map((p) => p.id)).toEqual(["user.keep"]);

    fs.writeFileSync(
      path.join(root, "overlays", "quarantine.json"),
      JSON.stringify({
        schema: "memex.overlay-quarantine",
        version: 1,
        entries: [
          {
            overlay: "recall-gate",
            pattern_id: "user.keep",
            source_sha8: patternSourceSha8(source, "i"),
            at: new Date().toISOString(),
            elapsed_ms: 50,
            input_chars: 100,
            surface: "daemon",
          },
        ],
      }),
    );
    resetRecallGateOverlayCache();
    const reloaded = loadRecallGateOverlay();
    expect(reloaded.patterns).toEqual([]);
    expect(reloaded.quarantined.map((entry) => entry.pattern_id)).toEqual(["user.keep"]);
    expect(reloaded.issues.some((issue) => issue.code === "PATTERN_QUARANTINED")).toBe(true);
    // Fail-safe: the overlay as a whole is still "present and applied", the gate
    // keeps running, only this pattern is gone.
    expect(reloaded.present).toBe(true);
    expect(reloaded.hash).not.toBeNull();
  });

  it("builds no worker at all when there are no patterns", async () => {
    const matcher = persistentMatcher();
    handles.push(matcher);
    const hits = await matcher.match({ text: "anything", patterns: [] });
    expect(hits.unavailable).toBe(false);
    expect(hits.timedOut).toBe(false);
    expect(hits.matched).toEqual([]);
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(0);
    expect(readQuarantine()).toEqual([]);
  });

  it("reuses one resident worker across prompts and does not recompile", async () => {
    const matcher = track(persistentMatcher());
    const first = await matcher.match({ text: "배포 이력 좀 보여줘", patterns: FAST });
    const second = await matcher.match({ text: "배포   이력", patterns: FAST });
    const third = await matcher.match({ text: "nothing here", patterns: FAST });
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(1);
    expect(first.compiledPatterns).toBe(1);
    expect(second.compiledPatterns).toBe(0);
    expect(third.compiledPatterns).toBe(0);
    expect(first.intents.memory).toEqual(["user.fast"]);
    expect(second.intents.memory).toEqual(["user.fast"]);
    expect(third.matched).toEqual([]);
  });

  it("a one-shot matcher spawns its own worker and never respawns after a timeout", async () => {
    const matcher = track(oneShotMatcher());
    const timedOut = await matcher.match({ text: EVIL_INPUT, patterns: SLOW });
    expect(timedOut.timedOut).toBe(true);
    expect(matcher.state()).toBe("dead");
    const after = await matcher.match({ text: "배포 이력", patterns: FAST });
    expect(after.unavailable).toBe(true);
    expect(after.quarantined).toEqual([]);
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(1);
  });

  it("a persistent matcher respawns once the respawn window has passed", async () => {
    const matcher = track(persistentMatcher({ respawnMs: 40 }));
    await matcher.match({ text: EVIL_INPUT, patterns: SLOW });
    expect(matcher.state()).toBe("dead");
    // Inside the window: unavailable, and nothing new is quarantined.
    const blocked = await matcher.match({ text: "배포 이력", patterns: FAST });
    expect(blocked.unavailable).toBe(true);
    expect(blocked.quarantined).toEqual([]);
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const revived = await matcher.match({ text: "배포 이력", patterns: FAST });
    expect(revived.unavailable).toBe(false);
    expect(revived.intents.memory).toEqual(["user.fast"]);
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(2);
  });

  it("reports a worker that dies as unavailable, with no quarantine", async () => {
    const dying = fileURLToPath(new URL("./fixtures/overlay-matcher-dies.mjs", import.meta.url));
    const matcher = track(persistentMatcher({ entry: new URL(`file://${dying}`), respawnMs: 10_000 }));
    const hits = await matcher.match({ text: EVIL_INPUT, patterns: SLOW });
    expect(hits.unavailable).toBe(true);
    expect(hits.quarantined).toEqual([]);
    expect(readQuarantine()).toEqual([]);
  });

  it("never throws, whatever the worker entry is", async () => {
    const missing = new URL("file:///definitely/not/a/worker-entry.mjs");
    const matcher = track(persistentMatcher({ entry: missing, respawnMs: 10_000 }));
    await expect(matcher.match({ text: "x", patterns: FAST })).resolves.toMatchObject({
      unavailable: true,
      quarantined: [],
    });
    expect(readQuarantine()).toEqual([]);
  });

  it("falls back to an in-process exclusion when the quarantine file cannot be written", async () => {
    // A DIRECTORY where the file belongs: the atomic rename cannot land.
    fs.mkdirSync(path.join(root, "overlays", "quarantine.json"), { recursive: true });
    const matcher = track(oneShotMatcher());
    const hits = await matcher.match({ text: EVIL_INPUT, patterns: SLOW, surface: "test" });
    expect(hits.quarantined).toEqual(["user.slow"]);
    // Visibility degraded to this process, but the exclusion still holds.
    const entries = readQuarantine();
    expect(entries.map((entry) => entry.pattern_id)).toEqual(["user.slow"]);
  });

  it("keeps the quarantine key on (pattern_id, source_sha8) so an edit clears it", async () => {
    const matcher = track(oneShotMatcher());
    await matcher.match({ text: EVIL_INPUT, patterns: SLOW, surface: "test" });
    const entries = readQuarantine();
    expect(entries[0].source_sha8).toBe(patternSourceSha8(COUNTEREXAMPLE, ""));
    // Same id, different source: not the same quarantine row.
    expect(
      entries.some(
        (entry) =>
          entry.pattern_id === "user.slow" &&
          entry.source_sha8 === patternSourceSha8(`${COUNTEREXAMPLE}x`, ""),
      ),
    ).toBe(false);
  });
});
