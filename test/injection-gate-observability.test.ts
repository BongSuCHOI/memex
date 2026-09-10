import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendInjectLog, getInjectLogPath } from "../src/inject-log.js";
import { doctor } from "../src/lifecycle.js";
import { TELEMETRY_METRICS } from "../src/chronicle.js";
import { initDatabase, l2DistanceToSimilarity } from "../src/db.js";
import { insertFact, searchFactsInScope } from "../src/fact-db.js";
import { queryBaseline, stubEmbedding } from "../src/embeddings.js";
import { computeInjectContext, resolveBaselineMargin } from "../src/inject-core.js";
import { ensureSessionMemoryState } from "../src/continuity-core.js";

/**
 * Issue #32 — the injection pipeline never injected a fact, and doctor said ok.
 *
 * Observed on the real data root (v0.5.2), 12 runs over five days:
 *
 *   candidate_facts   12 rows, sum 60   (exactly 5 every time)
 *   current_facts     12 rows, sum 0
 *   injected_facts     7 rows, sum 0
 *   bundle_size        7 rows, sections ['ASSISTANT CONTEXT'] | ['WORK NOW']
 *
 * Seven of those runs emitted a bundle with zero facts and were logged as
 * `injected`, so the log could not distinguish "memory was injected" from
 * "a Capsule header was emitted". Doctor read only the last line — `no-match`,
 * a normal outcome — and reported `inject-output: ok`.
 */

let root: string;

function check(name: string) {
  return doctor().json.find((entry) => entry.name === name)!;
}

/** The exact 12-line shape from the issue, as the log records it after the fix. */
function replayObservedLog(): void {
  const runs: Array<{ status: "context-only" | "no-match"; sections?: string[] }> = [
    { status: "no-match" },
    { status: "context-only", sections: ["ASSISTANT CONTEXT"] },
    { status: "no-match" },
    { status: "context-only", sections: ["ASSISTANT CONTEXT"] },
    { status: "context-only", sections: ["ASSISTANT CONTEXT"] },
    { status: "no-match" },
    { status: "context-only", sections: ["WORK NOW"] },
    { status: "context-only", sections: ["WORK NOW"] },
    { status: "context-only", sections: ["WORK NOW"] },
    { status: "no-match" },
    { status: "context-only", sections: ["ASSISTANT CONTEXT"] },
    { status: "no-match" },
  ];
  for (const run of runs) {
    appendInjectLog({
      status: run.status,
      project: root,
      prompt_len: 40,
      candidates: 5,
      injected: 0,
      deduped: 0,
      lexical_lane: "ok",
      via: "fallback",
      ...(run.sections ? { chars: 208, sections: run.sections } : {}),
    });
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-inject-gate-"));
  process.env.MEMEX_HOME = path.join(root, "home");
  process.env.MEMEX_DB_PATH = path.join(root, "home", "conversation-index", "db.sqlite");
  process.env.CODEX_HOME = path.join(root, "codex");
  process.env.MEMEX_PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DB_PATH;
  delete process.env.CODEX_HOME;
  delete process.env.MEMEX_PLUGIN_ROOT;
  delete process.env.MEMEX_INJECT_BASELINE_MARGIN;
  delete process.env.MEMEX_EMBEDDING_STUB;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Issue #75 — the gate decided on the raw gap while telemetry recounted the
 * rounded one.
 *
 * `gaps.push(Math.round(gap * 1e4) / 1e4)` then `gaps.filter(g => g >= margin)`
 * disagrees with `return gap >= margin` at the boundary: with the default margin
 * of 0.045 a gap of 0.04496 is rejected by the gate and "passes" the recount
 * (`{"rawPasses":false,"roundedPasses":true}`), so the telemetry that exists to
 * judge the threshold could report an injection that never happened.
 *
 * The test builds exactly that state: one semantic candidate, no lexical hit,
 * and a similarity placed a hair under the margin.
 */
it("passed/rejected come from the raw gaps, not the rounded display values", async () => {
  process.env.MEMEX_EMBEDDING_STUB = "1";
  const cwd = path.join(root, "project");
  const session = "gap-session";
  const db = initDatabase();
  try {
    const prompt = "어떤 캐시 무효화 전략을 골랐었지";
    const query = stubEmbedding(prompt);
    const baseline = await queryBaseline(query);

    // Place one candidate a hair off the default margin. For unit vectors the
    // stored L2 distance is a cosine (`1 - d^2/2 === cos`), so blending the query
    // direction with an orthogonal one puts the candidate at a chosen similarity;
    // int8 quantization then shifts it slightly, which is why the exact gap is
    // measured below rather than assumed.
    const target = baseline + 0.045;
    const orthogonal = (() => {
      const seed = stubEmbedding("deployment rollbacks release ledger direction");
      const dot = seed.reduce((sum, value, i) => sum + value * query[i], 0);
      const residual = seed.map((value, i) => value - dot * query[i]);
      const norm = Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0)) || 1;
      return residual.map((value) => value / norm);
    })();
    const embedding = query.map((value, i) =>
      value * target + orthogonal[i] * Math.sqrt(Math.max(0, 1 - target * target)));

    // One semantic candidate whose wording shares no token with the prompt: a
    // lexical hit would bypass the margin gate entirely, and this lane is the
    // only one the gate judges.
    const scope = ensureSessionMemoryState(db, { sessionId: session, project: cwd, prompt });
    insertFact(db, {
      fact: "Deployment rollbacks are driven from the release ledger",
      category: "decision", scope_type: "project", scope_project: cwd,
      source_exchange_ids: [], embedding,
    });

    // The gap the gate will see, measured through the same helpers it uses.
    const hits = searchFactsInScope(db, query, {
      type: "workstream-id", projectId: scope.projectId,
      workspaceId: scope.workspaceId, workstreamId: scope.workstreamId,
    }, 5, 0);
    expect(hits).toHaveLength(1);
    const rawGap = l2DistanceToSimilarity(hits[0].distance) - baseline;
    const roundedGap = Math.round(rawGap * 1e4) / 1e4;
    // Four-decimal rounding has to actually move the value for this fixture to
    // sit on the boundary at all. (int8-quantized vectors make the exact gap a
    // property of the stub, so this is asserted rather than assumed.)
    expect(roundedGap).not.toBe(rawGap);

    // Put the threshold exactly where the raw and rounded comparisons disagree —
    // the state the default margin of 0.045 produced for a gap of 0.04496.
    const margin = roundedGap > rawGap ? roundedGap : rawGap;
    process.env.MEMEX_INJECT_BASELINE_MARGIN = String(margin);
    expect(resolveBaselineMargin()).toBe(margin);
    const rawPasses = rawGap >= margin;
    expect(rawPasses).not.toBe(roundedGap >= margin);

    const context = await computeInjectContext(prompt, cwd, "daemon", session, { gate: false });

    const sample = db.prepare(
      "SELECT value, dims_json FROM continuity_telemetry WHERE metric = 'baseline_margin_gap' AND session_id = ?",
    ).get(session) as { value: number; dims_json: string } | undefined;
    expect(sample).toBeDefined();
    const dims = JSON.parse(sample!.dims_json) as {
      margin: number; gaps: number[]; passed: number; rejected: number; baseline: number;
    };

    // The counts follow the RAW comparison — the one the gate actually made —
    // and therefore match what was injected. Recomputing them from `dims.gaps`
    // would give the opposite answer for this candidate.
    expect(dims.gaps).toHaveLength(1);
    expect(dims.passed).toBe(rawPasses ? 1 : 0);
    expect(dims.rejected).toBe(rawPasses ? 0 : 1);
    expect(context.includes("Deployment rollbacks")).toBe(rawPasses);

    // `dims.gaps` is still the four-decimal display value, which is exactly why
    // it cannot be what the counts are computed from.
    expect(dims.gaps[0]).toBe(roundedGap);
    expect(dims.gaps[0]).toBe(Math.round(dims.gaps[0] * 1e4) / 1e4);
  } finally {
    db.close();
  }
});

