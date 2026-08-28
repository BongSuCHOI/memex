import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/embeddings.js", async () => ({
  initEmbeddings: async () => {},
  generateExchangeEmbedding: async () =>
    Array.from({ length: 384 }, () => 0.01),
  generateEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
  EMBEDDING_VERSION: 999,
}));
vi.mock("../src/summarizer.js", async () => ({
  summarizeConversation: async () => "must not be generated",
}));

import {
  indexConversations,
  indexSession,
  indexUnprocessed,
} from "../src/indexer.js";
import { initDatabase } from "../src/db.js";
import { repairIndex } from "../src/verify.js";

const SESSION_ID = "01a00005-aaaa-4bbb-8ccc-ccccccccccc5";
const MARKER =
  "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>";
let tmp: string | undefined;

function makeFixture(): {
  sessions: string;
  archive: string;
  dbPath: string;
  file: string;
} {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-entrypoint-policy-"));
  const sessions = path.join(tmp, "sessions");
  const archive = path.join(tmp, "archive");
  const dbPath = path.join(tmp, "db.sqlite");
  fs.mkdirSync(sessions, { recursive: true });
  const file = path.join(
    sessions,
    `rollout-2026-08-28T00-00-00-${SESSION_ID}.jsonl`,
  );
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: SESSION_ID, cwd: "/tmp/entrypoint-policy" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${MARKER}\n제외` }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "확인" }],
        },
      }),
    ].join("\n") + "\n",
  );
  process.env.TEST_SESSIONS_DIR = sessions;
  process.env.TEST_ARCHIVE_DIR = archive;
  process.env.MEMEX_DB_PATH = dbPath;
  return { sessions, archive, dbPath, file };
}

afterEach(() => {
  delete process.env.TEST_SESSIONS_DIR;
  delete process.env.TEST_ARCHIVE_DIR;
  delete process.env.MEMEX_DB_PATH;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("conversation exclusion policy across index entrypoints", () => {
  const cases: Array<[
    string,
    (fixture: ReturnType<typeof makeFixture>) => Promise<void>,
  ]> = [
    ["indexConversations", () => indexConversations(undefined, undefined, 1, false)],
    ["indexSession", () => indexSession(SESSION_ID, 1, false)],
    ["indexUnprocessed", () => indexUnprocessed(1, false)],
    [
      "repairIndex",
      ({ file }) =>
        repairIndex({
          missing: [{ path: file, reason: "No summary file" }],
          orphaned: [],
          outdated: [],
          corrupted: [],
        }),
    ],
  ];

  it.each(cases)("%s neither indexes nor summarizes a user-excluded rollout", async (_name, run) => {
    const fixture = makeFixture();
    await run(fixture);

    const db = initDatabase();
    try {
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number })
          .n,
      ).toBe(0);
    } finally {
      db.close();
    }
    const summaries = fs.existsSync(fixture.archive)
      ? fs
          .readdirSync(fixture.archive, { recursive: true })
          .filter((entry) => String(entry).endsWith("-summary.txt"))
      : [];
    expect(summaries).toHaveLength(0);
  });
});
