import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/embeddings.js")>();
  const axisFor = new Map([
    ["React", 0],
    ["Router", 1],
    ["xyzabc123", 2],
    ["qwerty789", 3],
  ]);

  return {
    ...actual,
    initEmbeddings: vi.fn(async () => {}),
    generateEmbedding: vi.fn(async (text: string) => {
      const embedding = Array<number>(384).fill(0);
      embedding[axisFor.get(text) ?? 4] = 1;
      return embedding;
    }),
  };
});

import { initDatabase, insertExchange } from "../src/db.js";
import { getSearchDb, searchMultipleConcepts } from "../src/search.js";

const RELATED_ARCHIVE = "/fixtures/react-router.jsonl";
const originalDbEnv = {
  MEMEX_DB_PATH: process.env.MEMEX_DB_PATH,
  MEMORY_BANK_DB_PATH: process.env.MEMORY_BANK_DB_PATH,
  TEST_DB_PATH: process.env.TEST_DB_PATH,
};
let testDir: string | undefined;

describe("multi-concept search", () => {
  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "memex-multi-concept-"));
    // The current override has highest precedence, so this test cannot fall
    // through to a caller's live Memex DB even when historical env vars exist.
    process.env.MEMEX_DB_PATH = path.join(testDir, "test.db");

    const db = initDatabase();
    try {
      const insertFixture = (
        id: string,
        archivePath: string,
        vector: number[],
      ) => {
        insertExchange(
          db,
          {
            id,
            project: "/fixtures/project",
            timestamp: "2026-01-01T00:00:00.000Z",
            userMessage: `Fixture exchange ${id}`,
            assistantMessage: "Fixture response.",
            archivePath,
            lineStart: 1,
            lineEnd: 2,
          },
          vector,
        );
      };

      const relatedCentroid = Array<number>(384).fill(0);
      relatedCentroid[0] = Math.SQRT1_2;
      relatedCentroid[1] = Math.SQRT1_2;
      insertFixture("related-exchange", RELATED_ARCHIVE, relatedCentroid);

      // With limit=1 each concept overfetches five neighbours: four
      // concept-specific rows plus the shared centroid. Their intersection is
      // therefore exactly the shared conversation, exercising the AND logic.
      for (let index = 0; index < 4; index += 1) {
        const reactOnly = Array<number>(384).fill(0);
        reactOnly[0] = 1;
        insertFixture(
          `react-${index}`,
          `/fixtures/react-${index}.jsonl`,
          reactOnly,
        );

        const routerOnly = Array<number>(384).fill(0);
        routerOnly[1] = 1;
        insertFixture(
          `router-${index}`,
          `/fixtures/router-${index}.jsonl`,
          routerOnly,
        );
      }
    } finally {
      db.close();
    }
  });

  afterAll(() => {
    try {
      getSearchDb().close();
    } catch {
      /* search may not have opened */
    }
    for (const [name, value] of Object.entries(originalDbEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (testDir) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("finds only conversations represented in every concept result set", async () => {
    const results = await searchMultipleConcepts(["React", "Router"], {
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].exchange.archivePath).toBe(RELATED_ARCHIVE);

    const ranked = await searchMultipleConcepts(["React", "React"], {
      limit: 2,
    });
    expect(ranked).toHaveLength(2);
    expect(ranked[0].averageSimilarity).toBeGreaterThanOrEqual(
      ranked[1].averageSimilarity,
    );
  });

  it("scores unrelated concepts lower than related ones", async () => {
    const [unrelated, related] = await Promise.all([
      searchMultipleConcepts(["xyzabc123", "qwerty789"], { limit: 1 }),
      searchMultipleConcepts(["React", "Router"], { limit: 1 }),
    ]);

    expect(unrelated).toHaveLength(1);
    expect(related).toHaveLength(1);
    expect(unrelated[0].averageSimilarity).toBeLessThan(
      related[0].averageSimilarity,
    );
  });

  it("respects the limit parameter", async () => {
    const results = await searchMultipleConcepts(["React", "Router"], {
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });

  it("includes a similarity score for each concept", async () => {
    const results = await searchMultipleConcepts(["React", "Router"], {
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].conceptSimilarities).toHaveLength(2);
    expect(results[0].averageSimilarity).toBeTypeOf("number");
  });
});
