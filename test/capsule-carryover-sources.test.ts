import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import {
  captureTranscriptPrefix,
  ensureSessionMemoryState,
  readWorkCapsule,
} from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { CAPSULE_PAGE_ITEMS } from "../src/continuity-evidence.js";

/**
 * Issue #143 — `capsule source was not present in the fixed evidence page` on
 * the first attempt, on two machines and two workstreams.
 *
 * The worker handed the model `previousCapsule.sourceExchangeIds`, and a model
 * asked to *update* a capsule carries those ids forward; the patch was then
 * rejected whole, a retry was spent and the page halved (#33), and five such
 * answers killed the job (#71).
 *
 * The fix is two-sided: the model never sees the previous sources (B1), and a
 * patch that cites them anyway has them normalized away instead of rejected
 * (B2) — from the top-level list and from every per-claim list. Ids that are
 * neither on the page nor previous sources still throw, now naming themselves.
 */

let root: string;
let db: Database.Database;
let workstream: string;
const vector = new Array(384).fill(0.01);
const PAGE_ONE = Array.from({ length: CAPSULE_PAGE_ITEMS }, (_, i) => `exchange-${i}`);
const PAGE_TWO = Array.from({ length: CAPSULE_PAGE_ITEMS }, (_, i) => `later-${i}`);
/** The generation-1 capsule cites exactly these, and neither is on page two. */
const PREVIOUS_SOURCES = ["exchange-0", "exchange-1"];
/** In the workstream, on no page this attempt reads, never a previous source. */
const OFF_PAGE_STRANGER = "exchange-5";

function transcript(session: string): string {
  return path.join(root, `${session}.jsonl`);
}

function put(id: string): void {
  insertExchange(db, {
    id, sessionId: "session-A", project: root, cwd: root, archivePath: transcript("session-A"),
    timestamp: new Date().toISOString(), userMessage: `human said ${id}`, assistantMessage: "",
    lineStart: 2, lineEnd: 2,
  }, vector);
}

function capture(): void {
  fs.appendFileSync(
    transcript("session-A"),
    JSON.stringify({ type: "event_msg", payload: { type: "note", text: "" } }) + "\n",
  );
  captureTranscriptPrefix(db, {
    sessionId: "session-A", project: root, transcriptPath: transcript("session-A"), kind: "final",
  });
  db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
}

function patch(fields: {
  sourceExchangeIds: string[];
  verifiedProgress?: Array<{ text: string; sourceExchangeIds: string[] }>;
  hypotheses?: Array<{ text: string; sourceExchangeIds: string[] }>;
}): string {
  return JSON.stringify({
    objective: "Keep the capsule alive",
    currentState: "Distilling page two",
    verifiedProgress: fields.verifiedProgress ?? [],
    hypotheses: fields.hypotheses ?? [],
    blockers: [], openQuestions: [], nextActions: ["Continue"], touchedAreas: [],
    carryFactRevisions: [],
    sourceExchangeIds: fields.sourceExchangeIds,
  });
}

function capsuleJobs(): Array<{ state: string; attempts: number; last_error: string | null }> {
  return db.prepare(
    "SELECT state, attempts, last_error FROM memory_jobs WHERE kind = 'capsule_update' ORDER BY rowid",
  ).all() as Array<{ state: string; attempts: number; last_error: string | null }>;
}

/** Commits generation 1 from page one, citing only PREVIOUS_SOURCES. */
async function seedGenerationOne(): Promise<void> {
  const results = await runContinuityWorker(db, {
    maxJobs: 4,
    model: async () => patch({
      sourceExchangeIds: PREVIOUS_SOURCES,
      verifiedProgress: [{ text: "page one was read", sourceExchangeIds: PREVIOUS_SOURCES }],
    }),
  });
  expect(results.every((result) => ["completed", "partial"].includes(result.state))).toBe(true);
  expect(readWorkCapsule(db, workstream)?.generation).toBe(1);
  expect(readWorkCapsule(db, workstream)?.sourceExchangeIds).toEqual(PREVIOUS_SOURCES);
  for (const id of PAGE_TWO) put(id);
  capture();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-capsule-carryover-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  workstream = ensureSessionMemoryState(db, { sessionId: "session-A", project: root }).workstreamId;
  ensureSessionMemoryState(db, { sessionId: "session-A", project: root, explicitWorkstreamId: workstream });
  fs.writeFileSync(
    transcript("session-A"),
    JSON.stringify({ type: "session_meta", payload: { id: "session-A", cwd: root } }) + "\n",
  );
  for (const id of PAGE_ONE) put(id);
  capture();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  fs.rmSync(root, { recursive: true, force: true });
});

