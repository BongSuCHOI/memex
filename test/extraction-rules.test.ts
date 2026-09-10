/**
 * The extraction-rules overlay's schema, clause and prompt invariants (#30 §3.1/§3.2).
 *
 * The invariants matter more than the schema. An overlay that could edit the
 * extraction policy, move the evidence bar or touch the fail-closed entailment
 * verifier would be a way to lower precision by writing a config file, so the
 * tests that pin "byte-identical" are the feature's real boundary — `#30` is
 * explicitly "structured rules only, raw prompt editing excluded".
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EXTRACTION_RULES_LIMITS,
  composeEffectivePolicyVersion,
  composeExtractionSystemPrompt,
  emptyExtractionRulesDoc,
  extractionRulesChecks,
  extractionRulesDocHash,
  extractionRulesPreClaimBlock,
  loadExtractionRules,
  observeOverlayBenchmarkEnvironment,
  reloadExtractionRulesIfChanged,
  renderExtractionConstraintClause,
  resetExtractionRulesCache,
  resolveExtractionRules,
  unionNeverExtract,
  validateExtractionRulesDoc,
  type NeverExtractPattern,
} from "../src/extraction-rules.js";
import { rulesDoc, writeRules } from "./extraction-rules-fixture.js";

let root: string;

function codes(raw: unknown): string[] {
  return validateExtractionRulesDoc(raw).issues.map((issue) => issue.code);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-rules-unit-"));
  process.env.MEMEX_HOME = root;
  delete process.env.MEMEX_OVERLAY_DIR;
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetExtractionRulesCache();
});

afterEach(() => {
  delete process.env.MEMEX_HOME;
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("schema validation", () => {
  it("accepts the documented example", () => {
    const result = validateExtractionRulesDoc({
      schema: "memex.extraction-rules-overlay",
      version: 1,
      revision: 3,
      preferred_language: "ko",
      exclude_topics: ["사내 인사 평가", "급여"],
      never_extract_patterns: [
        {
          id: "user.9c1e4d07",
          source: "\\bsk-[A-Za-z0-9_-]{16,}",
          flags: "",
          scope: "both",
          note: "API 키 형태",
        },
      ],
      always_treat_as_decision_patterns: [{ id: "user.dec1", source: "(확정|최종 결정)", flags: "" }],
      project_overrides: { "/tmp/p": { preferred_language: "en", exclude_topics: ["salary"] } },
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.doc?.never_extract_patterns).toHaveLength(1);
  });

  it("refuses a wrong schema or an unknown version WITHOUT partial application", () => {
    expect(codes({ schema: "nope", version: 1 })).toContain("OVERLAY_SCHEMA_MISMATCH");
    const future = validateExtractionRulesDoc({
      schema: "memex.extraction-rules-overlay",
      version: 2,
      never_extract_patterns: [{ id: "a", source: "secret", flags: "" }],
    });
    expect(future.ok).toBe(false);
    // Half-applying a "never extract" is the worst outcome in the design.
    expect(future.doc).toBeNull();
    expect(future.issues.map((i) => i.code)).toContain("OVERLAY_VERSION_UNSUPPORTED");
  });

  it("rejects a file over the byte limit before it says anything else", () => {
    const result = validateExtractionRulesDoc(rulesDoc([]), {
      bytes: EXTRACTION_RULES_LIMITS.fileBytes + 1,
    });
    expect(result.issues.map((i) => i.code)).toEqual(["OVERLAY_TOO_LARGE"]);
  });

  it("carries a `path` on every row-level issue so the UI can say which row to fix", () => {
    const result = validateExtractionRulesDoc(
      rulesDoc([
        { id: "ok", source: "fine" },
        { id: "bad", source: "(a+)+$" },
      ]),
    );
    const issue = result.issues.find((i) => i.code === "REGEX_QUANTIFIED_GROUP");
    expect(issue?.path).toBe("never_extract_patterns[1].source");
    expect(issue?.row).toBe(1);
    expect(issue?.field).toBe("source");
    expect(issue?.key).toBe("overlays.issue.regexQuantifiedGroup");
    expect(typeof issue?.message).toBe("string");
  });

  it("runs the SAME grammar as the gate overlay and rejects g/y/m flags", () => {
    expect(codes(rulesDoc([{ id: "a", source: "secret", flags: "g" }]))).toContain(
      "PATTERN_FLAGS_REJECTED",
    );
    expect(codes(rulesDoc([{ id: "a", source: "\\1x" }]))).toContain("REGEX_BACKREFERENCE");
    expect(codes(rulesDoc([{ id: "a", source: "(?=a)b" }]))).toContain("REGEX_LOOKAROUND");
    expect(codes(rulesDoc([{ id: "a", source: "a".repeat(250) }]))).toContain("PATTERN_TOO_LONG");
  });

  it("enforces the count limits and rejects a duplicate id", () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, source: `x${i}` }));
    expect(codes(rulesDoc(many))).toContain("PATTERN_COUNT_EXCEEDED");
    expect(
      codes(rulesDoc([{ id: "same", source: "a" }, { id: "same", source: "b" }])),
    ).toContain("PATTERN_DUPLICATE_ID");
    expect(
      codes(rulesDoc([], { exclude_topics: Array.from({ length: 25 }, (_, i) => `topic ${i}`) })),
    ).toContain("TOPIC_COUNT_EXCEEDED");
  });

  it("rejects an unknown scope and an unknown language", () => {
    expect(codes(rulesDoc([{ id: "a", source: "x", scope: "elsewhere" as never }]))).toContain(
      "SCOPE_UNKNOWN",
    );
    expect(codes(rulesDoc([], { preferred_language: "kr" }))).toContain("LANGUAGE_UNKNOWN");
  });

  it("ignores an unknown field as a WARNING, so 0.7.1 can add one", () => {
    // `custom_fact_kinds` is out of scope by decision; 0.7.0 must ignore it
    // quietly rather than refuse the whole file and hold extraction.
    const result = validateExtractionRulesDoc(rulesDoc([], { custom_fact_kinds: ["x"] }));
    expect(result.ok).toBe(true);
    const issue = result.issues.find((i) => i.code === "OVERLAY_UNKNOWN_FIELD");
    expect(issue?.severity).toBe("warning");
    expect(issue?.path).toBe("custom_fact_kinds");
  });
});

describe("hash", () => {
  it("does not move when revision, timestamps or key order change", () => {
    const a = validateExtractionRulesDoc(
      rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }], { preferred_language: "ko", revision: 1 }),
    ).doc!;
    const b = validateExtractionRulesDoc({
      revision: 9,
      updated_at: "2030-01-01T00:00:00.000Z",
      updated_by: { surface: "web-ui" },
      preferred_language: "ko",
      never_extract_patterns: [{ id: "p", source: "sk-[a-z]{4,}", flags: "", scope: "both" }],
      version: 1,
      schema: "memex.extraction-rules-overlay",
    }).doc!;
    expect(extractionRulesDocHash(a)).toBe(extractionRulesDocHash(b));
    expect(extractionRulesDocHash(a)).toMatch(/^rules:[0-9a-f]{8}$/);
  });

  it("moves when a rule changes", () => {
    const a = validateExtractionRulesDoc(rulesDoc([{ id: "p", source: "alpha" }])).doc!;
    const b = validateExtractionRulesDoc(rulesDoc([{ id: "p", source: "beta" }])).doc!;
    expect(extractionRulesDocHash(a)).not.toBe(extractionRulesDocHash(b));
  });

  it("keeps the rule hash OUT of the scheduling key", () => {
    expect(composeEffectivePolicyVersion("precision-durability-v4", null)).toBe(
      "precision-durability-v4",
    );
    expect(composeEffectivePolicyVersion("precision-durability-v4", "rules:9c1e4d07")).toBe(
      "precision-durability-v4+rules:9c1e4d07",
    );
  });
});

describe("project_overrides", () => {
  beforeEach(() => {
    writeRules(root, {
      schema: "memex.extraction-rules-overlay",
      version: 1,
      revision: 1,
      preferred_language: "ko",
      exclude_topics: ["급여"],
      never_extract_patterns: [{ id: "global", source: "sk-[a-z]{4,}", flags: "", scope: "both" }],
      project_overrides: {
        "/tmp/p": {
          preferred_language: "en",
          exclude_topics: ["salary"],
          never_extract_patterns: [
            { id: "local", source: "ghp_[a-z]{4,}", flags: "", scope: "both" },
          ],
        },
      },
    });
  });

  it("UNIONs the restrictions — a project override can never relax a global rule", () => {
    const resolved = resolveExtractionRules("/tmp/p");
    expect(resolved.neverExtract.map((p) => p.id)).toEqual(["global", "local"]);
    expect(resolved.excludeTopics).toEqual(["급여", "salary"]);
    // Only the language is OVERRIDDEN; every restriction accumulates, because an
    // override that silently relaxed a global forbid rule would be a way to lose
    // a secret by adding a line elsewhere in the same file.
    expect(resolved.preferredLanguage).toBe("en");
  });

  it("leaves an unlisted project on the global rules alone", () => {
    const other = resolveExtractionRules("/tmp/other");
    expect(other.neverExtract.map((p) => p.id)).toEqual(["global"]);
    expect(other.preferredLanguage).toBe("ko");
    expect(resolveExtractionRules(null).neverExtract.map((p) => p.id)).toEqual(["global"]);
  });
});

describe("the constraint clause (§3.2)", () => {
  const rules = {
    projectId: null,
    hash: "rules:9c1e4d07",
    revision: 3,
    preferredLanguage: "ko" as const,
    excludeTopics: ["사내 인사 평가", "급여"],
    neverExtract: [
      { id: "user.9c1e4d07", source: "\\bsk-[A-Za-z0-9_-]{16,}", flags: "", scope: "both" as const },
    ],
    decisionHints: [{ id: "user.dec1", source: "(확정|최종 결정)", flags: "" }],
  };

  it("renders deterministically and says restrictions only go one way", () => {
    const clause = renderExtractionConstraintClause(rules);
    expect(clause).toBe(renderExtractionConstraintClause(rules));
    expect(clause).toContain("## User rule overlay (local, operator-authored)");
    expect(clause).toContain("rules_hash: rules:9c1e4d07");
    expect(clause).toContain("They can only");
    expect(clause).toContain("SUPPRESS or narrow a candidate");
    expect(clause).toContain("the gate wins");
    expect(clause).toContain("- Never extract facts about: 사내 인사 평가; 급여");
    expect(clause).toContain("- Never emit a fact or observation whose text matches: /\\bsk-[A-Za-z0-9_-]{16,}/");
    expect(clause).toContain("- Prefer fact_kr in Korean");
  });

  it("is EMPTY when there is nothing to say, and then the prompt is unchanged", () => {
    const empty = { ...rules, excludeTopics: [], neverExtract: [], decisionHints: [], preferredLanguage: null };
    expect(renderExtractionConstraintClause(empty)).toBe("");
    expect(composeExtractionSystemPrompt("BASE", empty)).toBe("BASE");
    expect(composeExtractionSystemPrompt("BASE", null)).toBe("BASE");
  });

  it("APPENDS, always — base + blank line + clause, never an edit", async () => {
    const { EXTRACTION_SYSTEM_PROMPT } = await import("../src/fact-extractor.js");
    const composed = composeExtractionSystemPrompt(EXTRACTION_SYSTEM_PROMPT, rules);
    expect(composed.startsWith(`${EXTRACTION_SYSTEM_PROMPT}\n\n`)).toBe(true);
    expect(composed.slice(EXTRACTION_SYSTEM_PROMPT.length + 2)).toBe(
      renderExtractionConstraintClause(rules),
    );
  });
});

describe("what the overlay may NEVER touch", () => {
  it("keeps the extraction policy constant and its version string", async () => {
    const { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_POLICY_VERSION } = await import(
      "../src/fact-extractor.js"
    );
    // The constant is the thing `policy_version: precision-durability-v4` names.
    // Editing it would silently redefine what every stored receipt claims.
    expect(EXTRACTION_POLICY_VERSION).toBe("precision-durability-v4");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("precision-durability-v4");
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("User rule overlay");
  });

  it("leaves the fail-closed entailment verifier BYTE-IDENTICAL with and without rules", async () => {
    const extractor = await import("../src/fact-extractor.js");
    const before = extractor.FACT_ENTAILMENT_VERIFIER_PROMPT;
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    resetExtractionRulesCache();
    expect(loadExtractionRules().present).toBe(true);
    // The verifier is what makes a saved fact trustworthy; an operator rule set
    // must not be able to reach it at all.
    expect(extractor.FACT_ENTAILMENT_VERIFIER_PROMPT).toBe(before);
    expect(extractor.FACT_ENTAILMENT_POLICY_VERSION).toBe("authoritative-entailment-v3");
  });

  it("leaves the extraction USER message unchanged", async () => {
    const { buildExtractionPrompt } = await import("../src/fact-extractor.js");
    const window = [
      {
        rowid: 1,
        id: "e0",
        user_message: "hello",
        assistant_message: "hi",
        provenance: null,
        assistant_learnable: 1,
        has_memex_recall: 0,
      },
    ] as unknown as Parameters<typeof buildExtractionPrompt>[0];
    const before = buildExtractionPrompt(window, []);
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    resetExtractionRulesCache();
    expect(buildExtractionPrompt(window, [])).toBe(before);
  });
});

describe("load, cache and the fail-closed direction", () => {
  it("is absent by default and invalidates on an atomic write", () => {
    expect(loadExtractionRules().present).toBe(false);
    expect(loadExtractionRules().hash).toBeNull();
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    const loaded = loadExtractionRules();
    expect(loaded.present).toBe(true);
    expect(loaded.global.neverExtract).toHaveLength(1);
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }, { id: "q", source: "ghp_x" }]));
    expect(loadExtractionRules().global.neverExtract).toHaveLength(2);
  });

  it("never throws on a corrupt file — it reports and the caller HOLDS", () => {
    fs.mkdirSync(path.join(root, "overlays"), { recursive: true });
    fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ not json");
    resetExtractionRulesCache();
    const loaded = loadExtractionRules();
    expect(loaded.present).toBe(true);
    expect(loaded.doc).toBeNull();
    expect(loaded.issues.map((i) => i.code)).toContain("OVERLAY_UNREADABLE");
    expect(extractionRulesPreClaimBlock(loaded)?.reason).toBe("extraction_rules_invalid");
  });

  it("does NOT hold when the overlay is simply absent or disabled by env", () => {
    expect(extractionRulesPreClaimBlock(loadExtractionRules())).toBeNull();
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    process.env.MEMEX_DISABLE_OVERLAYS = "1";
    resetExtractionRulesCache();
    const disabled = loadExtractionRules();
    expect(disabled.disabledByEnv).toBe(true);
    expect(disabled.global.neverExtract).toEqual([]);
    expect(extractionRulesPreClaimBlock(disabled)).toBeNull();
  });

  it("falls back to the LAST VALID load when the file breaks mid-claim (D4)", () => {
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    expect(loadExtractionRules().doc).not.toBeNull();
    // No cache reset: the mtime/size/ino key changes on its own, which is
    // exactly what a real mid-claim edit looks like to the extractor.
    fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ broken");
    const reloaded = reloadExtractionRulesIfChanged();
    expect(reloaded.staleRead).toBe(true);
    // The claim keeps the rules it started with rather than losing them.
    expect(reloaded.global.neverExtract.map((p) => p.id)).toEqual(["p"]);
  });
});

describe("the union that makes relaxation take effect NEXT claim (G2)", () => {
  const a: NeverExtractPattern = { id: "A", source: "alpha", flags: "", scope: "both" };
  const b: NeverExtractPattern = { id: "B", source: "beta", flags: "", scope: "both" };

  it("keeps a claim-time pattern that has since been deleted", () => {
    expect(unionNeverExtract([a], []).map((p) => p.id)).toEqual(["A"]);
  });

  it("adds a pattern that appeared after the claim", () => {
    expect(unionNeverExtract([a], [a, b]).map((p) => p.id)).toEqual(["A", "B"]);
  });

  it("does not duplicate the same pattern", () => {
    expect(unionNeverExtract([a], [{ ...a }])).toHaveLength(1);
  });
});

describe("doctor checks and the benchmark observation", () => {
  it("reports absent, applied and invalid", () => {
    expect(extractionRulesChecks()[0]).toMatchObject({
      name: "extraction-rules-overlay",
      status: "ok",
      detail: "absent",
    });
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    resetExtractionRulesCache();
    expect(extractionRulesChecks()[0].status).toBe("ok");
    expect(extractionRulesChecks()[0].detail).toContain("1 rule(s)");
    fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ broken");
    resetExtractionRulesCache();
    const invalid = extractionRulesChecks()[0];
    expect(invalid.status).toBe("fail");
    expect(invalid.detail).toContain("EXTRACTION IS HELD");
  });

  it("fails — never warns — while a job is held, and only for OUR reasons", () => {
    const ok = extractionRulesChecks([{ reason: "model_config_rejected", jobs: 3 }]);
    expect(ok[1]).toMatchObject({ name: "extraction-rules-hold", status: "ok" });
    const held = extractionRulesChecks([
      { reason: "extraction_rules_invalid", jobs: 2 },
      { reason: "extraction_rules_unavailable", jobs: 1 },
    ]);
    expect(held[1].status).toBe("fail");
    expect(held[1].detail).toContain("3 job(s) held");
    expect(held[1].detail).toContain("nothing was stored");
  });

  it("OBSERVES the benchmark environment rather than echoing the env var", () => {
    expect(observeOverlayBenchmarkEnvironment()).toEqual({
      recall_gate: "absent",
      extraction_rules: "absent",
      quarantine: "absent",
      disabled_by_env: false,
    });
    writeRules(root, rulesDoc([{ id: "p", source: "sk-[a-z]{4,}" }]));
    process.env.MEMEX_DISABLE_OVERLAYS = "1";
    // The file is still there even though the env var says overlays are off, and
    // the report has to say BOTH — otherwise a polluted benchmark root passes by
    // merely claiming it was clean.
    expect(observeOverlayBenchmarkEnvironment()).toMatchObject({
      extraction_rules: "present",
      disabled_by_env: true,
    });
  });
});

describe("the empty document", () => {
  it("is valid, hashes, and is what resetOverlay writes", () => {
    const empty = emptyExtractionRulesDoc();
    const result = validateExtractionRulesDoc(empty);
    expect(result.ok).toBe(true);
    expect(extractionRulesDocHash(result.doc!)).toMatch(/^rules:[0-9a-f]{8}$/);
    // A reset writes this document rather than unlinking the file, so the change
    // keeps a revision, a snapshot and a rollback target. It must still render
    // nothing, or every prompt would carry an empty rule block forever.
    writeRules(root, empty);
    expect(renderExtractionConstraintClause(resolveExtractionRules(null))).toBe("");
    expect(loadExtractionRules().present).toBe(true);
  });
});
