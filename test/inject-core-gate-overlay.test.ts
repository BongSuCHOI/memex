/**
 * The overlay on the injection fast path.
 *
 * The first test is the important one: with NO overlay file, the `gate` label and
 * the inject log line must be byte-identical to 0.6.9. Every installation that
 * never touches an overlay is in that state, and a suffix or a stray field
 * leaking into their telemetry would be a silent regression in the most-used
 * path in the system.
 *
 * The rest pins the degradation being VISIBLE — `+overlay_timeout`,
 * `+overlay_unavailable`, `gate_overlay_worker` — because a quarantined pattern
 * is the operator's own rule switched off, and the one thing that must never
 * happen is for that to be quiet.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { computeInjectContext } from "../src/inject-core.js";
import { stubEmbedding } from "../src/embeddings.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { sessionProjectRevisionState } from "../src/continuity-identity.js";
import { getInjectLogPath, type InjectLogEntry } from "../src/inject-log.js";
import { resetRecallGateOverlayCache } from "../src/recall-gate-overlay.js";
import {
  EMPTY_USER_PATTERN_HITS,
  resetQuarantineMemory,
  type MatcherHandle,
  type UserPatternHits,
} from "../src/overlay-matcher.js";

let root: string;
let db: Database.Database;
const cwd = "/project/gate-overlay";
const SESSION = "gate-overlay-session";

function overlayFile(): string {
  return path.join(root, "overlays", "recall-gate.json");
}

function writeOverlay(value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(overlayFile()), { recursive: true });
  fs.writeFileSync(
    overlayFile(),
    JSON.stringify({ schema: "memex.recall-gate-overlay", version: 1, revision: 1, ...value }, null, 2),
  );
  resetRecallGateOverlayCache();
}

function logLines(): InjectLogEntry[] {
  try {
    return fs
      .readFileSync(getInjectLogPath(), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as InjectLogEntry);
  } catch {
    return [];
  }
}

function lastLine(): InjectLogEntry {
  const lines = logLines();
  return lines[lines.length - 1];
}

/** A matcher double: no worker, an exact scripted answer. */
function fakeMatcher(hits: Partial<UserPatternHits>): MatcherHandle & { calls: number } {
  const handle = {
    calls: 0,
    match: async () => {
      handle.calls++;
      return { ...EMPTY_USER_PATTERN_HITS, intents: {}, matched: [], quarantined: [], ...hits };
    },
    dispose: () => {},
    state: () => "ready" as const,
  };
  return handle;
}

/**
 * Spend the epoch's first retrieval.
 *
 * The first substantive prompt of a session also fires
 * `first_substantive_in_epoch`, which would make every exact label assertion
 * below about epoch bookkeeping rather than about the overlay.
 */
async function warm(): Promise<void> {
  await computeInjectContext("start the release log work", cwd, "daemon", SESSION);
}

function seed(): void {
  ensureSessionMemoryState(db, { sessionId: SESSION, project: cwd, prompt: "start" });
  insertFact(db, {
    fact: "The deployment history lives in the release log",
    category: "decision",
    scope_type: "project",
    scope_project: cwd,
    source_exchange_ids: [],
    embedding: stubEmbedding("deployment history"),
  });
  db.prepare(
    `UPDATE session_memory_state SET memory_revision_seen =
       (SELECT memory_revision FROM projects WHERE project_id = session_memory_state.project_id)
     WHERE session_id = ?`,
  ).run(SESSION);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-inject-overlay-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
  db = initDatabase();
  seed();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.MEMEX_OVERLAY_DIR;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  fs.rmSync(root, { recursive: true, force: true });
  resetRecallGateOverlayCache();
  resetQuarantineMemory();
});

