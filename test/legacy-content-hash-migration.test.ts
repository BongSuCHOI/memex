import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import { initDatabase, insertExchange } from "../src/db.js";
import { refreshExchangeMetadata } from "../src/continuity-store.js";
import type { ToolCall } from "../src/types.js";

/**
 * Issue #169 (post-fix review) — upgrading must not re-process untouched history.
 *
 * 0.7.26 changed how `content_hash` is computed, which means every row a 0.7.25
 * `insertExchange` hashed with the OLD algorithm now disagrees with its own
 * recompute. `refreshExchangeMetadata` reads that disagreement as a content change
 * and bumps `content_generation` — so the v10 pass (and every
 * `ensureExtractionTarget`) would hand the pipeline a new generation of exchanges
 * nobody edited: evidence re-appended, extraction re-run.
 *
 * A hash-FORMAT change is not a content change. The refresh now recognises the
 * hashes the old writer could have left behind and rewrites them in place, leaving
 * the generation alone. Only a hash that matches neither the canonical value nor
 * any legacy variant is a real change.
 *
 * `legacyInsertHash` below is transcribed from the pre-0.7.26 source, so these
 * fixtures are the hashes real 0.7.25 rows actually carry.
 */

let root: string;
let dbPath: string;
let db: Database.Database;

/** The 0.7.25 `insertExchange` content hash, transcribed from that source. */
function legacyInsertHash(exchange: {
  userMessage: string;
  assistantMessage: string;
  lineEnd: number;
  toolCalls: Array<{
    id: string;
    toolName: string;
    toolInput?: unknown;
    toolResult?: string;
    isError: boolean;
  }>;
}): string {
  const tools = exchange.toolCalls
    .map((tool) => ({
      id: tool.id,
      name: tool.toolName,
      // The old writer hashed the IN-MEMORY value and stored NULL for it.
      input: tool.toolInput ?? null,
      result: tool.toolResult ?? null,
      error: tool.isError,
    }))
    // The old writer's order, which SQLite's BINARY collation disagrees with.
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(
      JSON.stringify({
        user: exchange.userMessage,
        assistant: exchange.assistantMessage,
        lineEnd: exchange.lineEnd,
        tools,
      }),
      "utf8",
    )
    .digest("hex");
}

const BASE = {
  userMessage: "Run the release gate",
  assistantMessage: "Gate is green",
  lineEnd: 2,
};

function toolCall(exchangeId: string, overrides: Partial<ToolCall> & { id: string }): ToolCall {
  return {
    exchangeId,
    toolName: "Bash",
    isError: false,
    timestamp: "2026-09-18T00:00:01.000Z",
    ...overrides,
  };
}

function insert(id: string, toolCalls: ToolCall[]): void {
  expect(
    insertExchange(
      db,
      {
        id,
        project: "/project",
        cwd: "/project",
        timestamp: "2026-09-18T00:00:00.000Z",
        userMessage: BASE.userMessage,
        assistantMessage: BASE.assistantMessage,
        archivePath: path.join(root, "rollout.jsonl"),
        lineStart: 1,
        lineEnd: BASE.lineEnd,
        sessionId: `session-${id}`,
        closureState: "closed",
        parserVersion: 2,
        toolCalls,
      },
      new Array(384).fill(0.1),
    ),
  ).toBe(true);
}

function metadataOf(id: string): { content_hash: string; content_generation: number } {
  return db
    .prepare("SELECT content_hash, content_generation FROM exchanges WHERE id = ?")
    .get(id) as { content_hash: string; content_generation: number };
}

function countEvidence(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM workstream_evidence").get() as { n: number }).n;
}

/** Put the row back the way a 0.7.25 writer left it: old hash, generation 1. */
function stampLegacyHash(id: string, hash: string): void {
  db.prepare("UPDATE exchanges SET content_hash = ? WHERE id = ?").run(hash, id);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-legacy-hash-"));
  dbPath = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "memex-home");
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

