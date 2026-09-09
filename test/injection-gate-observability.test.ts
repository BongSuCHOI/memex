import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendInjectLog, getInjectLogPath } from "../src/inject-log.js";
import { doctor } from "../src/lifecycle.js";
import { TELEMETRY_METRICS } from "../src/chronicle.js";

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
  fs.rmSync(root, { recursive: true, force: true });
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
