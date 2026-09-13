/**
 * The language clause has to reach the MODEL, not just a unit test (#123).
 *
 * `test/extraction-language.test.ts` pins detection and the clause string. This
 * suite pins the wiring: a real `runFactExtraction` claim, the scripted provider
 * from the overlay fixture, and an assertion on the system prompt the extraction
 * stage actually received. Every revision of this feature that composed the
 * prompt once per SESSION instead of once per window passed the unit tests and
 * failed here.
 *
 * It also pins the receipt, because a language nobody can read back afterwards
 * is not an answer to "why is this fact in English".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/codex-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/codex-exec.js")>();
  const { codexMock } = await import("./extraction-rules-fixture.js");
  return { ...actual, ...codexMock(actual) };
});
vi.mock("../src/embeddings.js", async (io) => ({
  ...(await io<typeof import("../src/embeddings.js")>()),
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.01),
}));
vi.mock("../src/ontology-classifier.js", async (io) => ({
  ...(await io<typeof import("../src/ontology-classifier.js")>()),
  classifyAndLinkFact: async () => {},
}));

import { initDatabase } from "../src/db.js";
import { runFactExtraction } from "../src/fact-extractor.js";
import { resetExtractionRulesCache } from "../src/extraction-rules.js";
import {
  PROJECT,
  SESSION,
  factCandidate,
  pinOverlayEnv,
  resetScript,
  restoreOverlayEnv,
  script,
  seedExchanges,
  writeRules,
} from "./extraction-rules-fixture.js";

/** 13 Hangul against 15 Latin: Korean only once the syllables are weighted. */
const KO = "Flutter 상태관리는 Riverpod으로 결정했습니다.";
const EN = "We decided to use Riverpod for state management in this project.";

let root: string;
let db: Database.Database;

/** Only the extraction-stage prompts; the verifier has its own, untouched one. */
function extractPrompts(): string[] {
  return script.systemPrompts.filter((prompt) => !prompt.includes("authoritative-entailment-v3"));
}

function factLanguage(): string | null {
  const row = db
    .prepare("SELECT fact_language FROM extraction_targets ORDER BY rowid DESC LIMIT 1")
    .get() as { fact_language: string | null } | undefined;
  return row?.fact_language ?? null;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-fact-language-"));
  pinOverlayEnv(root);
  process.env.MEMEX_DB_PATH = path.join(root, "db.sqlite");
  process.env.MEMEX_EMBEDDING_STUB = "1";
  process.env.MEMEX_LLM_RETRY_BASE_MS = "0";
  process.env.MEMEX_CODEX_MODEL = "test-model";
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetExtractionRulesCache();
  resetScript();
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  db = initDatabase();
});

afterEach(async () => {
  try { db.close(); } catch { /* already closed */ }
  const { invalidateModelSettingsCache } = await import("../src/model-settings.js");
  invalidateModelSettingsCache();
  restoreOverlayEnv();
  delete process.env.MEMEX_DB_PATH;
  delete process.env.MEMEX_EMBEDDING_STUB;
  delete process.env.MEMEX_LLM_RETRY_BASE_MS;
  delete process.env.MEMEX_CODEX_MODEL;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the extraction call carries the window's language (#123)", () => {
  it("sends the Korean clause for a Korean window, with no overlay at all", async () => {
    seedExchanges(db, { userMessage: KO });
    resetScript([factCandidate("Riverpod으로 상태관리를 한다", "Riverpod")]);

    const result = await runFactExtraction(db, SESSION, PROJECT);

    expect(result.skipped).toBeUndefined();
    const prompts = extractPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("## Fact language");
      expect(prompt).toContain(
        "Write `fact` (and subject_key stays snake_case ASCII) in Korean; " +
          "keep code identifiers, paths and product names verbatim.",
      );
      // No rules file exists, so the overlay block must not be there.
      expect(prompt).not.toContain("## User rule overlay");
    }
    expect(factLanguage()).toBe("ko");
  });

  it("sends the English clause for an English window", async () => {
    seedExchanges(db, { userMessage: EN });
    resetScript([factCandidate("Riverpod is used for state management", "Riverpod")]);

    await runFactExtraction(db, SESSION, PROJECT);

    for (const prompt of extractPrompts()) {
      expect(prompt).toContain(
        "Write `fact` (and subject_key stays snake_case ASCII) in English; " +
          "keep code identifiers, paths and product names verbatim.",
      );
    }
    expect(factLanguage()).toBe("en");
  });

  it("preferred_language WINS over the detected Korean window", async () => {
    writeRules(root, {
      schema: "memex.extraction-rules-overlay",
      version: 1,
      revision: 1,
      preferred_language: "en",
    });
    seedExchanges(db, { userMessage: KO });
    resetScript([factCandidate("Riverpod is used for state management", "Riverpod")]);

    await runFactExtraction(db, SESSION, PROJECT);

    const prompts = extractPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain("(and subject_key stays snake_case ASCII) in English;");
      expect(prompt).not.toContain("in Korean;");
    }
    expect(factLanguage()).toBe("en");
  });

  it("appends nothing when the window decides nothing", async () => {
    // Human turns with no Hangul and no Latin letters: nothing to count, so no
    // clause, so the prompt is exactly the one this extractor sent before #123.
    seedExchanges(db, { userMessage: "### 1) 2) 3) — 42 / 43 / 44 ###" });
    resetScript([]);

    await runFactExtraction(db, SESSION, PROJECT);

    for (const prompt of extractPrompts()) {
      expect(prompt).not.toContain("## Fact language");
    }
    expect(factLanguage()).toBeNull();
  });
});
