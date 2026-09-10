/**
 * G2 — the block set is `claim snapshot ∪ latest valid rules` (#30 §3.4, R5d).
 *
 * v3 read only the current file at the storage boundary, and that was backwards
 * in the one direction that loses a secret: deleting pattern A after the claim
 * emptied the forbid set, so A was not applied to work that started while A was
 * in force — the exact opposite of "relaxation takes effect from the next claim".
 *
 * The union fixes both directions at once and needs no file↔DB atomicity:
 *   tightening  → in force from the read just before the worker evaluation,
 *   relaxation  → from the next claim, because the snapshot stays in the union.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { saveExtractedFactsDetailed } from "../src/fact-extractor.js";
import {
  loadExtractionRules,
  resetExtractionRulesCache,
  resolveExtractionRules,
  type ResolvedExtractionRules,
} from "../src/extraction-rules.js";
import {
  pinOverlayEnv,
  removeRules,
  restoreOverlayEnv,
  rulesDoc,
  writeRules,
} from "./extraction-rules-fixture.js";
import type { ExtractedFact } from "../src/types.js";

const ALPHA = "alpha-token-value";
const BETA = "beta-token-value";

let root: string;
let home: string;
let db: Database.Database;
const cwd = "/project/rules-union";
const emb = new Array(384).fill(0.1);

function candidate(text: string, subject: string): ExtractedFact {
  return {
    fact: text,
    category: "knowledge",
    scope_type: "project",
    confidence: 0.95,
    grounding_type: "explicit",
    durable: true,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: "token" }],
    source_exchange_ids: ["ex-1"],
    subject_key: subject,
  };
}

/** What `runFactExtraction` captures at claim time, before anything is edited. */
function claimSnapshot(): ResolvedExtractionRules {
  resetExtractionRulesCache();
  return resolveExtractionRules(cwd, loadExtractionRules());
}

async function save(
  facts: ExtractedFact[],
  rulesSnapshot: ResolvedExtractionRules,
): Promise<Awaited<ReturnType<typeof saveExtractedFactsDetailed>>> {
  return saveExtractedFactsDetailed(db, facts, cwd, [], undefined, undefined, {
    sessionId: "s1",
    rulesSnapshot,
    targetId: "target-union",
  });
}

function storedFacts(): string[] {
  return (db.prepare("SELECT fact FROM facts ORDER BY fact").all() as Array<{ fact: string }>).map(
    (row) => row.fact,
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-union-"));
  home = path.join(root, "home");
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  pinOverlayEnv(home);
  process.env.MEMEX_EMBEDDING_STUB = "1";
  resetExtractionRulesCache();
  db = initDatabase();
  insertExchange(
    db,
    {
      id: "ex-1",
      project: cwd,
      cwd,
      timestamp: "2026-08-01T10:00:00.000Z",
      userMessage: `the token values are ${ALPHA} and ${BETA}`,
      assistantMessage: "assistant context only",
      archivePath: path.join(root, "s1.jsonl"),
      lineStart: 1,
      lineEnd: 2,
      sessionId: "s1",
      closureState: "closed",
      parserVersion: 2,
    },
    emb,
  );
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  restoreOverlayEnv();
  delete process.env.MEMEX_EMBEDDING_STUB;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("relaxation takes effect from the NEXT claim, not this one", () => {
  it("still blocks pattern A after A is DELETED between the claim and the commit", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    const snapshot = claimSnapshot();
    expect(snapshot.neverExtract.map((p) => p.id)).toEqual(["A"]);

    // The operator deletes the rule while the model call is in flight.
    writeRules(home, rulesDoc([]));
    const outcome = await save([candidate(`uses ${ALPHA}`, "state.token.alpha")], snapshot);

    expect(outcome.blockedByRules).toBe(1);
    expect(storedFacts()).toEqual([]);
  });

  it("still blocks when the whole overlay FILE is removed mid-claim", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    const snapshot = claimSnapshot();
    removeRules(home);
    const outcome = await save([candidate(`uses ${ALPHA}`, "state.token.alpha")], snapshot);
    expect(outcome.blockedByRules).toBe(1);
    expect(storedFacts()).toEqual([]);
  });

  it("stops blocking on the next claim, which takes a fresh snapshot", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    claimSnapshot();
    writeRules(home, rulesDoc([]));
    // The next claim's snapshot no longer contains A, and neither does the file.
    const outcome = await save([candidate(`uses ${ALPHA}`, "state.token.alpha")], claimSnapshot());
    expect(outcome.blockedByRules).toBe(0);
    expect(storedFacts()).toEqual([`uses ${ALPHA}`]);
  });
});

describe("tightening takes effect at the read, on THIS claim", () => {
  it("blocks pattern B that was ADDED between the claim and the commit", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    const snapshot = claimSnapshot();

    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }, { id: "B", source: BETA }]));
    const outcome = await save([candidate(`uses ${BETA}`, "state.token.beta")], snapshot);

    expect(outcome.blockedByRules).toBe(1);
    expect(storedFacts()).toEqual([]);
  });

  it("blocks a pattern added when the claim had NO rules at all", async () => {
    const snapshot = claimSnapshot();
    expect(snapshot.neverExtract).toEqual([]);
    writeRules(home, rulesDoc([{ id: "B", source: BETA }]));
    const outcome = await save([candidate(`uses ${BETA}`, "state.token.beta")], snapshot);
    expect(outcome.blockedByRules).toBe(1);
    expect(storedFacts()).toEqual([]);
  });

  it("applies BOTH halves of the union in one commit", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    const snapshot = claimSnapshot();
    writeRules(home, rulesDoc([{ id: "B", source: BETA }])); // A removed, B added
    const outcome = await save(
      [
        candidate(`uses ${ALPHA}`, "state.token.alpha"),
        candidate(`uses ${BETA}`, "state.token.beta"),
        candidate("uses nothing secret", "state.token.none"),
      ],
      snapshot,
    );
    expect(outcome.blockedByRules).toBe(2);
    expect(storedFacts()).toEqual(["uses nothing secret"]);
  });
});

describe("a broken file mid-claim does not lose the claim's rules (D4)", () => {
  it("keeps enforcing the last valid rules and throws nothing", async () => {
    writeRules(home, rulesDoc([{ id: "A", source: ALPHA }]));
    const snapshot = claimSnapshot();
    fs.writeFileSync(path.join(home, "overlays", "extraction-rules.json"), "{ broken");
    const outcome = await save([candidate(`uses ${ALPHA}`, "state.token.alpha")], snapshot);
    expect(outcome.blockedByRules).toBe(1);
    expect(storedFacts()).toEqual([]);
  });
});
