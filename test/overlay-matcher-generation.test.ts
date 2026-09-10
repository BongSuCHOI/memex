/**
 * G3 — request serialization and generation-checked attribution.
 *
 * The bug this suite guards against: the inject daemon serves requests
 * CONCURRENTLY (`net.createServer((conn) => …)`), and the v3 design had the
 * matcher write one shared progress index. Request A running while request B
 * timed out let B read A's index, quarantine A's pattern, and terminate the
 * worker both were using. Quarantine is the operator's rule being silently
 * switched off, so attributing one to the wrong pattern is a real harm.
 *
 * The fix under test: one request at a time per worker, a monotonic generation
 * per request, a two-slot (generation, index) progress area, and quarantine ONLY
 * when both slots describe the request that is timing out. `-1` never qualifies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MATCH_WALL_MS,
  persistentMatcher,
  readQuarantine,
  resetQuarantineMemory,
  type MatcherHandle,
} from "../src/overlay-matcher.js";
import { resetRecallGateOverlayCache } from "../src/recall-gate-overlay.js";

const WEDGED = new URL("./fixtures/overlay-matcher-wedged.mjs", import.meta.url);
const SLOW_A = [{ id: "user.a", intent: "memory" as const, source: "^a+b?a+b?a+b?a+$", flags: "" }];
const SLOW_B = [{ id: "user.b", intent: "trace" as const, source: "^b+a?b+a?b+a?b+$", flags: "" }];
const FAST = [{ id: "user.fast", intent: "memory" as const, source: "배포", flags: "i" }];

let root: string;
let env: Record<string, string | undefined>;
const handles: MatcherHandle[] = [];

function track(handle: MatcherHandle): MatcherHandle {
  handles.push(handle);
  return handle;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-matcher-generation-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
    MEMEX_TEST_MATCHER_MODE: process.env.MEMEX_TEST_MATCHER_MODE,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
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

describe("matcher request serialization and generation", () => {
  it("serializes overlapping requests instead of interleaving them", async () => {
    const matcher = track(persistentMatcher());
    const order: string[] = [];
    const first = matcher
      .match({ text: "배포 이력", patterns: FAST })
      .then(() => order.push("first"));
    const second = matcher
      .match({ text: "배포 계획", patterns: FAST })
      .then(() => order.push("second"));
    const third = matcher
      .match({ text: "무관한 문장", patterns: FAST })
      .then(() => order.push("third"));
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first", "second", "third"]);
    // One worker served all three.
    expect((matcher as unknown as { spawnCount: number }).spawnCount).toBe(1);
  });

  it("a queued request drained by a terminate quarantines nothing of its own", async () => {
    process.env.MEMEX_TEST_MATCHER_MODE = "attributable";
    const matcher = track(persistentMatcher({ entry: WEDGED, respawnMs: 10_000 }));
    // A wedges the worker and is attributable; B is still queued when the
    // terminate happens and must come back `unavailable`.
    const [a, b] = await Promise.all([
      matcher.match({ text: "aaaa", patterns: SLOW_A, surface: "test" }),
      matcher.match({ text: "bbbb", patterns: SLOW_B, surface: "test" }),
    ]);
    expect(a.timedOut).toBe(true);
    expect(a.quarantined).toEqual(["user.a"]);
    expect(b.unavailable).toBe(true);
    expect(b.quarantined).toEqual([]);
    // Crucially: B's pattern is NOT in the quarantine file.
    const ids = readQuarantine().map((entry) => entry.pattern_id);
    expect(ids).toEqual(["user.a"]);
    expect(ids).not.toContain("user.b");
  });

  it("index -1 is never grounds for quarantine (still compiling, or reply in flight)", async () => {
    process.env.MEMEX_TEST_MATCHER_MODE = "no-index";
    const matcher = track(persistentMatcher({ entry: WEDGED, respawnMs: 10_000 }));
    const hits = await matcher.match({ text: "aaaa", patterns: SLOW_A, surface: "test" });
    expect(hits.timedOut).toBe(true);
    expect(hits.unavailable).toBe(true);
    expect(hits.quarantined).toEqual([]);
    expect(readQuarantine()).toEqual([]);
  });

  it("a generation mismatch is never grounds for quarantine", async () => {
    process.env.MEMEX_TEST_MATCHER_MODE = "stale-generation";
    const matcher = track(persistentMatcher({ entry: WEDGED, respawnMs: 10_000 }));
    const hits = await matcher.match({ text: "aaaa", patterns: SLOW_A, surface: "test" });
    expect(hits.timedOut).toBe(true);
    // Nothing can be attributed, so this reads as `overlay_unavailable`, not as a
    // pattern that misbehaved.
    expect(hits.unavailable).toBe(true);
    expect(hits.quarantined).toEqual([]);
    expect(readQuarantine()).toEqual([]);
  });

  it("quarantines only when BOTH the generation and the index match the timing-out request", async () => {
    process.env.MEMEX_TEST_MATCHER_MODE = "attributable";
    const matcher = track(persistentMatcher({ entry: WEDGED, respawnMs: 10_000 }));
    const hits = await matcher.match({
      text: "aaaa",
      patterns: [...SLOW_A, ...SLOW_B],
      surface: "test",
    });
    expect(hits.timedOut).toBe(true);
    expect(hits.unavailable).toBe(false);
    // The double stamps index 0 — the FIRST pattern — and only that one is named.
    expect(hits.quarantined).toEqual(["user.a"]);
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual(["user.a"]);
  });

  it("the 50 ms cap does not include queue wait", async () => {
    const matcher = track(persistentMatcher());
    // Warm first so worker startup is not in any measured window either.
    await matcher.match({ text: "warm", patterns: FAST });
    const slow = [{ id: "user.slow", intent: "memory" as const, source: "^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$", flags: "" }];
    const evil = "a".repeat(80) + "!";
    const [first, second] = await Promise.all([
      matcher.match({ text: evil, patterns: slow, surface: "test" }),
      // Queued behind a request that will burn the whole budget. Its own window
      // must not be charged for that wait — it is drained as `unavailable`
      // because the worker was terminated, not because IT was slow.
      matcher.match({ text: "배포 이력", patterns: FAST, surface: "test" }),
    ]);
    expect(first.timedOut).toBe(true);
    expect(first.elapsedMs).toBeLessThan(MATCH_WALL_MS * 2);
    expect(second.unavailable).toBe(true);
    expect(second.quarantined).toEqual([]);
    // The queued request waited in wall-clock terms but was charged nothing.
    expect(second.elapsedMs).toBeLessThan(MATCH_WALL_MS);
  });
});