describe("no overlay: byte-identical to v0.6.9", () => {
  it("leaves the gate label and the log line exactly as they were", async () => {
    await warm();
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION);
    const line = lastLine();
    // No `@gate:…`, no `+overlay_*`. The label is the 0.6.9 string.
    expect(line.gate).toBe("retrieve:explicit_memory_intent");
    expect(line.gate).not.toMatch(/overlay/);
    // The two new fields are ABSENT, not null — an absent key keeps the JSONL
    // byte-identical for every installation without an overlay.
    expect("gate_overlay" in line).toBe(false);
    expect("gate_overlay_worker" in line).toBe(false);
  });

  it("leaves a skip label alone too", async () => {
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION);
    await computeInjectContext("thanks", cwd, "daemon", SESSION);
    const line = lastLine();
    expect(line.status).toBe("skipped");
    expect(line.gate).toBe("skip:acknowledgement");
    expect("gate_overlay" in line).toBe(false);
  });

  it("records a NULL gate_overlay_hash on the recall receipt", async () => {
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION);
    const row = db
      .prepare("SELECT gate_overlay_hash FROM recall_events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(SESSION) as { gate_overlay_hash: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.gate_overlay_hash).toBeNull();
  });

  it("never asks the matcher for anything", async () => {
    const matcher = fakeMatcher({});
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, { matcher });
    expect(matcher.calls).toBe(0);
  });
});

