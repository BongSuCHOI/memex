/**
 * What the storage boundary actually examines (#30 §3.3 / §3.4, G1 / G2).
 *
 * Three separate ways a forbid rule was satisfied by the check and then defeated
 * by the insert, each of which stored exactly the string the operator wrote the
 * rule to keep out:
 *
 *   1. the fields were JOINED with a newline before matching, so `/^SECRET$/`
 *      stopped matching as soon as the candidate also had a `fact_kr`;
 *   2. only `fact`, `fact_kr` and the plain evidence spans were looked at, while
 *      the same transaction wrote `subject_key`, `classifier_notes` and all three
 *      `change_context` fields into their own durable columns;
 *   3. the matcher silently truncates at 8,000 chars — a recall-path cost bound —
 *      so anything past that was never examined and the check reported success.
 *
 * `MEMEX_OVERLAY_DIR` is pinned here, not merely `MEMEX_HOME`: the override has the
 * higher priority, and a suite that writes overlays with it inherited from the
 * environment would edit the operator's real rules file.
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

import { initDatabase } from "../src/db.js";
import { saveExtractedFactsDetailed } from "../src/fact-extractor.js";
import {
  buildBlockSet,
  resetExtractionRulesCache,
  unionNeverExtract,
  type NeverExtractPattern,
} from "../src/extraction-rules.js";
import {
  MATCH_INPUT_CHARS,
  oneShotMatcher,
  resetQuarantineMemory,
  type MatcherHandle,
} from "../src/overlay-matcher.js";
import type { ExtractedFact } from "../src/types.js";
import {
  PROJECT,
  rulesDoc,
  scanWholeDatabase,
  seedExchanges,
  writeRules,
} from "./extraction-rules-fixture.js";

const SECRET = "sk-live-AbCdEf0123456789";
const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";

let root: string;
let env: Record<string, string | undefined>;
let db: Database.Database;
const handles: MatcherHandle[] = [];

function matcher(): MatcherHandle {
  const handle = oneShotMatcher();
  handles.push(handle);
  return handle;
}

function pattern(source: string, scope: NeverExtractPattern["scope"] = "both"): NeverExtractPattern {
  return { id: "user.forbid", source, flags: "", scope };
}

/** A fact candidate whose evidence is an exact span of the seeded exchange. */
function fact(overrides: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    fact: "Riverpod was chosen for state management",
    category: "preference",
    scope_type: "project",
    confidence: 0.9,
    grounding_type: "explicit",
    durable: true,
    evidence: [{ exchange_index: 1, source: "human", kind: "assertion", supporting_span: "Riverpod" }],
    source_exchange_ids: ["e0"],
    ...overrides,
  } as ExtractedFact;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-forbid-fields-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_DB_PATH: process.env.MEMEX_DB_PATH,
    MEMEX_DISABLE_OVERLAYS: process.env.MEMEX_DISABLE_OVERLAYS,
  };
  process.env.MEMEX_HOME = root;
  process.env.MEMEX_OVERLAY_DIR = path.join(root, "overlays");
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  db = initDatabase();
  seedExchanges(db, { userMessage: `Riverpod was chosen. The deploy key is ${SECRET}.` });
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  try { db.close(); } catch { /* already closed */ }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.MEMEX_EMBEDDING_STUB;
  resetQuarantineMemory();
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("each field is evaluated on its own", () => {
  it("an anchored rule still fires when the candidate also has a fact_kr", async () => {
    // `/^SECRET$/` matches the fact. Joined with the translation it matches
    // nothing, and the join is what the code used to do.
    const outcome = await buildBlockSet(
      matcher(),
      [pattern("^SECRET$")],
      [{ item: "candidate", candidate: { factText: ["SECRET", "비밀 값"], evidence: [] } }],
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.blocked]).toEqual(["candidate"]);
    expect(outcome.patternIds).toEqual(["user.forbid"]);
  });

  it("an anchored rule fires on the second field too, not only the first", async () => {
    const outcome = await buildBlockSet(
      matcher(),
      [pattern("^비밀 값$")],
      [{ item: "candidate", candidate: { factText: ["SECRET", "비밀 값"], evidence: [] } }],
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.blocked]).toEqual(["candidate"]);
  });

  it("still does not block a candidate no rule matches", async () => {
    const outcome = await buildBlockSet(
      matcher(),
      [pattern("^SECRET$")],
      [{ item: "candidate", candidate: { factText: ["SECRET value", "비밀 값"], evidence: ["SECRET "] } }],
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.blocked]).toEqual([]);
  });
});