describe("a 0.7.25 content hash is a format change, not a content change (#169)", () => {
  const cases: Array<{ name: string; tools: (id: string) => ToolCall[] }> = [
    {
      name: "an empty tool_result the old writer hashed as \"\"",
      tools: (id) => [toolCall(id, { id: `${id}-t1`, toolInput: { command: "ls" }, toolResult: "" })],
    },
    {
      name: "an empty tool_input the old writer hashed as \"\"",
      tools: (id) => [toolCall(id, { id: `${id}-t1`, toolInput: "", toolResult: "ok" })],
    },
    {
      name: "a tool order only localeCompare produces",
      tools: (id) => [
        toolCall(id, { id: `${id}-a`, toolInput: { command: "ls" }, toolResult: "second" }),
        toolCall(id, { id: `${id}-B`, toolInput: { command: "pwd" }, toolResult: "first" }),
      ],
    },
    {
      name: "both at once — an empty result AND the old order",
      tools: (id) => [
        toolCall(id, { id: `${id}-a`, toolInput: { command: "ls" }, toolResult: "" }),
        toolCall(id, { id: `${id}-B`, toolInput: { command: "pwd" }, toolResult: "first" }),
      ],
    },
    {
      name: "a MIXED row — one tool's result empty, another's absent",
      // Not a uniform rendering of the row's NULLs: the repair has to consider
      // each stored NULL separately, which is why it enumerates them.
      tools: (id) => [
        toolCall(id, { id: `${id}-t1`, toolInput: { command: "ls" }, toolResult: "" }),
        toolCall(id, { id: `${id}-t2`, toolInput: { command: "pwd" }, toolResult: undefined }),
      ],
    },
  ];

  for (const { name, tools } of cases) {
    it(`rewrites the hash and leaves the generation alone — ${name}`, () => {
      const id = `ex-${name.replace(/[^a-z]+/gi, "-").slice(0, 40)}`;
      const toolCalls = tools(id);
      insert(id, toolCalls);
      const canonical = metadataOf(id);
      expect(canonical.content_generation).toBe(1);
      const evidenceBefore = countEvidence();

      const legacy = legacyInsertHash({ ...BASE, toolCalls });
      // The fixture is only meaningful if the old algorithm really disagreed.
      expect(legacy).not.toBe(canonical.content_hash);
      stampLegacyHash(id, legacy);

      refreshExchangeMetadata(db);

      expect(metadataOf(id)).toEqual({
        content_hash: canonical.content_hash,
        content_generation: 1,
      });
      // Nothing downstream may be re-opened by a format migration.
      expect(countEvidence()).toBe(evidenceBefore);

      // Idempotent, and the second pass has nothing left to migrate.
      refreshExchangeMetadata(db);
      refreshExchangeMetadata(db);
      expect(metadataOf(id)).toEqual({
        content_hash: canonical.content_hash,
        content_generation: 1,
      });
      expect(countEvidence()).toBe(evidenceBefore);
    });
  }

  it("still bumps the generation for a hash that is no legacy variant", () => {
    const id = "ex-real-change";
    const toolCalls = [toolCall(id, { id: `${id}-t1`, toolInput: { command: "ls" }, toolResult: "" })];
    insert(id, toolCalls);
    const canonical = metadataOf(id);

    // The old algorithm over DIFFERENT content: a real edit of the assistant turn,
    // which no rewrite may hide.
    const changed = legacyInsertHash({
      ...BASE,
      assistantMessage: "Gate is red",
      toolCalls,
    });
    expect(changed).not.toBe(canonical.content_hash);
    stampLegacyHash(id, changed);

    refreshExchangeMetadata(db);

    expect(metadataOf(id)).toEqual({
      content_hash: canonical.content_hash,
      content_generation: 2,
    });
  });

  it("a session-scoped refresh migrates the same way (ensureExtractionTarget's call)", () => {
    const id = "ex-session-scoped";
    const toolCalls = [toolCall(id, { id: `${id}-t1`, toolInput: { command: "ls" }, toolResult: "" })];
    insert(id, toolCalls);
    const canonical = metadataOf(id);
    stampLegacyHash(id, legacyInsertHash({ ...BASE, toolCalls }));

    refreshExchangeMetadata(db, `session-${id}`);

    expect(metadataOf(id)).toEqual({
      content_hash: canonical.content_hash,
      content_generation: 1,
    });
  });
});