describe("an applied overlay", () => {
  it("stamps the hash on the label and the log line", async () => {
    await warm();
    writeOverlay({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const matcher = fakeMatcher({ intents: { memory: ["user.deploy"] }, matched: ["user.deploy"] });
    await computeInjectContext("배포 이력 좀 보여줘", cwd, "daemon", SESSION, { matcher });
    expect(matcher.calls).toBe(1);
    const line = lastLine();
    expect(line.gate).toMatch(/^retrieve:explicit_memory_intent@gate:[0-9a-f]{8}$/);
    expect(line.gate_overlay).toMatch(/^gate:[0-9a-f]{8}$/);
    expect(line.gate_overlay_worker).toBe("ok");
  });

  it("stamps the hash on the recall receipt it writes", async () => {
    // NOT warmed, and the prompt is the one known to retrieve this seed fact: a
    // later prompt finds it already resident and dedupes, which writes no receipt
    // at all. The hash is stamped on whatever receipt the run does commit.
    writeOverlay({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const matcher = fakeMatcher({ intents: {}, matched: [] });
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, { matcher });
    const row = db
      .prepare("SELECT gate_overlay_hash FROM recall_events WHERE session_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(SESSION) as { gate_overlay_hash: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.gate_overlay_hash).toMatch(/^gate:[0-9a-f]{8}$/);
    expect(row!.gate_overlay_hash).toBe(lastLine().gate_overlay);
  });

  it("a user pattern changes the gate verdict", async () => {
    // Without the overlay this prompt carries no memory intent.
    await computeInjectContext("배포 이력 좀 보여줘", cwd, "daemon", SESSION);
    expect(lastLine().gate).not.toMatch(/explicit_memory_intent/);

    writeOverlay({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const matcher = fakeMatcher({ intents: { memory: ["user.deploy"] }, matched: ["user.deploy"] });
    await computeInjectContext("배포 이력이 어떻게 됐지", cwd, "daemon", SESSION, { matcher });
    expect(lastLine().gate).toMatch(/explicit_memory_intent/);
  });

  it("marks an execution timeout as +overlay_timeout", async () => {
    await warm();
    writeOverlay({ patterns: { add: [{ id: "user.slow", intent: "memory", source: "^a+b?a+b?a+$", flags: "" }] } });
    const matcher = fakeMatcher({ timedOut: true, quarantined: ["user.slow"], elapsedMs: 50 });
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, { matcher });
    const line = lastLine();
    expect(line.gate).toContain("+overlay_timeout");
    expect(line.gate).not.toContain("+overlay_unavailable");
    expect(line.gate_overlay_worker).toBe("timeout");
    // The prompt was still served on the built-ins — fail-safe.
    expect(line.status).not.toBe("error");
    expect(line.gate).toMatch(/^retrieve:explicit_memory_intent\+overlay_timeout@gate:/);
  });

  it("marks a queue/startup timeout or a dead worker as +overlay_unavailable", async () => {
    writeOverlay({ patterns: { add: [{ id: "user.x", intent: "memory", source: "배포", flags: "i" }] } });
    // Both flags set is exactly the queue/startup case: it DID time out and
    // nothing ran, and the design's cost table says it reads `unavailable`.
    const matcher = fakeMatcher({ timedOut: true, unavailable: true });
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, { matcher });
    const line = lastLine();
    expect(line.gate).toContain("+overlay_unavailable");
    expect(line.gate).not.toContain("+overlay_timeout");
    expect(line.gate_overlay_worker).toBe("unavailable");
  });

  it("serves the prompt on the built-ins when the worker is simply gone", async () => {
    writeOverlay({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    const matcher = fakeMatcher({ unavailable: true });
    const context = await computeInjectContext(
      "Why did we move the deployment history?",
      cwd,
      "daemon",
      SESSION,
      { matcher },
    );
    // The built-in `why` still fires, so the bundle is produced as usual.
    expect(context).toContain("[CURRENT TRUTH]");
    expect(lastLine().gate_overlay_worker).toBe("unavailable");
  });

  it("carries the suffix on the skip path too", async () => {
    writeOverlay({ patterns: { add: [{ id: "user.x", intent: "memory", source: "배포", flags: "i" }] } });
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, {
      matcher: fakeMatcher({}),
    });
    const matcher = fakeMatcher({ timedOut: true, quarantined: ["user.x"] });
    await computeInjectContext("thanks", cwd, "daemon", SESSION, { matcher });
    const line = lastLine();
    expect(line.status).toBe("skipped");
    expect(line.gate).toMatch(/^skip:acknowledgement\+overlay_timeout@gate:/);
  });

  it("a broken overlay file keeps the prompt working and leaves the hash off", async () => {
    await warm();
    fs.mkdirSync(path.dirname(overlayFile()), { recursive: true });
    fs.writeFileSync(overlayFile(), "{ not json");
    resetRecallGateOverlayCache();
    const matcher = fakeMatcher({});
    const context = await computeInjectContext(
      "Why did we move the deployment history?",
      cwd,
      "daemon",
      SESSION,
      { matcher },
    );
    expect(typeof context).toBe("string");
    expect(matcher.calls).toBe(0); // nothing to run
    const line = lastLine();
    // Served normally, not failed: that is what fail-safe means here.
    expect(line.status).not.toBe("error");
    // No hash: nothing was applied. The doctor check is where this is reported.
    expect(line.gate).toBe("retrieve:explicit_memory_intent");
    expect("gate_overlay" in line).toBe(false);
  });

  it("disabling a built-in actually changes the gate", async () => {
    await warm();
    // "Why the change?" reaches memory/trace through \bwhy\b alone. The longer
    // prompt also matches \bhistory\b, which would mask the disable.
    writeOverlay({ patterns: { disable: ["memory.en.why", "trace.en.why"] } });
    await computeInjectContext("Why the change?", cwd, "daemon", SESSION);
    const line = lastLine();
    expect(line.gate).not.toMatch(/explicit_memory_intent/);
    // The overlay is applied, so the hash IS stamped even with no user pattern.
    expect(line.gate).toMatch(/@gate:[0-9a-f]{8}$/);
    // No pattern to run, so no worker verdict to report.
    expect("gate_overlay_worker" in line).toBe(false);
  });

  it("MEMEX_DISABLE_OVERLAYS=1 restores the 0.6.9 label even with a file present", async () => {
    await warm();
    writeOverlay({ patterns: { add: [{ id: "user.deploy", intent: "memory", source: "배포\\s*이력", flags: "i" }] } });
    process.env.MEMEX_DISABLE_OVERLAYS = "1";
    resetRecallGateOverlayCache();
    const matcher = fakeMatcher({ intents: { memory: ["user.deploy"] } });
    await computeInjectContext("Why did we move the deployment history?", cwd, "daemon", SESSION, { matcher });
    expect(matcher.calls).toBe(0);
    expect(lastLine().gate).toBe("retrieve:explicit_memory_intent");
  });
});

describe("gate thresholds travel with the overlay (#120)", () => {
  it("an overlay `config` block reaches the gate and moves the overlay hash", async () => {
    // #120 reversed the 0.7.0 boundary: a `config` block is APPLIED, not ignored.
    // What stays true is the fail-safe direction — an overlay with no `config` is
    // byte-identical to 0.7.0, thresholds included.
    await warm();
    const patterns = { add: [{ id: "user.x", intent: "memory", source: "배포", flags: "i" }] };
    writeOverlay({ patterns });
    const withoutConfig = await computeInjectContext(
      "configure the release log rotation archive",
      cwd,
      "daemon",
      SESSION,
      { matcher: fakeMatcher({}) },
    );
    const baselineLabel = lastLine().gate;
    const gate = await import("../src/recall-gate-overlay.js");
    const baselineHash = gate.loadRecallGateOverlay().hash;
    expect(gate.loadRecallGateOverlay().config).toEqual({});

    writeOverlay({ patterns, config: { substantiveMinTokens: 99, driftJaccard: 0.99 } });
    // No warning any more: `config` is a known field, and its values are applied.
    expect(gate.loadRecallGateOverlay().issues.map((issue) => issue.code)).not.toContain("OVERLAY_UNKNOWN_FIELD");
    expect(gate.loadRecallGateOverlay().config).toEqual({ substantiveMinTokens: 99, driftJaccard: 0.99 });
    // Thresholds ARE rules, so the fingerprint the receipt carries moves with them.
    expect(gate.loadRecallGateOverlay().hash).not.toBe(baselineHash);
    const withConfig = await computeInjectContext(
      "configure the release log rotation archive",
      cwd,
      "daemon",
      SESSION,
      { matcher: fakeMatcher({}) },
    );
    // The label still names a gate verdict and carries the (new) overlay hash.
    expect(lastLine().gate).toMatch(/@gate:[0-9a-f]{8}/);
    expect(baselineLabel).toMatch(/@gate:[0-9a-f]{8}/);
    expect(typeof withoutConfig).toBe("string");
    expect(typeof withConfig).toBe("string");
  });

  it("an out-of-range threshold falls back to the BUILT-IN numbers, not half of them", async () => {
    await warm();
    writeOverlay({
      patterns: { add: [{ id: "user.x", intent: "memory", source: "배포", flags: "i" }] },
      config: { substantiveMinTokens: 5, driftJaccard: 9 },
    });
    const gate = await import("../src/recall-gate-overlay.js");
    const loaded = gate.loadRecallGateOverlay();
    expect(loaded.issues.some((issue) => issue.code === "CONFIG_VALUE_INVALID")).toBe(true);
    expect(loaded.config).toEqual({});
    expect(loaded.patterns).toHaveLength(0);
  });

  it("options.gateConfig reaches the gate unchanged alongside the overlay's hits", async () => {
    const { decideRecall, type: _unused } = await import("../src/recall-gate.js").then((m) => ({
      decideRecall: m.decideRecall, type: null,
    }));
    void _unused;
    const state = {
      contextEpoch: 1, lastRetrievalEpoch: 1, lastSource: null, capsuleGenerationSeen: 0,
      memoryRevisionSeen: 0, topicFingerprint: ["redis", "store"], hasTopicEmbedding: true,
      informativePromptsSinceRetrieval: 0, residentTokens: new Set(["redis"]),
    };
    const base = {
      prompt: "배포 이력", state, currentCapsuleGeneration: 0, currentProjectRevision: 0,
      incidentMatched: false,
    };
    // The threshold still decides `substantive`...
    expect(decideRecall({ ...base, config: { substantiveMinTokens: 1 } }).substantive).toBe(true);
    expect(decideRecall({ ...base, config: { substantiveMinTokens: 99 } }).substantive).toBe(false);
    // ...and the overlay's hits still decide the intent, independently.
    expect(decideRecall({ ...base, userHits: { intents: { memory: ["user.x"] } } }).intents.memory).toBe(true);
    expect(decideRecall({ ...base }).intents.memory).toBe(false);
    // Both together: neither path swallows the other.
    const both = decideRecall({
      ...base,
      config: { substantiveMinTokens: 99 },
      userHits: { intents: { memory: ["user.x"] } },
    });
    expect(both.intents.memory).toBe(true);
    // `memory` makes a prompt substantive whatever the token threshold says —
    // 0.6.9 behaviour, unchanged.
    expect(both.substantive).toBe(true);
    expect(both.triggers).toContain("explicit_memory_intent");
  });
});
