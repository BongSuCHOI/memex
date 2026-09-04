#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { initDatabase } from "../dist/db.js";
import { captureTranscriptPrefix } from "../dist/continuity-core.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-continuity-bench-"));
const sessions = path.join(root, "sessions");
const transcript = path.join(sessions, "rollout-benchmark.jsonl");
const sessionId = "continuity-benchmark-session";
fs.mkdirSync(sessions, { recursive: true });
fs.writeFileSync(transcript, `${JSON.stringify({
  type: "session_meta",
  payload: { id: sessionId, cwd: "/benchmark" },
})}\n`);
process.env.MEMEX_HOME = path.join(root, "home");
process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
process.env.MEMEX_ALLOWED_TRANSCRIPT_ROOTS = sessions;

const db = initDatabase();
try {
  const latencies = [];
  let appendedBytes = 0;
  let journalPath = "";
  for (let index = 1; index <= 200; index++) {
    fs.appendFileSync(transcript, `${JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `turn-${index}` }] },
    })}\n${JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `done-${index}` }] },
    })}\n`);
    const started = performance.now();
    const result = captureTranscriptPrefix(db, {
      sessionId,
      project: "/benchmark",
      transcriptPath: transcript,
      kind: "stop",
      turnId: `turn-${index}`,
    });
    latencies.push(performance.now() - started);
    appendedBytes += result.appendedBytes;
    journalPath = result.journalPath;
  }
  latencies.sort((a, b) => a - b);
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];
  const sourceBytes = fs.statSync(transcript).size;
  const report = {
    turns: 200,
    sourceBytes,
    appendedBytes,
    journalBytes: fs.statSync(journalPath).size,
    fullCopyAmplification: appendedBytes / sourceBytes,
    hookLatencyMs: {
      p50: Number(percentile(0.50).toFixed(3)),
      p95: Number(percentile(0.95).toFixed(3)),
      max: Number(latencies.at(-1).toFixed(3)),
    },
    checkpoints: db.prepare("SELECT COUNT(*) AS n FROM checkpoints").get().n,
    capsuleJobs: db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE kind = 'capsule_update'").get().n,
    captureGaps: db.prepare("SELECT COUNT(*) AS n FROM capture_gaps").get().n,
  };
  if (report.appendedBytes !== report.sourceBytes || report.journalBytes !== report.sourceBytes) {
    throw new Error(`incremental byte accounting mismatch: ${JSON.stringify(report)}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
