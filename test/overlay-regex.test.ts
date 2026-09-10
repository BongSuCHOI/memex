/**
 * The grammar subset — and, just as important, what it does NOT prove.
 *
 * There is deliberately NO test here asserting "the grammar makes a pattern
 * safe". The opposite is asserted instead: the reviewer's counterexample family
 * passes this parser, which is why src/overlay-matcher.ts's 50 ms execution box
 * is the actual guarantee and is tested separately.
 */
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  checkOverlayRegex,
  overlayIssue,
  patternSourceSha8,
  sha8,
  userPatternId,
  OVERLAY_REGEX_LIMITS,
} from "../src/overlay-regex.js";
import { probeCorpus, probeRegexSafety, validateOverlay, PROBE_WALL_MS } from "../src/overlay-admin.js";

function codes(source: string, flags = "i"): string[] {
  return checkOverlayRegex(source, flags).problems.map((problem) => problem.code);
}

describe("overlay regex grammar subset", () => {
  it("accepts every shape the design's acceptance list names", () => {
    const accepted: Array<[string, string]> = [
      ["배포\\s*이력", "i"],
      ["\\bsk-[A-Za-z0-9_-]{16,}", ""],
      ["(확정|최종 결정)", "i"],
      ["^(ok|okay)$", "i"],
      ["(?:re)?deploy", "i"],
      ["[가-힣]{2,10}", ""],
      [".*배포", "i"],
    ];
    for (const [source, flags] of accepted) {
      const result = checkOverlayRegex(source, flags);
      expect(result.problems, `${source} /${flags}`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects quantified groups and alternations", () => {
    expect(codes("(a+)+$")).toContain("REGEX_QUANTIFIED_GROUP");
    expect(codes("^(a|aa)+$")).toContain("REGEX_QUANTIFIED_GROUP");
    expect(codes("(ab)*")).toContain("REGEX_QUANTIFIED_GROUP");
    expect(codes("(ab){2,3}")).toContain("REGEX_QUANTIFIED_GROUP");
    // `?` and {0,1}/{1,1} on a group stay legal — `(?:re)?deploy` depends on it.
    expect(codes("(?:re)?deploy")).toEqual([]);
    expect(codes("(ab){0,1}")).toEqual([]);
    expect(codes("(ab){1,1}")).toEqual([]);
  });

  it("rejects backreferences and lookaround", () => {
    expect(codes("(a)\\1")).toContain("REGEX_BACKREFERENCE");
    expect(codes("\\k<n>")).toContain("REGEX_BACKREFERENCE");
    expect(codes("(?=a)b")).toContain("REGEX_LOOKAROUND");
    expect(codes("(?!a)b")).toContain("REGEX_LOOKAROUND");
    expect(codes("(?<=a)b")).toContain("REGEX_LOOKAROUND");
    expect(codes("(?<!a)b")).toContain("REGEX_LOOKAROUND");
    expect(codes("(?=a)*")).toContain("REGEX_LOOKAROUND");
  });

  it("rejects adjacent repeated atoms whose first characters overlap", () => {
    expect(codes("a+a+")).toContain("REGEX_ADJACENT_OVERLAP");
    expect(codes("\\w+\\d+")).toContain("REGEX_ADJACENT_OVERLAP");
    expect(codes(".*.*")).toContain("REGEX_ADJACENT_OVERLAP");
    expect(codes("[a-z]+[a-c]+")).toContain("REGEX_ADJACENT_OVERLAP");
    // Disjoint first sets are fine.
    expect(codes("\\d+[a-z]+")).toEqual([]);
    expect(codes("a+b+")).toEqual([]);
    // A single repetition is not "repeated".
    expect(codes("a+a?")).toEqual([]);
  });

  it("enforces the quantifier, depth, branch and repeat budgets", () => {
    expect(codes("a?b?c?d?e?f?g?h?i?")).toContain("REGEX_QUANTIFIER_BUDGET");
    expect(checkOverlayRegex("a?b?c?d?e?f?g?h?", "i").ok).toBe(true); // exactly 8
    expect(codes("((((((a))))))")).toContain("REGEX_QUANTIFIER_BUDGET");
    expect(checkOverlayRegex("(((((a)))))", "i").ok).toBe(true); // exactly 5
    const branches = Array.from({ length: 34 }, (_, i) => `x${i}`).join("|");
    expect(codes(branches)).toContain("REGEX_QUANTIFIER_BUDGET");
    expect(codes("a{3,200}")).toContain("REGEX_QUANTIFIER_BUDGET");
    expect(codes("a{5,2}")).toContain("REGEX_QUANTIFIER_BUDGET");
    expect(checkOverlayRegex("a{3,100}", "i").ok).toBe(true);
  });

  it("rejects the stateful and anchor-changing flags, with the reason", () => {
    for (const flag of ["g", "y", "m"]) {
      const result = checkOverlayRegex("abc", flag);
      expect(result.problems.map((p) => p.code)).toContain("PATTERN_FLAGS_REJECTED");
    }
    // The message has to say WHY, because "why not /g?" is the obvious question.
    const g = checkOverlayRegex("abc", "g").problems.find((p) => p.code === "PATTERN_FLAGS_REJECTED");
    expect(g?.message).toMatch(/lastIndex/);
    expect(checkOverlayRegex("abc", "isu").ok).toBe(true);
  });

  it("rejects an over-long source and an uncompilable one", () => {
    expect(codes("a".repeat(OVERLAY_REGEX_LIMITS.sourceChars + 1), "")).toContain("PATTERN_TOO_LONG");
    expect(codes("(unclosed")).toContain("PATTERN_UNCOMPILABLE");
    expect(codes("[unclosed")).toContain("PATTERN_UNCOMPILABLE");
    expect(codes("")).toContain("REGEX_UNSUPPORTED_SYNTAX");
  });

  it("attributes a rejection to an offset where it can", () => {
    const problem = checkOverlayRegex("배포\\s*(?=이력)", "i").problems
      .find((p) => p.code === "REGEX_LOOKAROUND");
    expect(problem?.at).toBeGreaterThan(0);
    expect(problem?.message).toMatch(/offset \d+/);
  });

  it("DOES NOT claim the grammar rules out catastrophic backtracking", () => {
    // The 9-quantifier form trips the budget...
    const nine = checkOverlayRegex("^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$", "");
    expect(nine.ok).toBe(false);
    expect(nine.problems.map((p) => p.code)).toEqual(["REGEX_QUANTIFIER_BUDGET"]);
    // ...but the SAME SHAPE inside the budget passes every structural rule:
    // no groups, no backreferences, and `b?` between the `a+`s keeps the
    // adjacency rule from ever firing. This is the whole reason the execution
    // time box exists, and why nothing here may be called a safety proof.
    const seven = checkOverlayRegex("^a+b?a+b?a+$", "");
    expect(seven.ok).toBe(true);
    expect(seven.quantifiers).toBeLessThanOrEqual(OVERLAY_REGEX_LIMITS.quantifiers);
  });

  it("reports observed counts so `validate` can show headroom", () => {
    const result = checkOverlayRegex("(a|b)c?d{2,3}", "i");
    expect(result.ok).toBe(true);
    expect(result.quantifiers).toBe(2);
    expect(result.depth).toBe(1);
    expect(result.branches).toBe(1);
  });
});

describe("overlay identity helpers", () => {
  it("derives a deterministic user pattern id from intent, source and flags", () => {
    const id = userPatternId("memory", "배포\\s*이력", "i");
    expect(id).toMatch(/^user\.[0-9a-f]{8}$/);
    expect(userPatternId("memory", "배포\\s*이력", "i")).toBe(id);
    expect(userPatternId("trace", "배포\\s*이력", "i")).not.toBe(id);
    expect(userPatternId("memory", "배포\\s*이력", "")).not.toBe(id);
  });

  it("keys the quarantine on source and flags so editing a regex clears it", () => {
    const before = patternSourceSha8("배포\\s*이력", "i");
    expect(patternSourceSha8("배포\\s*이력", "i")).toBe(before);
    expect(patternSourceSha8("배포\\s*이력!", "i")).not.toBe(before);
    expect(patternSourceSha8("배포\\s*이력", "")).not.toBe(before);
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }))
      .toBe(canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(sha8("x")).toHaveLength(8);
  });

  it("an Issue derives its i18n key from its code so the two cannot drift", () => {
    const issue = overlayIssue("error", "PATTERN_TOO_LONG", "too long", { path: "patterns.add[2].source" });
    expect(issue).toEqual({
      severity: "error",
      code: "PATTERN_TOO_LONG",
      key: "overlays.issue.patternTooLong",
      message: "too long",
      path: "patterns.add[2].source",
    });
    expect(overlayIssue("warning", "DISABLE_ID_UNKNOWN", "x").key)
      .toBe("overlays.issue.disableIdUnknown");
  });
});

