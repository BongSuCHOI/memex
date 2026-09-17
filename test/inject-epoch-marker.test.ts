import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Issue #162 (R1'') — the ONE lifecycle transition a skipped hook cannot heal.
 *
 * A SessionStart(clear|compact) that gives up on a busy database leaves the
 * context epoch un-advanced. Residency from the OLD context then makes
 * inject-core suppress exactly the facts the clear/compact just dropped, so the
 * user gets an empty memory context for the rest of the session. The repair has
 * to happen on the shared inject entry — `computeInjectContext` serves BOTH the
 * warm daemon and the cold fallback in scripts/inject-context.js — and it has to
 * happen BEFORE anything reads the session's epoch or residency.
 */
const order = vi.hoisted(() => [] as string[]);
const applyPendingEpochAdvance = vi.hoisted(() =>
  vi.fn(() => {
    order.push("applyPendingEpochAdvance");
    return 1;
  }),
);
const ensureSessionMemoryState = vi.hoisted(() =>
  vi.fn(() => {
    order.push("ensureSessionMemoryState");
    return {
      projectId: "project-epoch",
      workspaceId: "workspace-epoch",
      workstreamId: "workstream-epoch",
      contextEpoch: 1,
    };
  }),
);

vi.mock("../src/search.js", () => ({ getSearchDb: () => ({}) }));
vi.mock("../src/db.js", () => ({
  l2DistanceToSimilarity: () => 1,
  recordRecallEvent: vi.fn(() => "receipt-1"),
}));
vi.mock("../src/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  queryBaseline: vi.fn().mockResolvedValue(0),
  embeddingCallStats: () => ({ modelCalls: 0, cacheHits: 0 }),
}));
vi.mock("../src/fact-db.js", () => ({ searchFactsInScope: () => [] }));
vi.mock("../src/ontology-db.js", () => ({ getRelatedFactsInScope: () => [] }));
vi.mock("../src/repeat-detector.js", () => ({
  detectRepeat: vi.fn().mockResolvedValue([]),
  formatRepeatContext: () => "",
}));
vi.mock("../src/inject-log.js", () => ({ appendInjectLog: vi.fn() }));
vi.mock("../src/continuity-core.js", () => ({
  applyPendingEpochAdvance,
  ensureSessionMemoryState,
  readResidentFactRevisions: () => ({ contextEpoch: 1, resident: [], carry: [] }),
  readResidentRevisionCorrections: () => [],
  recordResidentFactRevisions: vi.fn(() => true),
  readWorkCapsule: () => null,
}));
vi.mock("../src/chronicle.js", () => ({
  matchIncidentPatterns: () => [],
  readChronicleTimeline: () => ({ events: [], nextCursor: null, limit: 1 }),
  recordTelemetrySample: () => "sample",
}));
vi.mock("../src/continuity-identity.js", () => ({
  projectRevision: () => 0,
  sessionProjectRevisionState: () => ({ projectId: "project-epoch", current: 0, seen: 0 }),
  markSessionProjectRevisionSeen: vi.fn(() => true),
  readHotEvidence: () => [],
}));

import { computeInjectContext } from "../src/inject-core.js";

let tmp: string;

beforeEach(() => {
  order.length = 0;
  applyPendingEpochAdvance.mockClear();
  ensureSessionMemoryState.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-inject-epoch-"));
  process.env.MEMEX_HOME = tmp;
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("inject replays a skipped clear/compact epoch advance", () => {
  it("applies the pending advance before it reads the session's epoch state", async () => {
    await computeInjectContext("무엇을 결정했지?", "/project", "daemon", "session-epoch-1");
    // #162 review 8: the repair also reports the lock wait it paid, because it
    // swallows SQLITE_BUSY and would otherwise swallow the wait with it.
    expect(applyPendingEpochAdvance).toHaveBeenCalledWith(
      expect.anything(),
      "session-epoch-1",
      expect.objectContaining({ onDbWaitMs: expect.any(Function) }),
    );
    expect(order[0]).toBe("applyPendingEpochAdvance");
    expect(order.indexOf("applyPendingEpochAdvance")).toBeLessThan(
      order.indexOf("ensureSessionMemoryState"),
    );
  });

  it("never runs without session provenance (no session, no replay)", async () => {
    await computeInjectContext("무엇을 결정했지?", "/project", "daemon", undefined);
    expect(applyPendingEpochAdvance).not.toHaveBeenCalled();
  });
});
