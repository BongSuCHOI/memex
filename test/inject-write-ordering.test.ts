import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const recordRecallEvent = vi.hoisted(() => vi.fn());
const recordResidentFactRevisions = vi.hoisted(() => vi.fn(() => true));

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
}));
vi.mock("../src/fact-db.js", () => ({
  searchFactsByScope: () => [
    {
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
    },
  ],
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
  ensureSessionMemoryState: vi.fn(),
  readResidentFactRevisions: () => ({ contextEpoch: 0, resident: [], carry: [] }),
  recordResidentFactRevisions,
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
});
