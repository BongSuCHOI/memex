import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import { initDatabase, insertExchange } from "../src/db.js";
import { refreshExchangeMetadata } from "../src/continuity-store.js";
import type { ToolCall } from "../src/types.js";

/**
 * Issue #169 — `content_hash` must be a function of the STORED row, not of the
 * in-memory exchange the writer happened to be handed.
 *
 * `insertExchange` hashes the exchange object and then stores a NORMALIZED tool
 * call: an empty `tool_result` and a falsy `tool_input` become SQL NULL. Every
 * later reader of the hash — `refreshExchangeMetadata`, which runs in the
 * migration pass and on every `ensureExtractionTarget` — recomputes it from
 * those stored columns. If the two disagree the recompute bumps
 * `content_generation`, and the exchange is re-processed as new content (evidence
 * re-appended, extraction re-run) although nothing changed.
 *
 * The test is deliberately table-driven over the falsy shapes a real transcript
 * produces: a tool that returned nothing, an input-less tool, an explicit null.
 */

const ROOT_PREFIX = "memex-content-hash-";

let root: string;
let home: string;
let dbPath: string;
let db: Database.Database;

function toolCall(exchangeId: string, overrides: Partial<ToolCall>): ToolCall {
  return {
    id: `${exchangeId}-tool-1`,
    exchangeId,
    toolName: "Bash",
    isError: false,
    timestamp: "2026-09-18T00:00:01.000Z",
    ...overrides,
  };
}

function insert(id: string, toolCalls: ToolCall[]): void {
  const inserted = insertExchange(
    db,
    {
      id,
      project: "/project",
      cwd: "/project",
      timestamp: "2026-09-18T00:00:00.000Z",
      userMessage: "Run the gate",
      assistantMessage: "Gate is green",
      archivePath: path.join(root, "rollout.jsonl"),
      lineStart: 1,
      lineEnd: 2,
      sessionId: `session-${id}`,
      closureState: "closed",
      parserVersion: 2,
      toolCalls,
    },
    new Array(384).fill(0.1),
  );
  expect(inserted).toBe(true);
}

function metadataOf(id: string): { content_hash: string; content_generation: number } {
  return db
    .prepare("SELECT content_hash, content_generation FROM exchanges WHERE id = ?")
    .get(id) as { content_hash: string; content_generation: number };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  home = path.join(root, "memex-home");
  dbPath = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = home;
  process.env.MEMEX_DB_PATH = dbPath;
  process.env.MEMEX_EMBEDDING_STUB = "1";
  delete process.env.MEMEX_SYNC_DIR;
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("insertExchange hashes the stored representation (issue #169)", () => {
  const cases: Array<{ name: string; overrides: Partial<ToolCall> }> = [
    { name: "empty tool_result", overrides: { toolResult: "", toolInput: { command: "ls" } } },
    { name: "undefined tool_input", overrides: { toolResult: "ok", toolInput: undefined } },
    { name: "null tool_input", overrides: { toolResult: "ok", toolInput: null } },
    { name: "empty-string tool_input", overrides: { toolResult: "ok", toolInput: "" } },
    { name: "empty result and no input", overrides: { toolResult: "", toolInput: undefined } },
  ];

  for (const { name, overrides } of cases) {
    it(`refresh after insert changes nothing — ${name}`, () => {
      const id = `ex-${name.replace(/[^a-z]+/gi, "-")}`;
      insert(id, [toolCall(id, overrides)]);
      const before = metadataOf(id);
      expect(before.content_hash).toBeTruthy();

      // The migration pass and every ensureExtractionTarget run this.
      refreshExchangeMetadata(db);
      expect(metadataOf(id)).toEqual(before);

      // Idempotent under repetition too: before 0.7.24 this ran on every open.
      refreshExchangeMetadata(db);
      refreshExchangeMetadata(db);
      expect(metadataOf(id)).toEqual(before);
    });
  }

  it("tool order is the stored order — SQLite BINARY, not localeCompare", () => {
    // `insertExchange` sorted with `localeCompare` while the recompute read
    // `ORDER BY id` (BINARY collation). The two disagree on case, so these two
    // ids alone produced two different hashes for one unchanged row.
    const id = "ex-tool-order";
    insert(id, [
      { ...toolCall(id, { toolResult: "second" }), id: `${id}-a` },
      { ...toolCall(id, { toolResult: "first" }), id: `${id}-B` },
    ]);
    const before = metadataOf(id);
    refreshExchangeMetadata(db);
    expect(metadataOf(id)).toEqual(before);
  });

  it("a re-insert of identical content keeps the generation it already had", () => {
    const id = "ex-reinsert";
    const calls = [toolCall(id, { toolResult: "", toolInput: undefined })];
    insert(id, calls);
    const before = metadataOf(id);
    insert(id, calls);
    expect(metadataOf(id)).toEqual(before);
  });
});
