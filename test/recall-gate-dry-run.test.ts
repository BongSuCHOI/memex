/**
 * `explainRecall()` — the engine behind `memex gate test` and the Web UI's `test`
 * action.
 *
 * Two properties matter more than the output shape:
 *
 *  1. It writes NOTHING. No skipped-prompt counter, no recall receipt, no inject
 *     log, no telemetry. An operator has to be able to try a regex against a real
 *     prompt without that attempt becoming session state. The one exception is the
 *     quarantine file, and it is deliberate: user patterns go through the REAL
 *     matcher, so a pattern that blows its budget here is quarantined exactly as
 *     it would be in production.
 *  2. User patterns really do go through the matcher worker, so what `gate test`
 *     reports is what the daemon will do — not a second, kinder implementation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  explainRecall,
  neutralGateState,
  resetRecallGateOverlayCache,
} from "../src/recall-gate-overlay.js";
import {
  oneShotMatcher,
  readQuarantine,
  resetQuarantineMemory,
  type MatcherHandle,
} from "../src/overlay-matcher.js";

let root: string;
let overlayFile: string;
let env: Record<string, string | undefined>;
const handles: MatcherHandle[] = [];

function track(handle: MatcherHandle): MatcherHandle {
  handles.push(handle);
  return handle;
}

function write(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
  fs.writeFileSync(
    overlayFile,
    JSON.stringify({ schema: "memex.recall-gate-overlay", version: 1, revision: 1, ...value }, null, 2),
  );
  resetRecallGateOverlayCache();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-gate-dry-run-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  overlayFile = path.join(root, "overlays", "recall-gate.json");
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
  vi.restoreAllMocks();
});

describe("explainRecall", () => {
  it("names the built-in terms that fired and the decision they produced", async () => {
    const explained = await explainRecall({ prompt: "왜 auth를 supabase로 바꿨지?" }, track(oneShotMatcher()));
    expect(explained.overlay).toEqual({ present: false, hash: null, revision: 0 });
    expect(explained.stateSource).toBe("neutral");
    expect(explained.intents.memory.fired).toBe(true);
    expect(explained.intents.memory.matched.map((m) => m.id)).toContain("memory.kr.왜");
    expect(explained.intents.memory.matched.every((m) => m.origin === "builtin")).toBe(true);
    // Every matched entry carries its regex source, which is what the CLI prints.
    expect(explained.intents.memory.matched.every((m) => m.source.length > 0)).toBe(true);
    expect(explained.decision.action).toBe("retrieve");
    expect(explained.decision.triggers).toContain("explicit_memory_intent");
    expect(explained.prompt.chars).toBe("왜 auth를 supabase로 바꿨지?".length);
    expect(explained.prompt.tokens.length).toBeGreaterThan(0);
  });

  it("attributes a user pattern's hit to the overlay and runs it through the matcher", async () => {
    write({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const matcher = track(oneShotMatcher());
    const spy = vi.spyOn(matcher, "match");
    const explained = await explainRecall({ prompt: "배포 이력 좀 보여줘" }, matcher);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].patterns.map((pattern) => pattern.id)).toEqual(["user.deploy"]);
    expect(explained.overlay.present).toBe(true);
    expect(explained.overlay.hash).toMatch(/^gate:[0-9a-f]{8}$/);
    expect(explained.intents.memory.matched).toEqual([
      { id: "user.deploy", source: "배포\\s*이력", origin: "user" },
    ]);
    expect(explained.decision.action).toBe("retrieve");
    expect(explained.matcher).toMatchObject({ timedOut: false, unavailable: false, quarantined: [] });
  });

  it("never touches the matcher when there is no overlay pattern", async () => {
    const matcher = track(oneShotMatcher());
    const spy = vi.spyOn(matcher, "match");
    await explainRecall({ prompt: "왜 그랬어" }, matcher);
    expect(spy).not.toHaveBeenCalled();
  });

  it("--compare-builtin diffs the two runs and names the rule that made the difference", async () => {
    write({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const explained = await explainRecall(
      { prompt: "배포 이력 좀 보여줘", compareBuiltin: true },
      track(oneShotMatcher()),
    );
    expect(explained.builtinOnly).toBeDefined();
    expect(explained.builtinOnly!.intents.memory).toBe(false);
    expect(explained.decision.intents.memory).toBe(true);
    // Without the overlay this prompt has no memory intent, so the gate defers to
    // one embedding; with it, retrieval is decided lexically and costs none.
    expect(explained.builtinOnly!.action).not.toBe("retrieve");
    expect(explained.decision.action).toBe("retrieve");
    expect(explained.diffCause).toEqual([
      { id: "user.deploy", source: "배포\\s*이력", intent: "memory" },
    ]);
  });

  it("reports a disabled built-in as a difference in the other direction", async () => {
    write({ patterns: { disable: ["memory.kr.왜"] } });
    const explained = await explainRecall(
      { prompt: "왜 그랬어", compareBuiltin: true },
      track(oneShotMatcher()),
    );
    expect(explained.intents.memory.matched.map((m) => m.id)).not.toContain("memory.kr.왜");
    expect(explained.builtinOnly!.intents.memory).toBe(true);
    expect(explained.decision.intents.memory).toBe(false);
    // Nothing was ADDED, so there is no diffCause — the cause is a removal, which
    // the intents table already shows.
    expect(explained.diffCause).toEqual([]);
  });

  it("accepts a real session state and says so", async () => {
    const state = { ...neutralGateState(), topicFingerprint: ["auth", "supabase"], contextEpoch: 3, lastRetrievalEpoch: 3 };
    const explained = await explainRecall({ prompt: "auth supabase 관련 설정", state }, track(oneShotMatcher()));
    expect(explained.stateSource).toBe("session");
    expect(explained.decision.topicOverlap).not.toBeNull();
  });

  it("writes nothing: no overlay file, no logs, no db", async () => {
    const before = fs.readdirSync(root);
    await explainRecall({ prompt: "왜 auth를 supabase로 바꿨지?" }, track(oneShotMatcher()));
    expect(fs.readdirSync(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, "logs"))).toBe(false);
    expect(fs.existsSync(path.join(root, "overlays"))).toBe(false);
    expect(fs.existsSync(path.join(root, "conversation-index"))).toBe(false);
  });

  it("quarantines a budget-burning pattern exactly as production would", async () => {
    // This is the ONE thing a dry run does record: `gate test` must reflect real
    // behaviour, and pretending a slow pattern is fine would be the wrong kindness.
    //
    // The pattern is the SEVEN-quantifier member of the counterexample family,
    // because this one arrives through the FILE: the nine-quantifier form is
    // refused by the load-path grammar check and would never reach the matcher.
    // That is the two layers working as designed — the grammar catches the obvious
    // case early, the time box catches the one that slips through.
    write({
      patterns: { add: [{ id: "user.slow", intent: "memory", source: "^a+b?a+b?a+$", flags: "" }] },
    });
    const explained = await explainRecall(
      { prompt: "a".repeat(2000) + "!" },
      track(oneShotMatcher()),
    );
    expect(explained.matcher.timedOut).toBe(true);
    expect(explained.matcher.quarantined).toEqual(["user.slow"]);
    expect(readQuarantine().map((entry) => entry.pattern_id)).toEqual(["user.slow"]);
    // The verdict still comes back: the prompt is judged on the built-ins.
    expect(explained.decision.action).toBeDefined();
    expect(explained.intents.memory.matched).toEqual([]);
  });
});