it("a patch citing previous sources together with page ids commits without spending a retry", async () => {
  await seedGenerationOne();

  const results = await runContinuityWorker(db, {
    maxJobs: 4,
    model: async () => patch({
      // Exactly the observed shape: the previous generation's ids carried
      // forward, unioned with the ids of the page this attempt actually read.
      sourceExchangeIds: [...PREVIOUS_SOURCES, ...PAGE_TWO],
      verifiedProgress: [{ text: "page two was read", sourceExchangeIds: [PAGE_TWO[0]] }],
    }),
  });

  expect(results.every((result) => ["completed", "partial"].includes(result.state))).toBe(true);
  const capsule = readWorkCapsule(db, workstream);
  expect(capsule?.generation).toBe(2);
  // Only page ids survive; the carried-over previous ids are dropped silently.
  expect(capsule?.sourceExchangeIds).toEqual(PAGE_TWO);
  expect(capsule?.sourceExchangeIds).not.toContain("exchange-0");
  // No retry was consumed and nothing shrank the page for the next attempt.
  expect(capsuleJobs().every((job) => job.state !== "retry" && job.attempts <= 1)).toBe(true);
  expect(
    db.prepare("SELECT last_error, page_items_hint FROM capsule_checkpoint_state ORDER BY rowid DESC LIMIT 1")
      .get(),
  ).toMatchObject({ last_error: null, page_items_hint: null });
});

it("a previous source cited by a claim is removed from that claim, and a claim left bare is dropped", async () => {
  await seedGenerationOne();

  const results = await runContinuityWorker(db, {
    maxJobs: 4,
    model: async () => patch({
      sourceExchangeIds: [...PREVIOUS_SOURCES, ...PAGE_TWO],
      verifiedProgress: [
        // Mixed support: the carried-over id goes, the page id stays.
        { text: "mixed support", sourceExchangeIds: ["exchange-0", PAGE_TWO[1]] },
      ],
      hypotheses: [
        // Supported only by carried-over ids: the whole claim goes, because the
        // schema has no room for a claim without sources.
        { text: "carried over alone", sourceExchangeIds: PREVIOUS_SOURCES },
        { text: "grounded in this page", sourceExchangeIds: [PAGE_TWO[2]] },
      ],
    }),
  });

  expect(results.every((result) => ["completed", "partial"].includes(result.state))).toBe(true);
  const capsule = readWorkCapsule(db, workstream);
  expect(capsule?.generation).toBe(2);
  expect(capsule?.verifiedProgress).toEqual([
    { text: "mixed support", sourceExchangeIds: [PAGE_TWO[1]] },
  ]);
  expect(capsule?.hypotheses).toEqual([
    { text: "grounded in this page", sourceExchangeIds: [PAGE_TWO[2]] },
  ]);
  const claimSources = [
    ...capsule!.verifiedProgress.flatMap((item) => item.sourceExchangeIds),
    ...capsule!.hypotheses.flatMap((item) => item.sourceExchangeIds),
  ];
  expect(claimSources.some((id) => PREVIOUS_SOURCES.includes(id))).toBe(false);
  expect(capsuleJobs().every((job) => job.state !== "retry")).toBe(true);
});

it("an id that is neither on the page nor a previous source still throws, and names itself", async () => {
  await seedGenerationOne();

  const results = await runContinuityWorker(db, {
    maxJobs: 1,
    model: async () => patch({
      sourceExchangeIds: [...PAGE_TWO, OFF_PAGE_STRANGER],
    }),
  });

  expect(results[0]?.state).toBe("retry");
  expect(results[0]?.detail).toContain("capsule source was not present in the fixed evidence page");
  // The ids were invisible before; #143 could not be proven from the log.
  expect(results[0]?.detail).toContain(OFF_PAGE_STRANGER);
  expect(readWorkCapsule(db, workstream)?.generation).toBe(1);
});

it("the model input no longer carries previousCapsule.sourceExchangeIds", async () => {
  await seedGenerationOne();

  let seen: Record<string, unknown> | null = null;
  await runContinuityWorker(db, {
    maxJobs: 1,
    model: async (_system, user) => {
      seen = JSON.parse(user).previousCapsule;
      return patch({ sourceExchangeIds: [PAGE_TWO[0]] });
    },
  });

  const previousCapsule = seen as Record<string, unknown> | null;
  // The previous generation is still handed over — only its sources are gone.
  expect(previousCapsule).not.toBeNull();
  expect(previousCapsule!.generation).toBe(1);
  expect(Object.prototype.hasOwnProperty.call(previousCapsule!, "sourceExchangeIds")).toBe(false);
  expect(previousCapsule!.sourceExchangeIds).toBeUndefined();
});
