import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { initDatabase, insertExchange } from "../src/db.js";
import { applyWorkCapsulePatch, captureTranscriptPrefix, ensureSessionMemoryState, readWorkCapsule, WORK_CAPSULE_OUTPUT_SCHEMA } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";
import { rebindSessionWorkstream, createWorkstream } from "../src/continuity-identity.js";
import { purgeConversationFromIndex } from "../src/conversation-policy.js";
import { ensureContinuitySchema } from "../src/continuity-store.js";
import { CAPSULE_PAGE_CHARS } from "../src/continuity-evidence.js";

let root: string;
let db: Database.Database;
let workstream: string;
let scopes: ReturnType<typeof ensureSessionMemoryState>;
const vector = new Array(384).fill(0.01);
const originalCodexBin = process.env.MEMEX_CODEX_BIN;
const patch = {
  objective: "Maintain continuity", currentState: "Captured work", verifiedProgress: [], hypotheses: [],
  blockers: [], openQuestions: [], nextActions: ["Verify the next step"], touchedAreas: [],
  carryFactRevisions: [], sourceExchangeIds: [],
};

function transcript(session: string): string { return path.join(root, `${session}.jsonl`); }
function bind(session: string): void {
  ensureSessionMemoryState(db, { sessionId: session, project: root, explicitWorkstreamId: workstream });
  fs.writeFileSync(transcript(session), JSON.stringify({ type: "session_meta", payload: { id: session, cwd: root } }) + "\n");
}
function put(session: string, id: string, text = id, generation?: number): void {
  insertExchange(db, {
    id, sessionId: session, project: root, cwd: root, archivePath: transcript(session),
    timestamp: new Date().toISOString(), userMessage: text, assistantMessage: "",
    lineStart: 2, lineEnd: 2, contentGeneration: generation,
  }, vector);
}
function capture(session: string, kind: "stop" | "final" = "final", padding = 0) {
  fs.appendFileSync(transcript(session), JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x".repeat(padding) } }) + "\n");
  const result = captureTranscriptPrefix(db, { sessionId: session, project: root, transcriptPath: transcript(session), kind });
  // These are isolated P1/scheduler tests. P0 ingestion is covered separately
  // by continuity-final-integration; inserts above supply its committed rows.
  db.prepare("UPDATE memory_jobs SET state = 'completed' WHERE kind = 'capture_index'").run();
  return result;
}
function frontier(): { through_seq: number; revision: number } {
  return db.prepare("SELECT through_seq, revision FROM capsule_frontiers WHERE workstream_id = ?")
    .get(workstream) as { through_seq: number; revision: number };
}
function maximum(): number {
  return (db.prepare("SELECT COALESCE(MAX(seq),0) n FROM workstream_evidence WHERE workstream_id = ?")
    .get(workstream) as { n: number }).n;
}

function useFakeCodex(response: unknown): string {
  const bin = path.join(root, "fake-codex");
  const observation = path.join(root, "schema-observation.json");
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const schemaPath = args[args.indexOf('--output-schema') + 1];
fs.writeFileSync(${JSON.stringify(observation)}, fs.readFileSync(schemaPath));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(JSON.stringify(response))} } }));
`);
  fs.chmodSync(bin, 0o755);
  process.env.MEMEX_CODEX_BIN = bin;
  return observation;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-evidence-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  db = initDatabase();
  scopes = ensureSessionMemoryState(db, { sessionId: "session-A", project: root });
  workstream = scopes.workstreamId;
  bind("session-A");
  bind("session-C");
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  if (originalCodexBin === undefined) delete process.env.MEMEX_CODEX_BIN;
  else process.env.MEMEX_CODEX_BIN = originalCodexBin;
  fs.rmSync(root, { recursive: true, force: true });
});

it("the default Capsule worker passes its native object schema through the real provider path", async () => {
  put("session-A", "source");
  capture("session-A");
  const response = { ...patch, sourceExchangeIds: ["source"],
    hypotheses: [{ text: "Unverified proposal", sourceExchangeIds: ["source"] }] };
  const observation = useFakeCodex(response);
  const result = await runContinuityWorker(db, { maxJobs: 1 });
  expect(result[0].state).toBe("completed");
  expect(JSON.parse(fs.readFileSync(observation, "utf8"))).toEqual(WORK_CAPSULE_OUTPUT_SCHEMA);
  expect(WORK_CAPSULE_OUTPUT_SCHEMA.properties.hypotheses.items.type).toBe("object");
  expect(readWorkCapsule(db, workstream)?.hypotheses).toEqual(response.hypotheses);
  expect(frontier().through_seq).toBe(maximum());
});

it.each([
  { change: { hypotheses: ["Unverified proposal"] }, error: "hypotheses contains invalid item" },
  { change: { objective: "x".repeat(501) }, error: "objective must be text" },
  { change: { carryFactRevisions: [["fact", 1, "2"]] }, error: "invalid revision identity" },
  { change: { hypotheses: [{ text: "Proposal", sourceExchangeIds: ["foreign"] }], sourceExchangeIds: ["foreign"] }, error: "missing or outside workstream" },
])("still rejects invalid Capsule content after native generation: $error", async ({ change, error }) => {
  put("session-A", "source");
  capture("session-A");
  useFakeCodex({ ...patch, ...change });
  const result = await runContinuityWorker(db, { maxJobs: 1 });
  expect(result[0].state).toBe("retry");
  expect(result[0].detail).toContain(error);
  expect(readWorkCapsule(db, workstream)).toBeNull();
  expect(frontier().through_seq).toBe(0);
});

it("drains twenty alternating A/C updates without repeating unchanged generations", async () => {
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const session = i % 2 ? "session-C" : "session-A";
    put(session, `exchange-${i}`);
    capture(session);
    const result = await runContinuityWorker(db, { maxJobs: 1, model: async (_, user) => {
      seen.push(...JSON.parse(user).contiguousSegment.map((item: { exchangeId: string }) => item.exchangeId));
      return JSON.stringify(patch);
    } });
    expect(result[0].state).toBe("completed");
    expect(frontier().through_seq).toBe(maximum());
  }
  expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => `exchange-${i}`));
});

it("preserves immutable generations even when the exchange row is overwritten before consumption", async () => {
  put("session-A", "growing", "old text", 1);
  put("session-A", "growing", "old text plus suffix", 2);
  put("session-A", "growing", "old text plus suffix", 2);
  capture("session-A");
  let seen: Array<{ human: string; contentGeneration: number }> = [];
  await runContinuityWorker(db, { maxJobs: 1, model: async (_, user) => {
    seen = JSON.parse(user).contiguousSegment;
    return JSON.stringify(patch);
  } });
  expect(seen.map((x) => [x.contentGeneration, x.human])).toEqual([[1, "old text"], [2, "old text plus suffix"]]);
});

it("pins the target, bounds pages and retries the whole unconsumed suffix without truncating a large exchange", async () => {
  const source = "한글😀".repeat(10_000);
  put("session-A", "large", source);
  const target = maximum();
  capture("session-A");
  const seen: Array<{ exchangeId: string; human: string; evidenceSeq: number }> = [];
  let calls = 0;
  const model = async (_: string, user: string) => {
    const segment = JSON.parse(user).contiguousSegment;
    expect(segment.length).toBeLessThanOrEqual(8);
    // Per-item metadata added on read is bounded separately from payload text.
    expect(JSON.stringify(segment).length).toBeLessThan(CAPSULE_PAGE_CHARS + 1_000);
    seen.push(...segment);
    if (++calls === 1) put("session-C", "late", "late evidence");
    return JSON.stringify(patch);
  };
  await runContinuityWorker(db, { maxJobs: 1, model });
  expect(frontier().through_seq).toBeLessThan(target);
  const fixed = db.prepare("SELECT target_seq FROM capsule_checkpoint_state").get() as { target_seq: number };
  expect(fixed.target_seq).toBe(target);
  while (frontier().through_seq < target) await runContinuityWorker(db, { maxJobs: 1, model });
  expect(seen.some((x) => x.exchangeId === "late")).toBe(false);
  expect(seen.map((x) => x.human).join("")).toBe(source);
  await runContinuityWorker(db, { maxJobs: 1, model });
  expect(seen.at(-1)?.exchangeId).toBe("late");
  expect(new Set(seen.map((x) => x.evidenceSeq)).size).toBe(seen.length);
});

it("checks verified authority against the presented immutable generation", async () => {
  put("session-A", "changed", "Human verified this", 1);
  put("session-A", "changed", "", 2);
  capture("session-A");
  const result = await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify({
    ...patch, sourceExchangeIds: ["changed"],
    verifiedProgress: [{ text: "Human verified this", sourceExchangeIds: ["changed"] }],
  }) });
  expect(result[0].state).toBe("completed");
});

it("cannot promote an assistant-only fragment using authority from an earlier page", async () => {
  insertExchange(db, {
    id: "fragmented", sessionId: "session-A", project: root, cwd: root, archivePath: transcript("session-A"),
    timestamp: new Date().toISOString(), userMessage: "Human context", assistantMessage: "a".repeat(40_000),
    lineStart: 2, lineEnd: 2,
  }, vector);
  capture("session-A");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  const before = frontier().through_seq;
  const result = await runContinuityWorker(db, { maxJobs: 1, model: async (_, user) => {
    expect(JSON.parse(user).contiguousSegment.every((item: { human: string }) => !item.human)).toBe(true);
    return JSON.stringify({ ...patch, sourceExchangeIds: ["fragmented"],
      verifiedProgress: [{ text: "Assistant claim", sourceExchangeIds: ["fragmented"] }] });
  } });
  expect(result[0].state).toBe("retry");
  expect(frontier().through_seq).toBe(before);
});

it("schedules the sixth small sibling Stop after a large A checkpoint", async () => {
  put("session-A", "large-A");
  capture("session-A", "final", 20_000);
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  for (let i = 0; i < 5; i++) expect(capture("session-C", "stop").capsuleJobId).toBeNull();
  expect(capture("session-C", "stop").capsuleJobId).not.toBeNull();
});

it("reschedules a threshold reached while an earlier Capsule was pending", async () => {
  put("session-A", "first");
  capture("session-A");
  for (let i = 0; i < 6; i++) capture("session-C", "stop");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => {
    put("session-C", "late");
    return JSON.stringify(patch);
  } });
  const results = await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  expect(results[0].state).toBe("completed");
  expect(frontier().through_seq).toBe(maximum());
});

it("does not advance the frontier when the model fails or loses its lease", async () => {
  put("session-A", "one");
  capture("session-A");
  expect((await runContinuityWorker(db, { maxJobs: 1, model: async () => { throw new Error("model failure"); } }))[0].state).toBe("retry");
  expect(frontier().through_seq).toBe(0);
  db.prepare("UPDATE memory_jobs SET available_at = '2000-01-01' WHERE state = 'retry'").run();
  const result = await runContinuityWorker(db, { maxJobs: 1, model: async () => {
    db.prepare("UPDATE memory_jobs SET lease_generation = lease_generation + 1 WHERE kind = 'capsule_update'").run();
    return JSON.stringify(patch);
  } });
  expect(result[0].state).toBe("stale");
  expect(frontier().through_seq).toBe(0);
  expect(readWorkCapsule(db, workstream)).toBeNull();
});

it("rejects a model result if a sibling source is purged during the await", async () => {
  put("session-A", "private");
  put("session-C", "public");
  capture("session-C");
  const result = await runContinuityWorker(db, { maxJobs: 1, model: async () => {
    purgeConversationFromIndex(db, { archivePath: transcript("session-A"), sessionId: "session-A" });
    return JSON.stringify(patch);
  } });
  expect(result[0].state).toBe("stale");
  expect(readWorkCapsule(db, workstream)).toBeNull();
  expect(frontier().through_seq).toBe(0);
});

it("purges transitive Capsule context even when the model did not list its prior sources", async () => {
  put("session-A", "private");
  capture("session-A");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  put("session-C", "public");
  capture("session-C");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  expect(readWorkCapsule(db, workstream)?.sourceSessionId).toBe("session-C");
  purgeConversationFromIndex(db, { archivePath: transcript("session-A"), sessionId: "session-A" });
  expect(readWorkCapsule(db, workstream)).toBeNull();
  expect(frontier().through_seq).toBe(0);
  await runContinuityWorker(db, { maxJobs: 1, model: async (_, user) => {
    expect(user).not.toContain("private");
    return JSON.stringify(patch);
  } });
  expect(frontier().through_seq).toBe(maximum());
});

it("invalidates a legacy Capsule with unknown coverage when a sibling is purged before replay", async () => {
  put("session-A", "private");
  put("session-C", "public");
  capture("session-C");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  // A v6 projection has no sequence coverage and may have omitted transitive source IDs.
  db.prepare("UPDATE capsule_frontiers SET through_seq = 0 WHERE workstream_id = ?").run(workstream);
  db.prepare("UPDATE session_memory_state SET capsule_generation_seen = 1 WHERE workstream_id = ?").run(workstream);
  purgeConversationFromIndex(db, { archivePath: transcript("session-A"), sessionId: "session-A" });
  expect(readWorkCapsule(db, workstream)).toBeNull();
  expect(db.prepare("SELECT capsule_generation_seen FROM session_memory_state WHERE session_id = 'session-C'").get())
    .toEqual({ capsule_generation_seen: 0 });
});

it("rebind invalidates in-flight work and re-enqueues snapshots in the new stream", async () => {
  put("session-A", "moving");
  capture("session-A");
  const target = createWorkstream(db, { projectId: scopes.projectId, workspaceId: scopes.workspaceId,
    projectPath: root, ownerSessionId: "owner", workstreamId: "target-stream" });
  const result = await runContinuityWorker(db, { maxJobs: 1, model: async () => {
    rebindSessionWorkstream(db, { sessionId: "session-A", workstreamId: target });
    return JSON.stringify(patch);
  } });
  expect(result[0].state).toBe("stale");
  expect(readWorkCapsule(db, workstream)).toBeNull();
  expect(db.prepare("SELECT DISTINCT workstream_id FROM workstream_evidence").all()).toEqual([{ workstream_id: target }]);
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  expect(readWorkCapsule(db, target)?.generation).toBe(1);
});

it("migrates v6 with replay, preserves the old Capsule until commit, and reruns without duplicating snapshots", async () => {
  put("session-A", "old");
  capture("session-A");
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  db.exec(`DROP TRIGGER exchanges_evidence_scope_change;
    DROP TRIGGER workstream_evidence_delete_projection;
    DROP TABLE workstream_evidence; DROP TABLE capsule_frontiers;
    ALTER TABLE capsule_checkpoint_state DROP COLUMN target_seq;
    ALTER TABLE capsule_checkpoint_state DROP COLUMN target_revision;
    UPDATE continuity_schema_meta SET value = '6' WHERE key = 'schema_version'; PRAGMA user_version = 6;`);
  const legacyJob = db.prepare("SELECT job_id, checkpoint_id FROM memory_jobs WHERE kind = 'capsule_update'")
    .get() as { job_id: string; checkpoint_id: string };
  db.prepare(`UPDATE memory_jobs SET state = 'running', lease_owner = 'old-worker', lease_generation = 4,
    lease_until = '2099-01-01T00:00:00.000Z' WHERE job_id = ?`).run(legacyJob.job_id);
  expect(() => ensureContinuitySchema(db, { afterMigrationStage: (stage) => {
    if (stage === "evidence-sequence") throw new Error("migration crash");
  } })).toThrow("migration crash");
  expect(db.pragma("user_version", { simple: true })).toBe(6);
  ensureContinuitySchema(db);
  expect(applyWorkCapsulePatch(db, { workstreamId: workstream, expectedGeneration: 1,
    throughCheckpointId: legacyJob.checkpoint_id, patch,
    jobLease: { jobId: legacyJob.job_id, owner: "old-worker", leaseGeneration: 4 },
  })).toBeNull();
  expect(readWorkCapsule(db, workstream)?.generation).toBe(1);
  expect(frontier().through_seq).toBe(0);
  const count = maximum();
  ensureContinuitySchema(db);
  expect(maximum()).toBe(count);
  await runContinuityWorker(db, { maxJobs: 1, model: async () => JSON.stringify(patch) });
  expect(readWorkCapsule(db, workstream)?.generation).toBe(2);
  expect(frontier().through_seq).toBe(maximum());
});
