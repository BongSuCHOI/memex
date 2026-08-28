import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Repair touches embeddings (vector insert) and the summarizer (LLM call).
// Mock both so the regression test exercises only the project-identity
// derivation and the index/summary plumbing.
vi.mock("../src/embeddings.js", async () => {
  return {
    initEmbeddings: async () => {},
    generateExchangeEmbedding: async () =>
      Array.from({ length: 384 }, () => 0.01),
    generateEmbedding: async () => Array.from({ length: 384 }, () => 0.01),
    EMBEDDING_VERSION: 999,
    initEmbeddingsIfNeeded: async () => {},
  };
});
vi.mock("../src/summarizer.js", async () => {
  return {
    summarizeConversation: async () => "repair test summary",
  };
});

import { repairIndex } from "../src/verify.js";
import { initDatabase } from "../src/db.js";

let testDir: string | undefined;
const origDbPath = process.env.MEMEX_DB_PATH;

function rolloutTimestamp(minute: number): string {
  return `2026-08-28T00:${String(minute).padStart(2, "0")}:00.000Z`;
}

function buildRollout(opts: { cwd: string; subagent?: boolean }): string {
  const payload: Record<string, unknown> = {
    id: "01a0test0001",
    cwd: opts.cwd,
    cli_version: "0.149.0",
  };
  if (opts.subagent) {
    payload.parent_thread_id = "01a0parent0001";
  }
  const lines = [
    JSON.stringify({
      timestamp: rolloutTimestamp(0),
      type: "session_meta",
      payload,
    }),
    JSON.stringify({
      timestamp: rolloutTimestamp(1),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          {
            type: "text",
            text: "프로젝트 x에서 SQLite를 사용하기로 결정했다.",
          },
        ],
      },
    }),
    JSON.stringify({
      timestamp: rolloutTimestamp(2),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "SQLite 도입을 진행했습니다." }],
      },
    }),
  ];
  return lines.join("\n") + "\n";
}

describe("repairIndex project identity", () => {
  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-repair-identity-"));
    process.env.MEMEX_DB_PATH = path.join(testDir, "test.db");
  });

  afterAll(() => {
    if (origDbPath === undefined) delete process.env.MEMEX_DB_PATH;
    else process.env.MEMEX_DB_PATH = origDbPath;
    if (testDir) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("re-indexes with the canonical cwd, not the archive storage key", async () => {
    const canonical = path.join(testDir!, "canonical-proj-x");
    // The archive folder mimics the real storage-key shape: basename + hash
    // suffix. It MUST never become the project identity.
    const archiveDir = path.join(testDir!, "archive", "project-x--abc123def");
    fs.mkdirSync(archiveDir, { recursive: true });
    const file = path.join(
      archiveDir,
      "rollout-2026-08-28T00-00-00-01a0test0001.jsonl",
    );
    fs.writeFileSync(file, buildRollout({ cwd: canonical }));

    await repairIndex({
      missing: [{ path: file, reason: "no summary" }],
      orphaned: [],
      outdated: [],
      corrupted: [],
    });

    const db = initDatabase();
    try {
      const rows = db
        .prepare("SELECT DISTINCT project, cwd FROM exchanges")
        .all() as Array<{ project: string; cwd: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].project).toBe(canonical);
      expect(rows[0].cwd).toBe(canonical);
      expect(rows[0].project).not.toBe("project-x--abc123def");
    } finally {
      db.close();
    }

    // Summary sidecar generated next to the archived rollout.
    expect(fs.existsSync(file.replace(".jsonl", "-summary.txt"))).toBe(true);
  });

  it("skips subagent threads like sync does", async () => {
    const canonical = path.join(testDir!, "canonical-subagent-proj");
    const archiveDir = path.join(testDir!, "archive", "sub-proj--def456");
    fs.mkdirSync(archiveDir, { recursive: true });
    const file = path.join(
      archiveDir,
      "rollout-2026-08-28T01-00-00-01a0test0002.jsonl",
    );
    fs.writeFileSync(file, buildRollout({ cwd: canonical, subagent: true }));

    await repairIndex({
      missing: [{ path: file, reason: "no summary" }],
      orphaned: [],
      outdated: [],
      corrupted: [],
    });

    const db = initDatabase();
    try {
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM exchanges WHERE project = ?")
        .get(canonical) as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      db.close();
    }
    expect(fs.existsSync(file.replace(".jsonl", "-summary.txt"))).toBe(false);
  });
});
