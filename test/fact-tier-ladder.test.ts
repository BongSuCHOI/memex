/**
 * 0.6.0 promotion ladder (#19).
 *
 * Reproduces the observed v0.5.2 state: the only promotion API was
 * `assignFactSubject` (core-internal, evidence-required), `grep promote
 * cli/memex.js` returned nothing, and no automatic promotion or demotion
 * existed at all — a fact's tier was decided once at extraction and never
 * moved again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";

vi.mock("../src/embeddings.js", () => ({
  EMBEDDING_VERSION: 2,
  initEmbeddings: async () => {},
  generateEmbedding: async () => new Array(384).fill(0.1),
}));

import { initDatabase, insertExchange } from "../src/db.js";
import { insertFact } from "../src/fact-db.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";
import { EXTRACTION_SYSTEM_PROMPT, saveExtractedFacts } from "../src/fact-extractor.js";
import {
  TierStepError,
  applyScopeDirective,
  demoteFact,
  promoteFact,
  readFactTier,
  reconcileFactTiers,
} from "../src/fact-management.js";
import type { ConversationExchange } from "../src/types.js";

const emb = new Array(384).fill(0.1);
let root: string;
let db: Database.Database;

function gitClone(dir: string, branch: string): void {
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, ".git", "config"), '[remote "origin"]\n\turl = git@example.test:t/r.git\n');
}

function exchange(id: string, sessionId: string, cwd: string, userMessage: string): ConversationExchange {
  return {
    id, project: cwd, cwd, timestamp: "2026-09-03T00:00:00.000Z",
    userMessage, assistantMessage: "context only",
    archivePath: path.join(root, `${sessionId}.jsonl`),
    lineStart: 1, lineEnd: 2, sessionId, closureState: "closed", parserVersion: 2,
  };
}

/** A branch-tier fact in `project`, the rung the ladder starts from. */
async function branchFact(
  name: string,
  project: string,
  subjectKey: string,
  text = `Branch truth ${name}`,
): Promise<string> {
  const state = ensureSessionMemoryState(db, { sessionId: `s-${name}`, project });
  await insertExchange(db, exchange(`ex-${name}`, `s-${name}`, project, text), emb);
  return insertFact(db, {
    fact: text, category: "knowledge", scope_type: "project", scope_project: project,
    source_exchange_ids: [`ex-${name}`], embedding: emb, subject_key: subjectKey,
    project_id: state.projectId, workspace_id: state.workspaceId,
    workstream_id: state.workstreamId,
    promotion_state: "workstream", promotion_evidence: "experimental",
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-tier-ladder-"));
  process.env.TEST_DB_PATH = path.join(root, "memex.sqlite");
  process.env.MEMEX_HOME = path.join(root, "home");
  db = initDatabase();
});

afterEach(() => {
  db.close();
  delete process.env.TEST_DB_PATH;
  delete process.env.MEMEX_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("user promotion and demotion (#19)", () => {
  it("moves one rung at a time and records PROMOTED with from/to tier, actor and reason", async () => {
    const project = path.join(root, "ladder");
    gitClone(project, "feature/a");
    const id = await branchFact("user-promote", project, "state.runtime.store");
    expect(readFactTier(db, id).tier).toBe("workstream");

    const up = promoteFact(db, id, { actor: "user", reason: "team agreed", evidence: ["ex-user-promote"] });
    expect(up).toMatchObject({ from: "workstream", to: "project" });
    expect(up.steps).toHaveLength(1);
    expect(readFactTier(db, id)).toMatchObject({ tier: "project", promotionState: "project-current", workstreamId: null });

    const event = db.prepare(
      "SELECT event_kind, actor, rationale, outcome_json, projection_applied FROM fact_revisions WHERE id = ?",
    ).get(up.steps[0].eventId) as Record<string, unknown>;
    expect(event.event_kind).toBe("PROMOTED");
    expect(event.actor).toBe("user");
    expect(event.rationale).toBe("team agreed");
    expect(Number(event.projection_applied)).toBe(1);
    expect(JSON.parse(String(event.outcome_json))).toMatchObject({
      from_tier: "workstream", to_tier: "project", actor: "user",
      reason: "team agreed", evidence_ids: ["ex-user-promote"],
    });

    const toGlobal = promoteFact(db, id, { actor: "user", reason: "applies everywhere" });
    expect(toGlobal).toMatchObject({ from: "project", to: "global" });
    expect(readFactTier(db, id)).toMatchObject({ tier: "global", scopeType: "global", projectId: null });
  });

  it("refuses a skipped rung with TierStepError and leaves the fact untouched", async () => {
    const project = path.join(root, "skip");
    gitClone(project, "feature/a");
    const id = await branchFact("skip", project, "state.runtime.skip");
    expect(() => promoteFact(db, id, { actor: "user", to: "global" })).toThrow(TierStepError);
    expect(() => demoteFact(db, id, { actor: "user", to: "global" })).toThrow(TierStepError);
    expect(readFactTier(db, id).tier).toBe("workstream");
  });

  it("brings a global fact back to its origin project and then to its branch", async () => {
    const project = path.join(root, "down");
    gitClone(project, "feature/a");
    const id = await branchFact("down", project, "state.runtime.down");
    const stream = readFactTier(db, id).workstreamId;
    promoteFact(db, id, { actor: "user" });
    promoteFact(db, id, { actor: "user" });
    expect(readFactTier(db, id).tier).toBe("global");

    const back = demoteFact(db, id, { actor: "user", reason: "only this project" });
    expect(back).toMatchObject({ from: "global", to: "project" });
    expect(readFactTier(db, id).projectId).toBeTruthy();
    const toBranch = demoteFact(db, id, { actor: "user", workstreamId: stream });
    expect(toBranch).toMatchObject({ from: "project", to: "workstream" });
    expect(readFactTier(db, id).workstreamId).toBe(stream);
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ? AND event_kind = 'DEMOTED'",
    ).get(id) as { n: number }).n).toBe(2);
  });

  it("writes a metadata-only ui-audit line for a user action", async () => {
    const project = path.join(root, "audit");
    gitClone(project, "feature/a");
    const id = await branchFact("audit", project, "state.runtime.audit");
    promoteFact(db, id, { actor: "user", reason: "explicit" });
    const line = fs.readFileSync(path.join(root, "home", "logs", "ui-audit.jsonl"), "utf8").trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry).toMatchObject({ action: "fact.promote", status: "ok", id });
    expect(Object.keys(entry)).not.toContain("fact");
  });

  it("does not audit an automatic move", async () => {
    const project = path.join(root, "auto-audit");
    gitClone(project, "feature/a");
    const id = await branchFact("auto-audit", project, "state.runtime.auto");
    promoteFact(db, id, { actor: "auto", reason: "evidence" });
    expect(fs.existsSync(path.join(root, "home", "logs", "ui-audit.jsonl"))).toBe(false);
  });
});