describe("the matcher's input cap is never a silent pass", () => {
  it("holds when a field is longer than the cap instead of checking the prefix only", async () => {
    const outcome = await buildBlockSet(
      matcher(),
      [pattern("SECRET")],
      [{
        item: "candidate",
        candidate: { factText: [`${"a".repeat(MATCH_INPUT_CHARS)}SECRET`], evidence: [] },
      }],
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("extraction_rules_unavailable");
    expect(outcome.quarantined).toEqual([]);
    expect(outcome.detail).toMatch(/8000|8,000/);
  });

  it("checks a field exactly at the cap normally", async () => {
    const outcome = await buildBlockSet(
      matcher(),
      [pattern("SECRET")],
      [{
        item: "candidate",
        candidate: { factText: [`${"a".repeat(MATCH_INPUT_CHARS - 6)}SECRET`], evidence: [] },
      }],
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.blocked]).toEqual(["candidate"]);
  });
});

describe("the claim ∪ latest union keeps the stricter scope", () => {
  it("widening fact_text to both adds the evidence check to a claim in flight", async () => {
    const union = unionNeverExtract(
      [pattern(PATTERN, "fact_text")],
      [pattern(PATTERN, "both")],
    );

    expect(union).toHaveLength(1);
    expect(union[0].scope).toBe("both");

    const outcome = await buildBlockSet(
      matcher(),
      union,
      [{ item: "candidate", candidate: { factText: ["clean text"], evidence: [SECRET] } }],
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect([...outcome.blocked]).toEqual(["candidate"]);
  });

  it("two different single scopes together forbid both halves", () => {
    const union = unionNeverExtract(
      [pattern(PATTERN, "fact_text")],
      [pattern(PATTERN, "evidence")],
    );
    expect(union).toHaveLength(1);
    expect(union[0].scope).toBe("both");
  });

  it("leaves a scope alone when nothing changed", () => {
    const union = unionNeverExtract(
      [pattern(PATTERN, "evidence")],
      [pattern(PATTERN, "evidence")],
    );
    expect(union).toHaveLength(1);
    expect(union[0].scope).toBe("evidence");
  });
});

describe("every text column the commit writes is covered", () => {
  const columns: Array<{ label: string; overrides: Partial<ExtractedFact> }> = [
    { label: "classifier_notes", overrides: { classifier_notes: [`the key is ${SECRET}`] } },
    { label: "subject_key", overrides: { subject_key: `deploy.key.${SECRET}` } },
    {
      label: "change_context.rationale.text",
      overrides: {
        change_context: {
          rationale: {
            exchange_id: "e0",
            supporting_span: "Riverpod",
            text: `rotated because ${SECRET} leaked`,
          },
        },
      },
    },
    {
      label: "change_context.problem.supporting_span",
      overrides: {
        change_context: {
          problem: {
            exchange_id: "e0",
            supporting_span: `The deploy key is ${SECRET}.`,
            text: "the key was public",
          },
        },
      },
    },
  ];

  it.each(columns)("drops the candidate whose $label carries the forbidden string", async ({ overrides }) => {
    writeRules(root, rulesDoc([{ id: "user.forbid", source: PATTERN }]));
    resetExtractionRulesCache();

    const outcome = await saveExtractedFactsDetailed(
      db,
      [fact(overrides)],
      PROJECT,
      ["e0"],
      undefined,
      undefined,
      { rulesSnapshot: null, targetId: "target-1" },
    );

    expect(outcome.blockedByRules).toBe(1);
    expect(outcome.savedIds).toEqual([]);
    expect(scanWholeDatabase(db, SECRET)).toEqual([]);
  });

  it("saves a clean candidate unchanged", async () => {
    writeRules(root, rulesDoc([{ id: "user.forbid", source: PATTERN }]));
    resetExtractionRulesCache();

    const outcome = await saveExtractedFactsDetailed(
      db,
      [fact({ classifier_notes: ["no secret here"], subject_key: "state.management" })],
      PROJECT,
      ["e0"],
      undefined,
      undefined,
      { rulesSnapshot: null, targetId: "target-1" },
    );

    expect(outcome.blockedByRules).toBe(0);
    expect(outcome.savedIds).toHaveLength(1);
  });
});