describe("measuring probe (write path only)", () => {
  it("builds a deterministic corpus that includes FAILING suffixes", () => {
    const corpus = probeCorpus(["배포이력"]);
    expect(corpus).toContain("a".repeat(4000));
    // The failing suffix is the case that catches nullable-separator blowups: the
    // engine has to exhaust every split before it can report no match.
    expect(corpus.some((probe) => probe.endsWith("!"))).toBe(true);
    expect(corpus.some((probe) => probe.endsWith("Z"))).toBe(true);
    expect(probeCorpus(["배포이력"])).toEqual(corpus);
  });

  it("measures an ordinary pattern well inside the limit", async () => {
    const result = await probeRegexSafety([{ label: "ok", source: "배포\\s*이력", flags: "i" }]);
    expect(result.ok).toBe(true);
    expect(result.unavailable).toBe(false);
    expect(result.maxMs).toBeLessThan(PROBE_WALL_MS);
  });

  it("terminates on a deliberately slow pattern instead of hanging", async () => {
    const wall = Date.now();
    const result = await probeRegexSafety([
      { label: "slow", source: "^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$", flags: "" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.tooSlow).toEqual(["slow"]);
    // Bounded by the wall clock, not by when the regex gives up.
    expect(Date.now() - wall).toBeLessThan(PROBE_WALL_MS * 6);
  });

  it("validateOverlay probes the candidate AND the composed intent pattern", async () => {
    const doc = {
      schema: "memex.recall-gate-overlay",
      version: 1,
      revision: 1,
      patterns: { add: [{ intent: "memory", source: "배포\\s*이력", flags: "i" }] },
    };
    const probed = await validateOverlay("recall-gate", doc, { probe: true, forWrite: true });
    expect(probed.ok).toBe(true);
    expect(probed.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("does NOT promise to catch every slow pattern — a measured pass is not a proof", async () => {
    // `^a+b?a+b?a+$` is inside the quantifier budget, so the grammar accepts it,
    // and the 300 ms probe measures it at tens of milliseconds — so it SAVES.
    // It is nonetheless the counterexample family: a longer failing input pushes
    // it past the runtime budget, and at that point the 50 ms execution box
    // quarantines it. A `PATTERN_TOO_SLOW` at write time is a convenience, not a
    // gate, and this test exists so nobody later reads it as one.
    const doc = {
      schema: "memex.recall-gate-overlay",
      version: 1,
      revision: 1,
      patterns: {
        add: [{ id: "user.slow", intent: "memory", source: "^a+b?a+b?a+$", flags: "" }],
      },
    };
    const structural = await validateOverlay("recall-gate", doc, { probe: false, forWrite: true });
    expect(structural.ok).toBe(true); // the grammar lets this shape through
    const probed = await validateOverlay("recall-gate", doc, { probe: true, forWrite: true });
    // Whether THIS form crosses 300 ms on THIS machine is not asserted; the
    // shape of the refusal is.
    for (const issue of probed.issues.filter((i) => i.code === "PATTERN_TOO_SLOW")) {
      expect(issue.severity).toBe("error");
      expect(issue.path).toBe("patterns.add");
      expect(issue.key).toBe("overlays.issue.patternTooSlow");
    }
    expect(probed.ok).toBe(probed.issues.every((issue) => issue.severity !== "error"));
  });

  it("a probe that cannot run at all is not a refusal", async () => {
    expect(await probeRegexSafety([])).toEqual({ ok: true, maxMs: 0, tooSlow: [], unavailable: false });
  });
});
