import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { initDatabase } from "../src/db.js";
import { CAPTURE_CHUNK_BYTES, captureTranscriptPrefix } from "../src/continuity-core.js";
import { runContinuityWorker } from "../src/continuity-worker.js";

let root: string;
let source: string;
let db: Database.Database;
const session = "streaming-session";
const MiB = 1024 * 1024;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-capture-streaming-"));
  source = path.join(root, "source.jsonl");
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = root;
  process.env.MEMEX_EMBEDDING_STUB = "1";
  db = initDatabase();
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(root, { recursive: true, force: true });
});

function writeSource(bytes: number): void {
  const meta = JSON.stringify({ type: "session_meta", payload: { id: session, cwd: root } }) + "\n";
  const record = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x".repeat(MiB) } }) + "\n");
  const fd = fs.openSync(source, "w");
  try {
    fs.writeSync(fd, meta);
    let left = bytes - Buffer.byteLength(meta);
    while (left > record.length + 3) { fs.writeSync(fd, record); left -= record.length; }
    fs.writeSync(fd, '"' + "x".repeat(left - 3) + '"\n');
  } finally { fs.closeSync(fd); }
}
function capture(extra: Partial<Parameters<typeof captureTranscriptPrefix>[1]> = {}) {
  return captureTranscriptPrefix(db, { sessionId: session, project: root, transcriptPath: source, kind: "stop", ...extra });
}
function hashFile(file: string, prefix?: Buffer): string {
  const hash = createHash("sha256");
  if (prefix) hash.update(prefix);
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(MiB);
  try {
    for (let read = fs.readSync(fd, buffer); read; read = fs.readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

it.each([64 * MiB + 1, 256 * MiB])("captures %i bytes with bounded allocations and exact hashes", (size) => {
  writeSource(size);
  const allocations: number[] = [];
  const original = Buffer.alloc;
  vi.spyOn(Buffer, "alloc").mockImplementation(((size: number, ...rest: unknown[]) => {
    allocations.push(size);
    return Reflect.apply(original, Buffer, [size, ...rest]);
  }) as typeof Buffer.alloc);
  const result = capture();
  vi.restoreAllMocks();
  expect(result.sourceThroughByte).toBe(size);
  expect(result.appendedBytes).toBe(size);
  expect(Math.max(...allocations)).toBeLessThanOrEqual(CAPTURE_CHUNK_BYTES);
  expect(fs.statSync(result.journalPath).size).toBe(size);
  expect(hashFile(result.journalPath)).toBe(hashFile(source));
  expect(result.segmentHash).toBe(hashFile(source));
  expect(result.prefixHash).toBe(hashFile(source, Buffer.from([0])));
  expect(capture().appendedBytes).toBe(0);
}, 20_000);

it("handles records larger than a chunk and preserves an incomplete suffix", () => {
  const meta = JSON.stringify({ type: "session_meta", payload: { id: session, cwd: root } }) + "\n";
  const complete = JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x".repeat(2 * CAPTURE_CHUNK_BYTES) } }) + "\n";
  const partial = JSON.stringify({ type: "event_msg", payload: { type: "note", text: "y".repeat(CAPTURE_CHUNK_BYTES + 10) } });
  fs.writeFileSync(source, meta + complete + partial);
  const first = capture();
  expect(first.sourceThroughByte).toBe(Buffer.byteLength(meta + complete));
  expect(first.throughLine).toBe(2);
  fs.appendFileSync(source, "\n");
  const second = capture();
  expect(second.sourceFromByte).toBe(first.sourceThroughByte);
  expect(second.appendedBytes).toBe(Buffer.byteLength(partial) + 1);
  expect(second.throughLine).toBe(3);
  expect(hashFile(second.journalPath)).toBe(hashFile(source));
});

it.each(["chunk", "fsync", "checkpoint", "outbox"])("recovers an orphan after %s failure without advancing the committed boundary", (seam) => {
  writeSource(1 * MiB);
  const first = capture();
  fs.appendFileSync(source, JSON.stringify({ type: "event_msg", payload: { type: "note", text: "x".repeat(2 * CAPTURE_CHUNK_BYTES) } }) + "\n");
  const crash = () => { throw new Error(`crash-${seam}`); };
  expect(() => capture({
    ...(seam === "chunk" ? { afterJournalChunk: crash } : {}),
    ...(seam === "fsync" ? { afterJournalFsync: crash } : {}),
    ...(seam === "checkpoint" ? { afterCheckpoint: crash } : {}),
    ...(seam === "outbox" ? { afterJob: crash } : {}),
  })).toThrow(`crash-${seam}`);
  expect((db.prepare("SELECT copied_byte_end n FROM journal_streams").get() as { n: number }).n).toBe(first.sourceThroughByte);
  expect((db.prepare("SELECT COUNT(*) n FROM checkpoints").get() as { n: number }).n).toBe(1);
  const retry = capture();
  expect(retry.sourceFromByte).toBe(first.sourceThroughByte);
  expect(hashFile(retry.journalPath)).toBe(hashFile(source));
  expect(capture().created).toBe(false);
});

it.each(["rewind", "replace"])("rejects source %s during streaming and retries from a new stream epoch", (mutation) => {
  writeSource(MiB);
  const first = capture();
  fs.appendFileSync(source, JSON.stringify({ payload: "x".repeat(2 * CAPTURE_CHUNK_BYTES) }) + "\n");
  let changed = false;
  expect(() => capture({ afterJournalChunk: () => {
    if (changed) return;
    changed = true;
    if (mutation === "replace") fs.renameSync(source, `${source}.old`);
    writeSource(MiB / 2);
  } })).toThrow("source transcript changed during capture");
  const next = capture();
  expect(next.streamEpoch).toBe(first.streamEpoch + 1);
  expect(next.sourceFromByte).toBe(0);
  expect(hashFile(next.journalPath)).toBe(hashFile(source));
});

it("verifies a large journal block in bounded chunks before ingestion", async () => {
  writeSource(64 * MiB + 1);
  capture();
  const allocations: number[] = [];
  const original = Buffer.alloc;
  vi.spyOn(Buffer, "alloc").mockImplementation(((size: number, ...rest: unknown[]) => {
    allocations.push(size);
    return Reflect.apply(original, Buffer, [size, ...rest]);
  }) as typeof Buffer.alloc);
  // Stop after hash verification and parsing, before embeddings/model work.
  const result = await runContinuityWorker(db, { maxJobs: 1, beforePrefixIngest: () => { throw new Error("verified prefix"); } });
  expect(result[0]).toMatchObject({ state: "retry", detail: "verified prefix" });
  expect(Math.max(...allocations)).toBeLessThanOrEqual(CAPTURE_CHUNK_BYTES);
}, 20_000);

it("indexes reused line positions in a replacement epoch without losing old evidence or rejecting the shorter replacement", async () => {
  const meta = { type: "session_meta", payload: { id: session, cwd: root } };
  const message = (role: string, text: string) => ({ type: "response_item", timestamp: new Date().toISOString(),
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  fs.writeFileSync(source, [meta, message("user", "original request"), message("assistant", "long prior context"),
    message("assistant", "more prior context")].map((row) => JSON.stringify(row)).join("\n") + "\n");
  capture();
  expect((await runContinuityWorker(db, { maxJobs: 1 }))[0].state).toBe("completed");
  const first = db.prepare("SELECT id, user_message FROM exchanges").get() as { id: string; user_message: string };
  fs.writeFileSync(source, [meta, message("user", "replacement request"), message("assistant", "short")]
    .map((row) => JSON.stringify(row)).join("\n") + "\n");
  expect(capture().streamEpoch).toBe(1);
  expect((await runContinuityWorker(db, { maxJobs: 1 }))[0].state).toBe("completed");
  const rows = db.prepare("SELECT id, user_message FROM exchanges ORDER BY rowid").all();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual(first);
  expect(rows[1]).toMatchObject({ user_message: "replacement request" });
  const evidence = db.prepare("SELECT payload_json FROM workstream_evidence ORDER BY seq").all() as Array<{ payload_json: string }>;
  expect(evidence.map((row) => JSON.parse(row.payload_json).human)).toEqual(["original request", "replacement request"]);
});
