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
import {
  EXTRACTION_SYSTEM_PROMPT,
  saveExtractedFacts,
  saveExtractedFactsDetailed,
  validateExtractedFactCandidate,
} from "../src/fact-extractor.js";
import {
  TierStaleError,
  TierStepError,
  applyScopeDirective,
  demoteFact,
  factTierOf,
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
    expect(() => promoteFact(db, id, { actor: "user", to: "bogus" as never })).toThrow("unknown tier");
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

describe("a duplicate request cannot double-promote (#77)", () => {
  it("refuses a named rung the fact has already reached", async () => {
    const project = path.join(root, "r77-step");
    gitClone(project, "feature/r77");
    const id = await branchFact("r77-step", project, "state.runtime.step");
    promoteFact(db, id, { actor: "user", to: "project" });
    expect(readFactTier(db, id).tier).toBe("project");
    // The losing half of a double click asks for the same rung a second time.
    expect(() => promoteFact(db, id, { actor: "user", to: "project" })).toThrow(TierStepError);
    expect(readFactTier(db, id).tier).toBe("project");
  });

  it("refuses a move whose expected tier or row version is stale, writing nothing", async () => {
    const project = path.join(root, "r77-stale");
    gitClone(project, "feature/r77");
    const id = await branchFact("r77-stale", project, "state.runtime.stale");
    const before = db.prepare("SELECT scope_type, promotion_state, updated_at FROM facts WHERE id = ?")
      .get(id) as { scope_type: string; promotion_state: string | null; updated_at: string };
    expect(factTierOf(before)).toBe("workstream");

    // A concurrent winner already moved it; this request still holds the old read.
    promoteFact(db, id, { actor: "user", to: "project" });
    expect(() => promoteFact(db, id, {
      actor: "user", to: "project",
      expected: { tier: "workstream", updatedAt: before.updated_at },
    })).toThrow(TierStaleError);
    expect(readFactTier(db, id).tier).toBe("project");

    // A matching expectation still moves, and only one rung.
    const fresh = db.prepare("SELECT updated_at FROM facts WHERE id = ?").get(id) as { updated_at: string };
    const move = promoteFact(db, id, {
      actor: "user", to: "global", expected: { tier: "project", updatedAt: fresh.updated_at },
    });
    expect(move).toMatchObject({ from: "project", to: "global" });
    // A stale row version alone (right tier) is refused too.
    expect(() => demoteFact(db, id, {
      actor: "user", to: "project", expected: { tier: "global", updatedAt: fresh.updated_at },
    })).toThrow(TierStaleError);
    expect(readFactTier(db, id).tier).toBe("global");
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

  it("applies a directive when the same sentence is merely restated (#64)", async () => {
    const project = path.join(root, "r64-merge");
    gitClone(project, "feature/r64");
    ensureSessionMemoryState(db, { sessionId: "r64", project });
    await insertExchange(db, exchange("ex-r64-a", "r64", project, "로더는 단일 진입점만 쓴다."), emb);
    await insertExchange(db, exchange("ex-r64-b", "r64", project,
      "로더는 단일 진입점만 쓴다. 이건 프로젝트 공용으로 기억하자."), emb);
    const candidate = {
      fact: "The loader uses a single entry point", category: "decision", scope_type: "project",
      subject_key: "decision.loader.entry_point", evidence: ["human_assertion"],
    };

    const first = await saveExtractedFacts(db, [candidate] as never, project, ["ex-r64-a"]);
    expect(readFactTier(db, first[0]).tier).toBe("workstream");

    // The second save restates the SAME normalized text and names where it belongs.
    const again = await saveExtractedFactsDetailed(
      db, [{ ...candidate, scope_directive: "project" }] as never, project, ["ex-r64-b"],
    );
    expect(again.merged).toBe(1);
    expect(again.savedIds).toEqual([]);
    expect(readFactTier(db, first[0]).tier).toBe("project");
    const promotions = db.prepare(
      "SELECT actor FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED'",
    ).all(first[0]) as Array<{ actor: string }>;
    expect(promotions).toEqual([{ actor: "user-directive" }]);
  });
});

describe("a model-proposed scope directive is not user authority (#59)", () => {
  /** Tool-only evidence: the model read a file, no human said where to store it. */
  const toolExchange = (id: string) => ({
    id,
    user_message: "run the tests please",
    assistant_message: "ok",
    tool_evidence: [{
      id: "call-1", tool_name: "shell",
      tool_result: "config says database = sqlite",
      source_type: "repo_file", learnable: 1,
    }],
  });
  const toolCandidate = (directive: string) => ({
    fact: "The runtime database is SQLite",
    category: "knowledge", scope_type: "project",
    grounding_type: "verified", durable: true, confidence: 0.9,
    subject_key: "state.runtime.database",
    scope_directive: directive,
    evidence: [{
      exchange_index: 1, source: "tool", kind: "repo_file", source_type: "repo_file",
      tool_call_id: "call-1", tool_name: "shell", supporting_span: "database = sqlite",
    }],
  });

  it("drops the directive and records why, while keeping the fact itself", () => {
    const validated = validateExtractedFactCandidate(toolCandidate("global"), [toolExchange("ex-r59-tool")]);
    expect(validated).not.toBeNull();
    expect(validated?.fact).toBe("The runtime database is SQLite");
    expect(validated?.scope_directive).toBeUndefined();
    expect(validated?.classifier_notes?.join("\n")).toContain(
      "dropped scope_directive without human evidence: global",
    );
  });

  it("leaves the saved fact on its branch tier with no PROMOTED event", async () => {
    const project = path.join(root, "r59-tool");
    gitClone(project, "feature/r59");
    ensureSessionMemoryState(db, { sessionId: "r59-tool", project });
    await insertExchange(db, exchange("ex-r59-tool", "r59-tool", project, "run the tests please"), emb);
    const validated = validateExtractedFactCandidate(toolCandidate("global"), [toolExchange("ex-r59-tool")]);
    const saved = await saveExtractedFacts(db, [validated as never], project, ["ex-r59-tool"]);
    expect(saved).toHaveLength(1);
    expect(readFactTier(db, saved[0]).tier).toBe("workstream");
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ? AND event_kind = 'PROMOTED'",
    ).get(saved[0]) as { n: number }).n).toBe(0);
    expect((db.prepare(
      "SELECT COUNT(*) AS n FROM fact_revisions WHERE fact_id = ? AND actor = 'user-directive'",
    ).get(saved[0]) as { n: number }).n).toBe(0);
  });

  it("keeps the directive when a human assertion grounds it", () => {
    const validated = validateExtractedFactCandidate({
      fact: "The loader uses a single entry point",
      category: "decision", scope_type: "project",
      grounding_type: "explicit", durable: true, confidence: 0.9,
      subject_key: "decision.loader.entry_point",
      scope_directive: "global",
      evidence: [{
        exchange_index: 1, source: "human", kind: "decision",
        supporting_span: "the loader uses a single entry point",
      }],
    }, [{
      id: "ex-r59-human",
      user_message: "the loader uses a single entry point — make this a global memory",
      assistant_message: "ok",
      provenance: JSON.stringify(["human_assertion"]),
    }]);
    expect(validated?.scope_directive).toBe("global");
    expect((validated?.classifier_notes ?? []).join("\n")).not.toContain("dropped scope_directive");
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
    expect(result.skipped).toEqual([]);
  });

  it("never promotes a slot whose branches disagree, and reports the conflict (#60)", async () => {
    const project = path.join(root, "conflict-project");
    gitClone(project, "feature/a");
    const sqlite = await branchFact("conf-a", project, "state.runtime.database", "The project uses SQLite");
    // Same slot, a different branch, the OPPOSITE sentence: not a re-confirmation.
    const other = ensureSessionMemoryState(db, { sessionId: "conf-b", project, branch: "feature/b" });
    await insertExchange(db, exchange("ex-conf-b", "conf-b", project, "The project uses PostgreSQL"), emb);
    const postgres = insertFact(db, {
      fact: "The project uses PostgreSQL", category: "knowledge", scope_type: "project",
      scope_project: project, source_exchange_ids: ["ex-conf-b"], embedding: emb,
      subject_key: "state.runtime.database", project_id: other.projectId,
      workspace_id: other.workspaceId, workstream_id: other.workstreamId,
      promotion_state: "workstream", promotion_evidence: "experimental",
    });

    const result = reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(result.promoted).toEqual([]);
    expect(readFactTier(db, sqlite).tier).toBe("workstream");
    expect(readFactTier(db, postgres).tier).toBe("workstream");
    expect(result.skipped.map((r) => r.reason)).toEqual([
      "slot has conflicting branch truths", "slot has conflicting branch truths",
    ]);
    expect(result.skipped.map((r) => r.id).sort()).toEqual([sqlite, postgres].sort());
    // Repeating the pass never erodes into a promotion either.
    expect(reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" }).promoted).toEqual([]);
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
    expect(after.demoted.find((r) => r.id === first)).toMatchObject({ from: "project", to: "workstream" });
    expect(readFactTier(db, first).tier).toBe("workstream");

    // #61 — exactly one rung, and repeating the pass never digs deeper.
    const again = reconcileFactTiers(db, { now: "2026-09-10T02:00:00.000Z" });
    expect(again.demoted).toEqual([]);
    expect(readFactTier(db, first).tier).toBe("workstream");
  });

  it("never undoes a later user placement, and says so in skipped (#61)", async () => {
    const project = path.join(root, "user-wins");
    gitClone(project, "feature/a");
    const id = await branchFact("user-wins-a", project, "state.runtime.kept", "Kept truth");
    const second = ensureSessionMemoryState(db, { sessionId: "user-wins-b", project, branch: "feature/b" });
    await insertExchange(db, exchange("ex-user-wins-b", "user-wins-b", project, "Kept truth"), emb);
    const witness = insertFact(db, {
      fact: "Kept truth", category: "knowledge", scope_type: "project", scope_project: project,
      source_exchange_ids: ["ex-user-wins-b"], embedding: emb, subject_key: "state.runtime.kept",
      project_id: second.projectId, workspace_id: second.workspaceId,
      workstream_id: second.workstreamId, promotion_state: "workstream", promotion_evidence: "experimental",
    });
    reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(readFactTier(db, id).tier).toBe("project");

    // A person then places it globally: their decision is the fact's last word.
    promoteFact(db, id, { actor: "user", reason: "applies everywhere" });
    expect(readFactTier(db, id).tier).toBe("global");
    db.prepare("UPDATE facts SET is_active = 0 WHERE id = ?").run(witness);

    for (const at of ["2026-09-10T01:00:00.000Z", "2026-09-10T02:00:00.000Z"]) {
      const pass = reconcileFactTiers(db, { now: at });
      expect(pass.demoted).toEqual([]);
      expect(pass.skipped).toEqual([{ id, reason: "superseded by a user decision" }]);
      expect(readFactTier(db, id).tier).toBe("global");
    }
  });
});

/**
 * #62 — the documented automatic demotion condition is "the upper evidence was
 * deactivated *or corrected* away" (`docs/FACT-LIFECYCLE.md`), but the pass read
 * the cited witnesses' `is_active` alone.
 *
 * Observed: two projects asserting "Always run lint before tests" promote one
 * row to `global`; correcting the surviving witness to "Never run lint before
 * tests" (still `is_active = 1`, `semantic_generation` bumped) left
 * `demoted: []` and `tier: "global"`. The fact stayed global on evidence that
 * had come to say the opposite.
 */
describe("automatic promotions survive only while their evidence still confirms them (#62)", () => {
  /** Two projects asserting `text`; returns the promoted row and its witness. */
  async function crossProjectGlobal(
    slug: string,
    text: string,
  ): Promise<{ promoted: string; witness: string }> {
    const ids: string[] = [];
    for (const suffix of ["one", "two"] as const) {
      const project = path.join(root, `${slug}-${suffix}`);
      fs.mkdirSync(project, { recursive: true });
      const name = `${slug}_${suffix}`;
      const state = ensureSessionMemoryState(db, { sessionId: name, project });
      await insertExchange(db, exchange(`ex-${name}`, name, project, text), emb);
      ids.push(insertFact(db, {
        fact: text, category: "pattern", scope_type: "project", scope_project: project,
        source_exchange_ids: [`ex-${name}`], embedding: emb,
        subject_key: `pattern.ci.${name}`, project_id: state.projectId,
      }));
    }
    const pass = reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    const promoted = pass.promoted.find((row) => row.to === "global");
    expect(promoted).toBeDefined();
    const witness = ids.find((id) => id !== promoted?.id);
    expect(witness).toBeDefined();
    return { promoted: promoted!.id, witness: witness! };
  }

  it("demotes when the surviving witness is corrected to the opposite sentence", async () => {
    const { promoted, witness } = await crossProjectGlobal("corrected", "Always run lint before tests");
    expect(readFactTier(db, promoted).tier).toBe("global");

    // The witness is corrected, not removed: it stays active, as a correction does.
    db.prepare("UPDATE facts SET fact = ?, semantic_generation = semantic_generation + 1 WHERE id = ?")
      .run("Never run lint before tests", witness);
    expect(db.prepare("SELECT is_active FROM facts WHERE id = ?").get(witness))
      .toEqual({ is_active: 1 });

    const after = reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" });
    expect(after.demoted).toEqual([{
      id: promoted, from: "global", to: "project",
      reason: "upper evidence no longer confirms the same fact",
    }]);
    expect(readFactTier(db, promoted).tier).toBe("project");

    // The reason a fact came down is readable in the Chronicle event, alongside
    // the witness it no longer trusts.
    const event = db.prepare(
      "SELECT actor, outcome_json FROM fact_revisions WHERE fact_id = ? AND event_kind = 'DEMOTED'",
    ).get(promoted) as { actor: string; outcome_json: string };
    expect(event.actor).toBe("auto");
    expect(JSON.parse(event.outcome_json)).toMatchObject({
      from_tier: "global",
      to_tier: "project",
      reason: "upper evidence no longer confirms the same fact",
      evidence_fact_ids: [witness],
    });

    // #61 still holds: one rung, and repeating the pass never digs deeper.
    const again = reconcileFactTiers(db, { now: "2026-09-10T02:00:00.000Z" });
    expect(again.demoted).toEqual([]);
    expect(readFactTier(db, promoted).tier).toBe("project");
  });

  it("keeps the tier when the witness is only restated and normalizes equal", async () => {
    const { promoted, witness } = await crossProjectGlobal("restated", "Always run lint before tests");
    expect(readFactTier(db, promoted).tier).toBe("global");

    // Same sentence, different casing and padding: `LOWER(TRIM(fact))` — the
    // normalization both promotions use — still reads it as the same truth.
    db.prepare("UPDATE facts SET fact = ?, semantic_generation = semantic_generation + 1 WHERE id = ?")
      .run("  ALWAYS RUN LINT BEFORE TESTS  ", witness);

    const after = reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" });
    expect(after.demoted).toEqual([]);
    expect(readFactTier(db, promoted).tier).toBe("global");
  });

  it("still demotes on deactivation, and names that reason instead", async () => {
    const { promoted, witness } = await crossProjectGlobal("deactivated", "Always run lint before tests");
    db.prepare("UPDATE facts SET is_active = 0 WHERE id = ?").run(witness);

    const after = reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" });
    expect(after.demoted).toEqual([{
      id: promoted, from: "global", to: "project",
      reason: "upper evidence is no longer active",
    }]);
    expect(readFactTier(db, promoted).tier).toBe("project");
  });

  it("demotes a workstream promotion whose branch witness was corrected", async () => {
    const project = path.join(root, "branch-corrected");
    gitClone(project, "feature/a");
    const target = await branchFact("bc-a", project, "state.runtime.shared", "Shared truth");
    const second = ensureSessionMemoryState(db, { sessionId: "bc-b", project, branch: "feature/b" });
    await insertExchange(db, exchange("ex-bc-b", "bc-b", project, "Shared truth"), emb);
    const witness = insertFact(db, {
      fact: "Shared truth", category: "knowledge", scope_type: "project", scope_project: project,
      source_exchange_ids: ["ex-bc-b"], embedding: emb, subject_key: "state.runtime.shared",
      project_id: second.projectId, workspace_id: second.workspaceId,
      workstream_id: second.workstreamId, promotion_state: "workstream",
      promotion_evidence: "experimental",
    });
    reconcileFactTiers(db, { now: "2026-09-10T00:00:00.000Z" });
    expect(readFactTier(db, target).tier).toBe("project");

    db.prepare("UPDATE facts SET fact = ?, semantic_generation = semantic_generation + 1 WHERE id = ?")
      .run("Contradicting truth", witness);
    const after = reconcileFactTiers(db, { now: "2026-09-10T01:00:00.000Z" });
    expect(after.demoted).toEqual([{
      id: target, from: "project", to: "workstream",
      reason: "upper evidence no longer confirms the same fact",
    }]);
    expect(readFactTier(db, target).tier).toBe("workstream");
  });
});