describe("in-session scope directive (#19)", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, "fixtures", "fact-scope-directive-cases.json"), "utf8",
  )) as {
    cases: Array<{
      id: string; tags: string[];
      exchanges: Array<{ id: string; user_message: string }>;
      expected: { facts: Array<{ scope_directive: string | null; resulting_tier: string; expected_steps?: string[] }> };
    }>;
  };

  it("teaches the extraction prompt to recognise KR and EN directives", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("scope_directive");
    for (const phrase of [
      "let's remember this for the whole project",
      "make this a global memory",
      "keep this decision to this branch only",
      "이건 프로젝트 공용으로 기억하자",
      "이건 글로벌 기억으로",
      "이 결정은 이 브랜치에서만",
    ]) {
      expect(EXTRACTION_SYSTEM_PROMPT).toContain(phrase);
    }
  });

  it("has both KR and EN cases for every rung plus explicit negatives", () => {
    const tags = new Set(fixture.cases.flatMap((c) => c.tags));
    for (const tag of ["kr", "en", "workstream", "project", "global", "negative", "two_step"]) {
      expect(tags).toContain(tag);
    }
    expect(fixture.cases.filter((c) => c.tags.includes("negative"))
      .every((c) => c.expected.facts.every((f) => f.scope_directive === null))).toBe(true);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))(
    "places %s at the directed tier",
    async (id, testCase) => {
      const project = path.join(root, `dir-${id}`);
      gitClone(project, "feature/directive");
      const state = ensureSessionMemoryState(db, { sessionId: `sess-${id}`, project });
      await insertExchange(db, exchange(testCase.exchanges[0].id, `sess-${id}`, project,
        testCase.exchanges[0].user_message), emb);
      const expected = testCase.expected.facts[0];
      const factId = insertFact(db, {
        fact: testCase.exchanges[0].user_message, category: "knowledge", scope_type: "project",
        scope_project: project, source_exchange_ids: [testCase.exchanges[0].id], embedding: emb,
        subject_key: `state.directive.${id.replace(/-/g, "_")}`,
        project_id: state.projectId, workspace_id: state.workspaceId,
        workstream_id: state.workstreamId,
        promotion_state: "workstream", promotion_evidence: "experimental",
      });
      const move = expected.scope_directive
        ? applyScopeDirective(db, factId, expected.scope_directive as never, {
            evidence: [testCase.exchanges[0].id],
          })
        : null;
      expect(readFactTier(db, factId).tier).toBe(expected.resulting_tier);
      if (expected.expected_steps) {
        // A two-rung directive runs in ONE transaction but leaves two events.
        expect(move?.steps.map((s) => `${s.from}->${s.to}`)).toEqual(expected.expected_steps);
        const events = db.prepare(
          "SELECT actor, outcome_json FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED' ORDER BY chronicle_seq",
        ).all(factId) as Array<{ actor: string; outcome_json: string }>;
        expect(events).toHaveLength(2);
        expect(events.every((e) => e.actor === "user-directive")).toBe(true);
      }
    },
  );

  it("applies a directive emitted by the extractor in the same save transaction", async () => {
    const project = path.join(root, "extractor-directive");
    gitClone(project, "feature/x");
    ensureSessionMemoryState(db, { sessionId: "ext-dir", project });
    await insertExchange(db, exchange("ex-ext-dir", "ext-dir", project,
      "로더는 단일 진입점만 쓴다. 이건 프로젝트 공용으로 기억하자."), emb);
    const saved = await saveExtractedFacts(
      db,
      [{
        fact: "The loader uses a single entry point", category: "decision", scope_type: "project",
        subject_key: "decision.loader.entry_point", scope_directive: "project",
        evidence: ["human_assertion"],
      }] as never,
      project,
      ["ex-ext-dir"],
    );
    expect(saved).toHaveLength(1);
    expect(readFactTier(db, saved[0]).tier).toBe("project");
    expect((db.prepare(
      "SELECT actor FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED'",
    ).get(saved[0]) as { actor: string }).actor).toBe("user-directive");
  });
});

