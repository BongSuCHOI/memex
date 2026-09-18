import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

import { initDatabase, insertExchange } from "../src/db.js";
import {
  countStaleExchangeContentHashes,
  legacyContentHashes,
  LEGACY_RECONSTRUCTION_MAX_HASHES,
  refreshExchangeMetadata,
} from "../src/continuity-store.js";
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

/**
 * The 0.7.25 writer stored `tool_input = NULL` for ANY falsy input — `""` but also
 * the `0` and `false` the rollout parser really produces (`safeParseInput` returns
 * `JSON.parse("0")` / `JSON.parse("false")`, and its own type union says
 * `number | boolean`). The 0.7.26 writer stores `"0"` / `"false"` instead, so a
 * fixture for those rows has to put the NULL back by hand.
 */
function nullStoredToolInput(toolId: string): void {
  const changes = db
    .prepare("UPDATE tool_calls SET tool_input = NULL WHERE id = ?")
    .run(toolId).changes;
  expect(changes).toBe(1);
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
  const cases: Array<{
    name: string;
    tools: (id: string) => ToolCall[];
    /** Restore the 0.7.25 stored shape when the 0.7.26 writer keeps the value. */
    legacyStore?: (id: string) => void;
  }> = [
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
    {
      // Issue #169 (post-release review): these were excluded from the first
      // reconstruction as values "no transcript parser produces". The rollout
      // parser produces them — `safeParseInput` hands back `JSON.parse("0")`.
      name: "a tool_input of 0, which the old writer hashed as 0 and stored as NULL",
      tools: (id) => [toolCall(id, { id: `${id}-t1`, toolInput: 0, toolResult: "ok" })],
      legacyStore: (id) => nullStoredToolInput(`${id}-t1`),
    },
    {
      name: "a tool_input of false, hashed as false and stored as NULL",
      tools: (id) => [toolCall(id, { id: `${id}-t1`, toolInput: false, toolResult: "ok" })],
      legacyStore: (id) => nullStoredToolInput(`${id}-t1`),
    },
    {
      name: "a scalar input AND an empty result on the same tool",
      tools: (id) => [toolCall(id, { id: `${id}-t1`, toolInput: 0, toolResult: "" })],
      legacyStore: (id) => nullStoredToolInput(`${id}-t1`),
    },
    {
      // Issue #169 (second post-release review): the >limit fallback rendered
      // EVERY NULL with the same value, so a row whose legacy scalars differed
      // could not be reconstructed at all and took the bump anyway.
      name: "five NULL inputs with mixed legacy scalars",
      tools: (id) =>
        [0, false, "", 0, false].map((input, index) =>
          toolCall(id, { id: `${id}-t${index}`, toolInput: input, toolResult: "ok" })),
      legacyStore: (id) => {
        for (let index = 0; index < 5; index++) nullStoredToolInput(`${id}-t${index}`);
      },
    },
    {
      name: "seven NULL inputs with mixed legacy scalars",
      // Past the exhaustive product, so the tail is enumerated uniformly — with a
      // single tail column that is still exact.
      tools: (id) =>
        [0, false, "", 0, false, 0, false].map((input, index) =>
          toolCall(id, { id: `${id}-t${index}`, toolInput: input, toolResult: "ok" })),
      legacyStore: (id) => {
        for (let index = 0; index < 7; index++) nullStoredToolInput(`${id}-t${index}`);
      },
    },
    {
      name: "two tools with DIFFERENT falsy scalars — 0 on one, false on the other",
      // Per-column again: no single uniform rendering of the row's NULLs matches.
      tools: (id) => [
        toolCall(id, { id: `${id}-t1`, toolInput: 0, toolResult: "ok" }),
        toolCall(id, { id: `${id}-t2`, toolInput: false, toolResult: "ok" }),
      ],
      legacyStore: (id) => {
        nullStoredToolInput(`${id}-t1`);
        nullStoredToolInput(`${id}-t2`);
      },
    },
  ];

  for (const { name, tools, legacyStore } of cases) {
    it(`rewrites the hash and leaves the generation alone — ${name}`, () => {
      const id = `ex-${name.replace(/[^a-z]+/gi, "-").slice(0, 40)}`;
      const toolCalls = tools(id);
      insert(id, toolCalls);
      // A `legacyStore` case rewrites the STORED columns, so the hash
      // `insertExchange` just wrote no longer describes the row — which is exactly
      // the 0.7.25 state. Only a case that leaves the columns alone can compare
      // against it.
      const canonicalHash = legacyStore ? null : metadataOf(id).content_hash;
      legacyStore?.(id);
      expect(metadataOf(id).content_generation).toBe(1);
      const evidenceBefore = countEvidence();

      stampLegacyHash(id, legacyInsertHash({ ...BASE, toolCalls }));
      // The fixture is only meaningful if the stored hash really disagrees with
      // the stored row. Asked of production's own read-only check, so the guard
      // cannot drift from the thing it is guarding.
      expect(countStaleExchangeContentHashes(db)).toBe(1);

      refreshExchangeMetadata(db);

      const after = metadataOf(id);
      // The whole point: the hash moved, the generation did not.
      expect(after.content_generation).toBe(1);
      // And it moved to the CANONICAL value — the same check, now satisfied.
      expect(countStaleExchangeContentHashes(db)).toBe(0);
      if (canonicalHash) expect(after.content_hash).toBe(canonicalHash);
      // Nothing downstream may be re-opened by a format migration.
      expect(countEvidence()).toBe(evidenceBefore);

      // Idempotent, and the second pass has nothing left to migrate.
      refreshExchangeMetadata(db);
      refreshExchangeMetadata(db);
      expect(metadataOf(id)).toEqual(after);
      expect(countEvidence()).toBe(evidenceBefore);
    });
  }

  it("stays bounded, and states the limit it stops being exact at", () => {
    // The bound is a property of the reconstruction, so ask it directly rather
    // than inferring it from a refresh.
    const nullInputTools = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `t${index}`,
        toolName: "Bash",
        toolInput: null as string | null,
        toolResult: "ok" as string | null,
        isError: false,
      }));

    for (const count of [6, 7, 8, 12]) {
      const hashes = legacyContentHashes({ ...BASE, tools: nullInputTools(count) });
      expect(hashes.size).toBeLessThanOrEqual(LEGACY_RECONSTRUCTION_MAX_HASHES);
      expect(hashes.size).toBeGreaterThan(0);
    }

    // What a six-column mixed row costs, measured rather than assumed.
    const started = Date.now();
    legacyContentHashes({ ...BASE, tools: nullInputTools(6) });
    const elapsedMs = Date.now() - started;
    // Generous: the assertion is that it is bounded work, not a benchmark.
    expect(elapsedMs).toBeLessThan(5_000);
    console.error(`[measure] six mixed NULL columns reconstructed in ${elapsedMs} ms`);
  });

  it("documents the residual limitation: a 2+ column tail with DIFFERENT values", () => {
    // Eight NULL inputs, and the two past the exhaustive head disagree. The tail
    // is rendered uniformly, so this row is NOT reconstructed and takes one bump —
    // the pre-fix behaviour, once, for a shape no real transcript produces.
    const id = "ex-eight-mixed-tail";
    const values: unknown[] = [0, false, "", 0, false, 0, false, 0];
    const toolCalls = values.map((input, index) =>
      toolCall(id, { id: `${id}-t${index}`, toolInput: input, toolResult: "ok" }));
    insert(id, toolCalls);
    for (let index = 0; index < values.length; index++) {
      nullStoredToolInput(`${id}-t${index}`);
    }
    stampLegacyHash(id, legacyInsertHash({ ...BASE, toolCalls }));
    expect(countStaleExchangeContentHashes(db)).toBe(1);

    refreshExchangeMetadata(db);

    // Bumped once, then stable: the row is not re-processed again and again.
    expect(metadataOf(id).content_generation).toBe(2);
    expect(countStaleExchangeContentHashes(db)).toBe(0);
    refreshExchangeMetadata(db);
    expect(metadataOf(id).content_generation).toBe(2);
  });

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
