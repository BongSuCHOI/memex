import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { gradeHostOutput, rewriteDerivedPaths } = await import(
  pathToFileURL(path.join(ROOT, "scripts", "codex-memory-comparison.mjs")),
);

test("grades the last non-empty assistant message after compaction", () => {
  const fixture = {
    expected: { retryCount: 4 },
    forbiddenCurrentValues: [],
  };
  const compaction = {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"retryCount":4}' }] },
  };
  const finalQuery = {
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "" }] },
  };
  const graded = gradeHostOutput(`${JSON.stringify(compaction)}\n${JSON.stringify(finalQuery)}\n`, fixture);
  assert.equal(graded.status, "observed");
  assert.equal(graded.assistantMessages, 2);
  assert.equal(graded.expectedPass, true);
  assert.equal(graded.responseChars, 16);
});

test("rewrites every copied derived path and refreshes transcript identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-comparison-test-"));
  try {
    const fromRoot = path.join(root, "from");
    const oldMemex = path.join(fromRoot, "memex-home");
    const oldCodex = path.join(fromRoot, "codex-home");
    const memexHome = path.join(root, "to", "memex-home");
    const codexHome = path.join(root, "to", "codex-home");
    const oldArchive = path.join(oldMemex, "conversation-archive", "fixture.txt");
    const oldJournal = path.join(oldMemex, "conversation-index", "journal", "fixture.jsonl");
    const oldTranscript = path.join(oldCodex, "sessions", "fixture.jsonl");
    for (const [file, contents] of [[oldArchive, "archive"], [oldJournal, "journal"], [oldTranscript, "transcript"]]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
    }
    fs.cpSync(oldMemex, memexHome, { recursive: true });
    fs.cpSync(oldCodex, codexHome, { recursive: true });
    const transcript = path.join(codexHome, "sessions", "fixture.jsonl");
    const dbModule = await import(pathToFileURL(path.join(ROOT, "dist", "db.js")));
    const db = dbModule.initDatabase({ dbPath: path.join(memexHome, "conversation-index", "db.sqlite") });
    db.prepare("INSERT INTO exchanges (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), "/project", "2026-01-01T00:00:00Z", "u", "a", oldArchive, 1, 2);
    db.prepare("INSERT INTO journal_streams (session_id, stream_epoch, source_path, source_realpath, source_dev, source_ino, journal_path, created_at, updated_at, copied_byte_end, copied_line_end, journal_byte_end, prefix_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("fixture-session", 0, "stale-source", "stale-source", "1", "1", oldJournal, "now", "now", 7, 3, 9, "prefix");
    db.prepare("INSERT INTO capture_gaps (gap_id, session_id, source_path, event_kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("gap", "fixture-session", oldJournal, "final", "reason", "now");
    db.prepare("INSERT INTO conversation_exclusions (session_id, source_path, reason, excluded_at) VALUES (?, ?, ?, ?)")
      .run("fixture-session", oldArchive, "reason", "now");
    db.close();

    const rewritten = await rewriteDerivedPaths(codexHome, memexHome, fromRoot, "fixture-session", transcript);
    assert.equal(rewritten.status, "prepared");
    assert.deepEqual(rewritten.missing, []);
    assert.equal(rewritten.sourceUpdated, true);

    const check = dbModule.initDatabase({ dbPath: path.join(memexHome, "conversation-index", "db.sqlite") });
    const rows = [
      ...check.prepare("SELECT archive_path AS value FROM exchanges").all(),
      ...check.prepare("SELECT journal_path AS value, source_path, source_realpath FROM journal_streams").all(),
      ...check.prepare("SELECT source_path AS value FROM capture_gaps").all(),
      ...check.prepare("SELECT source_path AS value FROM conversation_exclusions").all(),
    ];
    const stream = check.prepare("SELECT source_path, source_realpath, source_dev, source_ino, source_mtime_ms, copied_byte_end, copied_line_end, journal_byte_end, prefix_hash FROM journal_streams WHERE session_id = ?").get("fixture-session");
    check.close();
    assert.ok(rows.every((row) => typeof row.value === "string" && fs.existsSync(row.value)));
    assert.ok(rows.every((row) => !row.value.startsWith(fromRoot)));
    const stat = fs.statSync(transcript);
    assert.equal(stream.source_path, transcript);
    assert.equal(stream.source_realpath, fs.realpathSync(transcript));
    assert.equal(String(stream.source_dev), String(stat.dev));
    assert.equal(String(stream.source_ino), String(stat.ino));
    assert.equal(Number(stream.source_mtime_ms), stat.mtimeMs);
    assert.deepEqual(
      [stream.copied_byte_end, stream.copied_line_end, stream.journal_byte_end, stream.prefix_hash],
      [7, 3, 9, "prefix"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