describe("evidence-based automatic ladder (#19)", () => {
  it("promotes branch truth re-confirmed outside its own branch, model-free", async () => {
    const project = path.join(root, "auto-project");
    gitClone(project, "feature/a");
    const first = await branchFact("auto-a", project, "state.runtime.shared", "Shared truth");
    // A second session on another branch of the same project asserts the same slot.
    const second = ensureSessionMemoryState(db, { sessionId: "auto-b", project, branch: "feature/b" });
    await insertExchange(db, exchange("ex-auto-b", "auto-b", project, "Shared truth"), emb);
    insertFact(db, {
      fact: "Shared truth", category: "knowledge", scope_type: "project", scope_project: project,
      source_exchange_ids: ["ex-auto-b"], embedding: emb, subject_key: "state.runtime.shared",
      project_id: second.projectId, workspace_id: second.workspaceId,
      workstream_id: second.workstreamId, promotion_state: "workstream", promotion_evidence: "experimental",
    });

    const result = reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(result.promoted.map((r) => r.id)).toContain(first);
    expect(readFactTier(db, first).tier).toBe("project");
    expect((db.prepare(
      "SELECT actor FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED'",
    ).get(first) as { actor: string }).actor).toBe("auto");
  });

  it("promotes a fact confirmed in two different projects to global", async () => {
    const one = path.join(root, "cross-one");
    const two = path.join(root, "cross-two");
    fs.mkdirSync(one, { recursive: true });
    fs.mkdirSync(two, { recursive: true });
    for (const [name, project] of [["cross-1", one], ["cross-2", two]] as const) {
      const state = ensureSessionMemoryState(db, { sessionId: name, project });
      await insertExchange(db, exchange(`ex-${name}`, name, project, "Always run lint before tests"), emb);
      insertFact(db, {
        fact: "Always run lint before tests", category: "pattern", scope_type: "project",
        scope_project: project, source_exchange_ids: [`ex-${name}`], embedding: emb,
        subject_key: `pattern.ci.lint_${name.replace("-", "_")}`, project_id: state.projectId,
      });
    }
    const result = reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(result.promoted).toHaveLength(1);
    expect(readFactTier(db, result.promoted[0].id)).toMatchObject({ tier: "global", scopeType: "global" });
  });

  it("demotes an automatic promotion once its cited evidence is deactivated", async () => {
    const project = path.join(root, "auto-demote");
    gitClone(project, "feature/a");
    const first = await branchFact("demote-a", project, "state.runtime.gone", "Doomed truth");
    const second = ensureSessionMemoryState(db, { sessionId: "demote-b", project, branch: "feature/b" });
    await insertExchange(db, exchange("ex-demote-b", "demote-b", project, "Doomed truth"), emb);
    const witness = insertFact(db, {
      fact: "Doomed truth", category: "knowledge", scope_type: "project", scope_project: project,
      source_exchange_ids: ["ex-demote-b"], embedding: emb, subject_key: "state.runtime.gone",
      project_id: second.projectId, workspace_id: second.workspaceId,
      workstream_id: second.workstreamId, promotion_state: "workstream", promotion_evidence: "experimental",
    });
    reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(readFactTier(db, first).tier).toBe("project");

    db.prepare("UPDATE facts SET is_active = 0 WHERE id = ?").run(witness);
    const after = reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" });
    expect(after.demoted.map((r) => r.id)).toContain(first);
    expect(readFactTier(db, first).tier).toBe("workstream");
  });
});
