import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const recordRecallEvent = vi.hoisted(() => vi.fn());
const recordResidentFactRevisions = vi.hoisted(() => vi.fn(() => true));
const residentCorrections = vi.hoisted(() => vi.fn(() => [] as Array<Record<string, unknown>>));
const residency = vi.hoisted(() => ({ resident: [] as Array<[string, number, number]> }));
const revisionState = vi.hoisted(() => ({ current: 0, seen: 0 }));
const markSessionProjectRevisionSeen = vi.hoisted(() => vi.fn(() => true));
const factResults = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
const hotEvidence = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));

vi.mock("../src/search.js", () => ({
  getSearchDb: () => ({}),
}));
vi.mock("../src/db.js", () => ({
  l2DistanceToSimilarity: () => 1,
  recordRecallEvent,
}));
vi.mock("../src/embeddings.js", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  queryBaseline: vi.fn().mockResolvedValue(0),
  embeddingCallStats: () => ({ modelCalls: 0, cacheHits: 0 }),
}));
vi.mock("../src/fact-db.js", () => ({
  searchFactsByScope: () => factResults.value,
}));
vi.mock("../src/ontology-db.js", () => ({
  getRelatedFacts: () => [],
}));
vi.mock("../src/repeat-detector.js", () => ({
  detectRepeat: vi.fn().mockResolvedValue([]),
  formatRepeatContext: () => "",
}));
vi.mock("../src/inject-log.js", () => ({
  appendInjectLog: vi.fn(),
}));
vi.mock("../src/continuity-core.js", () => ({
  ensureSessionMemoryState: vi.fn(() => ({
    projectId: "project-ordering",
    workspaceId: "workspace-ordering",
    workstreamId: "workstream-ordering",
    contextEpoch: 0,
  })),
  readResidentFactRevisions: () => ({ contextEpoch: 0, resident: residency.resident, carry: [] }),
  readResidentRevisionCorrections: residentCorrections,
  recordResidentFactRevisions,
  readWorkCapsule: () => null,
}));
vi.mock("../src/chronicle.js", () => ({
  matchIncidentPatterns: () => [],
  readChronicleTimeline: () => ({ events: [], nextCursor: null, limit: 1 }),
  recordTelemetrySample: () => "sample",
}));
vi.mock("../src/continuity-identity.js", () => ({
  projectRevision: () => 0,
  sessionProjectRevisionState: () => ({ projectId: "project-ordering", ...revisionState }),
  markSessionProjectRevisionSeen,
  readHotEvidence: () => hotEvidence.value,
}));

import { computeInjectContext } from "../src/inject-core.js";

describe("injection write ordering", () => {
  let tmpDir: string;
  const previousHome = process.env.MEMEX_HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-inject-order-"));
    process.env.MEMEX_HOME = tmpDir;
    recordRecallEvent.mockReset();
    recordResidentFactRevisions.mockClear();
    residentCorrections.mockReset();
    residentCorrections.mockReturnValue([]);
    residency.resident = [];
    revisionState.current = 0;
    revisionState.seen = 0;
    markSessionProjectRevisionSeen.mockClear();
    factResults.value = [{
      fact: {
        id: "fact-prepared-gate",
        fact: "Prepared recall receipt must precede the dedup ledger write.",
        category: "decision",
        scope_type: "project",
        scope_project: "/project",
        source_exchange_ids: [],
        embedding: null,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        consolidated_count: 1,
        is_active: true,
      },
      distance: 0,
    }];
    hotEvidence.value = [];
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.MEMEX_HOME;
    else process.env.MEMEX_HOME = previousHome;
  });

  it("does not return context or contaminate the ledger when prepared receipt storage fails", async () => {
    recordRecallEvent.mockImplementation(() => {
      throw new Error("injected receipt failure");
    });

    const context = await computeInjectContext(
      "Recall the injection ordering decision for this project.",
      "/project",
      "daemon",
      "session-ordering-test",
    );

    expect(context).toBe("");
    expect(recordRecallEvent).toHaveBeenCalledOnce();
    expect(recordResidentFactRevisions).not.toHaveBeenCalled();
  });

  it("emits a stale-resident correction before a semantically matching fact result and acknowledges the project revision in the same commit", async () => {
    revisionState.current = 3;
    revisionState.seen = 2;
    residency.resident = [["fact-correction", 1, 1]];
    residentCorrections.mockReturnValue([{
      id: "fact-correction", fact: "Main now uses PostgreSQL", category: "decision",
      semantic_generation: 2, lifecycle_generation: 1, is_active: 1, previous_fact: "Main uses MySQL",
    }]);
    recordRecallEvent.mockReturnValue("recall-correction");

    const context = await computeInjectContext(
      "Recall the injection ordering decision for this project.",
      "/project",
      "daemon",
      "session-ordering-test",
    );

    expect(context.indexOf("[MEMEX CORRECTION]")).toBe(0);
    expect(context).toContain("Main now uses PostgreSQL");
    expect(context).toContain('earlier: "Main uses MySQL"');
    expect(context.indexOf("[MEMEX CORRECTION]")).toBeLessThan(context.indexOf("[CURRENT TRUTH]"));
    expect(context).toContain("Prepared recall receipt");
    expect(recordRecallEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      factIds: ["fact-correction", "fact-prepared-gate"],
      projectMemoryRevision: 3,
    }));
    expect(recordResidentFactRevisions).toHaveBeenCalledWith(
      expect.anything(),
      "session-ordering-test",
      0,
      [["fact-correction", 2, 1], ["fact-prepared-gate", 1, 1]],
    );
    expect(markSessionProjectRevisionSeen).toHaveBeenCalledWith(expect.anything(), "session-ordering-test", 3);
  });

  it("emits labeled Hot Evidence even when no distilled fact matches", async () => {
    factResults.value = [];
    hotEvidence.value = [{ evidence_text: "Sibling trusted test passed" }];
    const context = await computeInjectContext(
      "Continue the sibling validation work.",
      "/project",
      "daemon",
      "session-ordering-test",
    );
    expect(context).toContain("[RECENT EVIDENCE — NOT YET DISTILLED]");
    expect(context).toContain("Sibling trusted test passed");
    expect(recordRecallEvent).not.toHaveBeenCalled();
  });
});