it("a zero-fact bundle is logged as context-only, not as injected", async () => {
  replayObservedLog();
  const lines = fs.readFileSync(getInjectLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(12);
  // Before the fix these seven were indistinguishable from real injections.
  expect(lines.filter((line) => line.status === "context-only")).toHaveLength(7);
  expect(lines.filter((line) => line.status === "injected")).toHaveLength(0);
  expect(lines.reduce((sum, line) => sum + Number(line.injected ?? 0), 0)).toBe(0);
});

it("doctor warns on a zero-fact streak instead of reporting ok on the last line", () => {
  replayObservedLog();
  // The observed last line is `no-match`, which is a normal outcome.
  expect(check("inject-output").status).toBe("ok");
  const yieldCheck = check("injection-yield");
  expect(yieldCheck.status).toBe("warn");
  expect(yieldCheck.detail).toContain("12 consecutive retrievals injected 0 facts");
  expect(yieldCheck.detail).toContain("context-only=7");
  expect(yieldCheck.detail).toContain("baseline_margin_gap");
  expect(yieldCheck.detail).toContain("MEMEX_INJECT_BASELINE_MARGIN");
});

it("doctor stays ok once a retrieval actually injects a fact", () => {
  replayObservedLog();
  appendInjectLog({
    status: "injected", project: root, prompt_len: 40, candidates: 5, injected: 2,
    chars: 300, sections: ["CURRENT TRUTH"], lexical_lane: "ok", via: "fallback",
  });
  const yieldCheck = check("injection-yield");
  expect(yieldCheck.status).toBe("ok");
  expect(yieldCheck.detail).toContain("current zero-fact streak 0");
});

it("a dead lexical lane is reported instead of swallowed", () => {
  for (let i = 0; i < 3; i++) {
    appendInjectLog({
      status: "injected", project: root, prompt_len: 40, candidates: 5, injected: 1,
      lexical_lane: "unavailable", via: "fallback",
    });
  }
  const yieldCheck = check("injection-yield");
  expect(yieldCheck.status).toBe("warn");
  expect(yieldCheck.detail).toContain("lexical_lane=unavailable×3");
});

it("the baseline margin is measurable and overridable without a code change", async () => {
  expect(TELEMETRY_METRICS).toContain("baseline_margin_gap");
  expect(TELEMETRY_METRICS).toContain("lexical_lane_unavailable");

  const core = await import("../src/inject-core.js");
  // The default is deliberately unchanged: retuning without evidence would be
  // a guess, and the telemetry above is what makes the evidence possible.
  expect(core.INJECT_BASELINE_MARGIN_DEFAULT).toBe(0.045);
  expect(core.resolveBaselineMargin()).toBe(0.045);
  process.env.MEMEX_INJECT_BASELINE_MARGIN = "0.02";
  expect(core.resolveBaselineMargin()).toBe(0.02);
  for (const invalid of ["", "abc", "-1", "2"]) {
    process.env.MEMEX_INJECT_BASELINE_MARGIN = invalid;
    expect(core.resolveBaselineMargin()).toBe(0.045);
  }
});
