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
import { syncConversations } from "../src/sync.js";
import { initDatabase } from "../src/db.js";
import { repairIndex } from "../src/verify.js";
import {
  canonicalizeProjectPath,
  projectStorageKey,
} from "../src/project-identity.js";

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
          fkViolations: [],
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

describe("worker-prompt exclusion survives every ingestion path (재감사 P2-11)", () => {
  it("verify --repair indexes real exchanges but never re-indexes worker prompts", async () => {
    // repair의 인라인 루프는 한때 worker-prompt 필터 없이 전체를 재삽입했다 —
    // 이제 모든 진입점이 공용 ingestion SSOT을 거친다.
    const fixture = makeFixture();
    const file = fixture.file;
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: SESSION_ID, cwd: "/tmp/entrypoint-policy" },
        }),
        // 진짜 지식 exchange
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Which DB does the app use?" }] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Postgres" }] },
        }),
        // plugin worker prompt exchange — ephemeral state, never knowledge
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "You are an expert at extracting long-term facts from conversations.\n(extract)" }] },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "worker output" }] },
        }),
      ].join("\n") + "\n",
    );

    await repairIndex({
      missing: [{ path: file, reason: "No summary file" }],
      orphaned: [],
      outdated: [],
      corrupted: [],
      fkViolations: [],
    });

    const db = initDatabase();
    try {
      const rows = db.prepare("SELECT user_message FROM exchanges").all() as Array<{ user_message: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].user_message).toBe("Which DB does the app use?");
    } finally {
      db.close();
    }
  });
});

describe("same rollout excluded identically across sync and index entrypoints", () => {
  function countSummaries(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    return fs
      .readdirSync(dir, { recursive: true })
      .filter((entry) => String(entry).endsWith("-summary.txt"))
      .length;
  }

  it("sync, indexConversations, indexSession, and indexUnprocessed all exclude the identical rollout", async () => {
    // Each entrypoint gets a fresh home but byte-identical rollout content, so
    // any divergence in exclusion behavior is attributable to the entrypoint.
    const rolloutLines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: SESSION_ID, cwd: "/tmp/entrypoint-policy" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${MARKER}\n이 세션은 PostgreSQL 결정을 담고 있지만 색인하지 않는다.`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "PostgreSQL 결정을 확인했다." },
          ],
        },
      }),
    ].join("\n") + "\n";

    const outcomes: Record<
      string,
      { exchanges: number; vecExchanges: number; fts: number; summaries: number }
    > = {};

    for (const entry of [
      "sync",
      "indexConversations",
      "indexSession",
      "indexUnprocessed",
    ] as const) {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-exclusion-sameness-"));
      const sessions = path.join(tmp, "sessions");
      const archive = path.join(tmp, "archive");
      const dbPath = path.join(tmp, "db.sqlite");
      fs.mkdirSync(sessions, { recursive: true });
      fs.writeFileSync(
        path.join(sessions, `rollout-2026-08-28T00-00-00-${SESSION_ID}.jsonl`),
        rolloutLines,
      );
      process.env.TEST_SESSIONS_DIR = sessions;
      process.env.TEST_ARCHIVE_DIR = archive;
      process.env.MEMEX_DB_PATH = dbPath;
      try {
        if (entry === "sync") {
          await syncConversations(sessions, archive);
        } else if (entry === "indexConversations") {
          await indexConversations(undefined, undefined, 1, false);
        } else if (entry === "indexSession") {
          await indexSession(SESSION_ID, 1, false);
        } else {
          await indexUnprocessed(1, false);
        }

        const db = initDatabase();
        try {
          outcomes[entry] = {
            exchanges: (
              db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as {
                n: number;
              }
            ).n,
            vecExchanges: (
              db.prepare("SELECT COUNT(*) AS n FROM vec_exchanges").get() as {
                n: number;
              }
            ).n,
            fts: (
              db
                .prepare(
                  "SELECT COUNT(*) AS n FROM exchanges_fts WHERE exchanges_fts MATCH 'PostgreSQL'",
                )
                .get() as { n: number }
            ).n,
            summaries: countSummaries(archive),
          };
        } finally {
          db.close();
        }
      } finally {
        delete process.env.TEST_SESSIONS_DIR;
        delete process.env.TEST_ARCHIVE_DIR;
        delete process.env.MEMEX_DB_PATH;
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
        tmp = undefined;
      }
    }

    // Every entrypoint must produce the identical excluded outcome — no
    // exchange rows, no vectors, no FTS hits, no summaries.
    const values = Object.values(outcomes);
    expect(values).toHaveLength(4);
    expect(values[0]).toEqual({
      exchanges: 0,
      vecExchanges: 0,
      fts: 0,
      summaries: 0,
    });
    expect(values[1]).toEqual(values[0]);
    expect(values[2]).toEqual(values[0]);
    expect(values[3]).toEqual(values[0]);
  });
});

describe("indexUnprocessed archive-copy re-verification", () => {
  it("does not index a rollout whose archived copy carries the user marker", async () => {
    // The other entrypoints re-judge the archived copy before indexing it;
    // indexUnprocessed must do the same — an out-of-band archive replacement
    // must not smuggle content past the exclusion policy.
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-archive-swap-"));
    const sessions = path.join(tmp, "sessions");
    const archive = path.join(tmp, "archive");
    const dbPath = path.join(tmp, "db.sqlite");
    fs.mkdirSync(sessions, { recursive: true });
    // Clean source rollout — any exclusion must come from the archive copy.
    fs.writeFileSync(
      path.join(sessions, `rollout-2026-08-28T00-00-00-${SESSION_ID}.jsonl`),
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
            content: [
              { type: "input_text", text: "아카이브 스왑 방어 확인용 세션" },
            ],
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "확인했다." }],
          },
        }),
      ].join("\n") + "\n",
    );
    // Out-of-band archive copy carrying the marker, kept "newer" so the
    // archive keeps it instead of re-copying the clean source.
    const archiveDir = path.join(
      archive,
      projectStorageKey(canonicalizeProjectPath("/tmp/entrypoint-policy")),
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    const archiveCopy = path.join(
      archiveDir,
      `rollout-2026-08-28T00-00-00-${SESSION_ID}.jsonl`,
    );
    fs.writeFileSync(archiveCopy, [
      JSON.stringify({
        type: "session_meta",
        payload: { id: SESSION_ID, cwd: "/tmp/entrypoint-policy" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `${MARKER}\n이 대화는 인덱싱하지 마세요.`,
            },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "확인했다." }],
        },
      }),
    ].join("\n") + "\n");
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(archiveCopy, future, future);

    process.env.TEST_SESSIONS_DIR = sessions;
    process.env.TEST_ARCHIVE_DIR = archive;
    process.env.MEMEX_DB_PATH = dbPath;
    try {
      await indexUnprocessed(1, false);

      const db = initDatabase();
      try {
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM exchanges").get() as { n: number }).n,
        ).toBe(0);
        expect(
          (db.prepare("SELECT COUNT(*) AS n FROM vec_exchanges").get() as { n: number }).n,
        ).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      delete process.env.TEST_SESSIONS_DIR;
      delete process.env.TEST_ARCHIVE_DIR;
      delete process.env.MEMEX_DB_PATH;
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });
});
