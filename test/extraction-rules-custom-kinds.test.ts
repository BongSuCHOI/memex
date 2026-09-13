/**
 * `custom_fact_kinds` — the operator's own fact categories (#121).
 *
 * The feature is small; what makes it dangerous is that the id is not a display
 * string. It is written into `facts.category`, so it outlives the overlay entry
 * that defined it, travels through search filters and exports, and is read back
 * by screens that have no idea a rules file exists. Three properties follow, and
 * they are what this file pins:
 *
 *  1. **Ids can never collide with the built-in five.** A kind called `decision`
 *     would retroactively change the meaning of every fact already stored under
 *     that value, and nothing in the system could tell the two apart afterwards.
 *  2. **A bad kind list fails the whole overlay, never a row.** Dropping one
 *     malformed entry would apply a NARROWER kind list than the operator wrote,
 *     and candidates carrying the missing id would then be dropped silently.
 *  3. **Acceptance is `claim snapshot ∪ latest`, like `never_extract` (G2).**
 *     Deleting a kind while a claim is in flight must not start dropping that
 *     claim's candidates — the model call is already spent, and the drop would
 *     lose the fact rather than relabel it. Removal lands on the NEXT claim.
 *
 * The prompt assertions matter for a different reason: a kind is the one rule
 * item that ADDS a value rather than removing one, so the clause has to keep
 * saying that it cannot widen eligibility.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_FACT_KINDS,
  CUSTOM_FACT_KIND_ID,
  EXTRACTION_RULES_LIMITS,
  RESERVED_FACT_KIND_IDS,
  UI_BADGE_RESERVED_IDS,
  acceptedCustomFactKindIds,
  composeExtractionSystemPrompt,
  customFactKindRegistry,
  emptyExtractionRulesDoc,
  extractionRulesChecks,
  extractionRulesDocHash,
  isEmptyExtractionRules,
  loadExtractionRules,
  renderCustomFactKindLines,
  renderExtractionConstraintClause,
  resetExtractionRulesCache,
  resolveExtractionRules,
  unionCustomFactKinds,
  validateExtractionRulesDoc,
  type CustomFactKind,
  type ExtractionRulesDoc,
} from "../src/extraction-rules.js";
import { pinOverlayEnv, removeRules, restoreOverlayEnv, writeRules } from "./extraction-rules-fixture.js";

let root: string;

const RUNBOOK: CustomFactKind = {
  id: "runbook",
  label_en: "Runbook step",
  label_ko: "운영 절차",
  description: "A step an operator must follow when this system misbehaves.",
  extraction_hint: "the human describes a repeatable recovery action",
};
const POSTMORTEM: CustomFactKind = {
  id: "postmortem",
  label_en: "Postmortem finding",
  label_ko: "사후 분석 결과",
  description: "A conclusion drawn after an incident was resolved.",
};

function doc(kinds: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "memex.extraction-rules-overlay",
    version: 1,
    revision: 1,
    custom_fact_kinds: kinds,
    ...extra,
  };
}

/** The codes of every error-severity issue, so assertions read as intent. */
function errorCodes(issues: Array<{ severity?: string; code: string }>): string[] {
  return issues.filter((issue) => issue.severity === "error").map((issue) => issue.code);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-custom-kinds-"));
  pinOverlayEnv(root);
  resetExtractionRulesCache();
});

afterEach(() => {
  resetExtractionRulesCache();
  restoreOverlayEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("custom_fact_kinds — schema", () => {
  it("accepts a well-formed list and fills the applied document", () => {
    const result = validateExtractionRulesDoc(doc([RUNBOOK, POSTMORTEM]));
    expect(result.ok).toBe(true);
    expect(result.doc?.custom_fact_kinds).toEqual([RUNBOOK, POSTMORTEM]);
    // `emptyExtractionRulesDoc` has to carry the key, or a reset would leave the
    // field absent and the next merge would think the operator never set it.
    expect(emptyExtractionRulesDoc().custom_fact_kinds).toEqual([]);
  });

  it("refuses an id that collides with a built-in category", () => {
    for (const builtin of BUILTIN_FACT_KINDS) {
      const result = validateExtractionRulesDoc(doc([{ ...RUNBOOK, id: builtin }]));
      expect(result.ok).toBe(false);
      expect(errorCodes(result.issues)).toContain("KIND_ID_RESERVED");
      expect(result.doc).toBeNull();
    }
  });

  /**
   * Post-0.7.5 review P2 #4. `ui.mjs`'s `name()` resolves `badge.<value>.label`
   * BEFORE an overlay label — deliberately, so a runtime kind cannot shadow a
   * core enum's name — which meant a kind called `active` validated fine and
   * then displayed as the STATE "활성" on the badge while the filter chip showed
   * the operator's own label. Reserving the dictionary's ids is the only fix
   * that does not weaken that precedence.
   */
  it("refuses an id that a badge.* dictionary key already names", async () => {
    for (const id of ["active", "running", "failed", "global", "workspace", "sync"]) {
      expect(CUSTOM_FACT_KIND_ID.test(id)).toBe(true); // the shape is fine; the NAME is taken
      const result = validateExtractionRulesDoc(doc([{ ...RUNBOOK, id }]));
      expect(result.ok, id).toBe(false);
      expect(errorCodes(result.issues)).toContain("KIND_ID_RESERVED");
      expect(result.doc).toBeNull();
      const issue = result.issues.find((entry) => entry.code === "KIND_ID_RESERVED");
      expect(issue?.params).toMatchObject({ id, reservedByBadge: true });
    }
    // A built-in still reports as a built-in, not as a badge name.
    const builtin = validateExtractionRulesDoc(doc([{ ...RUNBOOK, id: "decision" }]));
    expect(
      builtin.issues.find((entry) => entry.code === "KIND_ID_RESERVED")?.params,
    ).toMatchObject({ reservedByBadge: false });
    // A kind the dictionary does NOT name is still accepted.
    expect(validateExtractionRulesDoc(doc([RUNBOOK, POSTMORTEM])).ok).toBe(true);
  });

  /**
   * The reservation list is DERIVED, not maintained: this is the derivation.
   * Adding a `badge.*` key to the dictionary reserves the id, and this
   * assertion is what makes that true — the constant lives in core because the
   * validator is synchronous and must not need the UI bundle at runtime.
   */
  it("reserves exactly the ids the badge dictionaries name", async () => {
    const ids = new Set<string>();
    for (const locale of ["en", "ko"]) {
      const dict = (await import(`../ui/public/i18n/badge/${locale}.mjs`)).default as Record<
        string,
        string
      >;
      for (const key of Object.keys(dict)) {
        const match = /^badge\.(.+)\.(label|help)$/.exec(key);
        expect(match, key).not.toBeNull();
        ids.add(match![1]);
      }
    }
    expect(ids.size).toBeGreaterThan(60);
    expect([...UI_BADGE_RESERVED_IDS].sort()).toEqual([...ids].sort());
    for (const builtin of BUILTIN_FACT_KINDS) expect(RESERVED_FACT_KIND_IDS.has(builtin)).toBe(true);
    for (const id of ids) expect(RESERVED_FACT_KIND_IDS.has(id)).toBe(true);
  });

  it("refuses an id that is not lowercase snake_case of 2-24 characters", () => {
    for (const id of ["R", "Runbook", "run-book", "run book", "1runbook", "a".repeat(25), ""]) {
      expect(CUSTOM_FACT_KIND_ID.test(id)).toBe(false);
      const result = validateExtractionRulesDoc(doc([{ ...RUNBOOK, id }]));
      expect(errorCodes(result.issues)).toContain("KIND_ID_INVALID");
    }
    for (const id of ["ab", "run_book", "r2d2", "a".repeat(24)]) {
      expect(CUSTOM_FACT_KIND_ID.test(id)).toBe(true);
      expect(validateExtractionRulesDoc(doc([{ ...RUNBOOK, id }])).ok).toBe(true);
    }
  });

  it("caps the list at 8 and reports the count", () => {
    const limit = EXTRACTION_RULES_LIMITS.counts.customFactKinds;
    expect(limit).toBe(8);
    const many = Array.from({ length: limit + 1 }, (_unused, index) => ({
      ...RUNBOOK,
      id: `kind_${index}`,
    }));
    const result = validateExtractionRulesDoc(doc(many));
    expect(result.ok).toBe(false);
    const issue = result.issues.find((entry) => entry.code === "KIND_COUNT_EXCEEDED");
    expect(issue?.params).toMatchObject({ count: limit + 1, limit });
  });

  it("requires both labels and a description, and refuses a duplicate id", () => {
    const cases: Array<[unknown, string]> = [
      [{ ...RUNBOOK, label_ko: "" }, "KIND_LABEL_INVALID"],
      [{ ...RUNBOOK, label_en: undefined }, "KIND_LABEL_INVALID"],
      [{ ...RUNBOOK, label_en: "a".repeat(41) }, "KIND_LABEL_INVALID"],
      [{ ...RUNBOOK, description: undefined }, "KIND_DESCRIPTION_INVALID"],
      [{ ...RUNBOOK, description: "line\nbreak" }, "KIND_DESCRIPTION_INVALID"],
      [{ ...RUNBOOK, extraction_hint: "a".repeat(201) }, "KIND_HINT_INVALID"],
      ["not an object", "OVERLAY_NOT_OBJECT"],
    ];
    for (const [entry, code] of cases) {
      expect(errorCodes(validateExtractionRulesDoc(doc([entry])).issues)).toContain(code);
    }
    expect(errorCodes(validateExtractionRulesDoc(doc([RUNBOOK, RUNBOOK])).issues)).toContain(
      "KIND_DUPLICATE_ID",
    );
    expect(errorCodes(validateExtractionRulesDoc(doc({ id: "runbook" })).issues)).toContain(
      "OVERLAY_NOT_OBJECT",
    );
  });

  it("points at the offending row with an Issue path the Web UI can render", () => {
    const result = validateExtractionRulesDoc(doc([RUNBOOK, { ...POSTMORTEM, id: "decision" }]));
    const issue = result.issues.find((entry) => entry.code === "KIND_ID_RESERVED");
    expect(issue?.path).toBe("custom_fact_kinds[1].id");
    expect(issue?.row).toBe(1);
    expect(issue?.field).toBe("id");
  });

  it("moves the rules hash when a label or hint changes", () => {
    const base = validateExtractionRulesDoc(doc([RUNBOOK])).doc as ExtractionRulesDoc;
    const relabelled = validateExtractionRulesDoc(
      doc([{ ...RUNBOOK, label_ko: "운영 런북" }]),
    ).doc as ExtractionRulesDoc;
    const rehinted = validateExtractionRulesDoc(
      doc([{ ...RUNBOOK, extraction_hint: "something else entirely" }]),
    ).doc as ExtractionRulesDoc;
    expect(extractionRulesDocHash(base)).not.toBe(extractionRulesDocHash(relabelled));
    expect(extractionRulesDocHash(base)).not.toBe(extractionRulesDocHash(rehinted));
    // Re-saving the same rules must NOT move it, or the drift report cries wolf.
    expect(extractionRulesDocHash(base)).toBe(
      extractionRulesDocHash(validateExtractionRulesDoc(doc([RUNBOOK], { revision: 9 })).doc!),
    );
  });

  it("is no longer an unknown field, and genuinely unknown fields still warn", () => {
    const result = validateExtractionRulesDoc(doc([RUNBOOK], { invented_field: 1 }));
    expect(result.ok).toBe(true);
    const unknown = result.issues.filter((issue) => issue.code === "OVERLAY_UNKNOWN_FIELD");
    expect(unknown.map((issue) => issue.path)).toEqual(["invented_field"]);
  });
});

describe("custom_fact_kinds — resolution", () => {
  it("unions a project override onto the global list, global winning a collision", () => {
    writeRules(
      root,
      doc([RUNBOOK], {
        project_overrides: {
          "/p": {
            custom_fact_kinds: [{ ...RUNBOOK, label_en: "Override wins?" }, POSTMORTEM],
          },
        },
      }),
    );
    const loaded = loadExtractionRules();
    expect(loaded.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    const resolved = resolveExtractionRules("/p", loaded);
    expect(resolved.customFactKinds.map((kind) => kind.id)).toEqual(["runbook", "postmortem"]);
    // A project may ADD a kind; it may not relabel a global one, or the same
    // stored `facts.category` value would carry two different badge texts.
    expect(resolved.customFactKinds[0].label_en).toBe(RUNBOOK.label_en);
    expect(resolveExtractionRules(null, loaded).customFactKinds.map((k) => k.id)).toEqual(["runbook"]);
  });

  it("counts as a non-empty rule set on its own", () => {
    writeRules(root, doc([RUNBOOK]));
    const rules = resolveExtractionRules(null, loadExtractionRules());
    expect(isEmptyExtractionRules(rules)).toBe(false);
    // …and doctor counts it, so `applied: … N rule(s)` is not silently short.
    const check = extractionRulesChecks().find((entry) => entry.name === "extraction-rules-overlay");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("1 rule(s)");
  });

  it("unionCustomFactKinds keeps the first definition of an id", () => {
    const merged = unionCustomFactKinds([RUNBOOK], [{ ...RUNBOOK, label_en: "later" }, POSTMORTEM]);
    expect(merged.map((kind) => kind.id)).toEqual(["runbook", "postmortem"]);
    expect(merged[0].label_en).toBe(RUNBOOK.label_en);
  });

  /**
   * Post-0.7.5 review P2 #3 — the DISPLAY registry spans every scope, which
   * `resolveExtractionRules(null)` does not. The Web UI's bootstrap used the
   * latter, so a kind defined only in a project override had no label anywhere.
   */
  it("customFactKindRegistry unions global with every project override", () => {
    writeRules(
      root,
      doc([RUNBOOK], {
        project_overrides: {
          "project-alpha": { custom_fact_kinds: [POSTMORTEM] },
          // A project that re-declares the global kind VERBATIM says nothing new,
          // so it adds no row — only its own name to the global entry.
          "project-beta": { custom_fact_kinds: [{ ...RUNBOOK }] },
        },
      }),
    );
    const loaded = loadExtractionRules();
    expect(resolveExtractionRules(null, loaded).customFactKinds.map((k) => k.id)).toEqual([
      "runbook",
    ]);

    const registry = customFactKindRegistry(loaded);
    expect(registry.map((kind) => kind.id)).toEqual(["runbook", "postmortem"]);
    expect(registry[0].label_en).toBe(RUNBOOK.label_en);
    expect(registry[0].global).toBe(true);
    expect(registry[0].projects).toEqual(["project-beta"]);
    expect(registry[1].global).toBe(false);
    expect(registry[1].projects).toEqual(["project-alpha"]);

    // No rules file at all is an empty registry, never a throw.
    removeRules(root);
    resetExtractionRulesCache();
    expect(customFactKindRegistry(loadExtractionRules())).toEqual([]);
  });

  /**
   * Post-0.7.6 review P2 #4 — an id is not a definition.
   *
   * The validator accepts the same id in two overrides with different labels and
   * different meanings, and the extractor already resolves it per project. The
   * display registry merged them under the id alone, so whichever override the
   * file happened to list first supplied the label for BOTH projects' facts:
   * reordering the keys silently changed what the screen said a stored
   * `facts.category` value MEANT. Each definition gets its own entry.
   */
  it("keeps one entry per (project, id) when overrides define an id differently", () => {
    const alpha = { ...RUNBOOK, label_en: "Alpha runbook", label_ko: "알파 운영 절차", description: "Alpha's own recovery step." };
    const beta = { ...RUNBOOK, label_en: "Beta runbook", label_ko: "베타 운영 절차", description: "Beta's own recovery step." };
    writeRules(
      root,
      doc([], {
        project_overrides: {
          "/work/alpha": { custom_fact_kinds: [alpha] },
          "/work/beta": { custom_fact_kinds: [beta] },
        },
      }),
    );
    const registry = customFactKindRegistry(loadExtractionRules());
    expect(registry.map((kind) => [kind.id, kind.label_ko, kind.global, kind.projects])).toEqual([
      ["runbook", "알파 운영 절차", false, ["/work/alpha"]],
      ["runbook", "베타 운영 절차", false, ["/work/beta"]],
    ]);
    // Each project's extractor already sees its own definition — the registry now
    // agrees with it instead of contradicting it.
    for (const [project, expected] of [["/work/alpha", alpha], ["/work/beta", beta]] as const) {
      const resolved = resolveExtractionRules(project, loadExtractionRules()).customFactKinds;
      expect(resolved.map((k) => k.label_ko)).toEqual([expected.label_ko]);
    }
  });

  it("keeps a global entry as the fallback for projects that do not override it", () => {
    writeRules(
      root,
      doc([RUNBOOK], {
        project_overrides: { "/work/beta": { custom_fact_kinds: [{ ...RUNBOOK, label_ko: "베타 운영 절차" }] } },
      }),
    );
    const registry = customFactKindRegistry(loadExtractionRules());
    expect(registry.map((kind) => [kind.label_ko, kind.global, kind.projects])).toEqual([
      ["운영 절차", true, []],
      ["베타 운영 절차", false, ["/work/beta"]],
    ]);
  });
});

describe("custom_fact_kinds — prompt clause", () => {
  it("lists the kinds after the built-ins, with their hints, and never widens eligibility", () => {
    writeRules(root, doc([RUNBOOK, POSTMORTEM]));
    const rules = resolveExtractionRules(null, loadExtractionRules());
    const clause = renderExtractionConstraintClause(rules);

    expect(clause).toContain("decision, preference, pattern, knowledge, constraint");
    expect(clause).toContain('category="runbook" (Runbook step)');
    expect(clause).toContain(RUNBOOK.description);
    expect(clause).toContain(`Use when: ${RUNBOOK.extraction_hint}`);
    // A kind with no hint renders without a dangling "Use when:".
    expect(clause).toContain('category="postmortem" (Postmortem finding)');
    expect(clause).not.toContain("Use when: undefined");
    // The built-in list comes first in the rendered block, and the promise that
    // the clause can only suppress survives the one item that adds a value.
    expect(clause.indexOf("built-in")).toBeLessThan(clause.indexOf('category="runbook"'));
    expect(clause).toContain("never make a candidate eligible that the gates above reject");
    // The five built-ins stay in the base prompt; this block never repeats them
    // as a replacement list.
    expect(clause).toContain("they do not replace");
  });

  it("renders nothing when no kind is defined, and composes onto the base prompt", () => {
    writeRules(root, doc([]));
    const empty = resolveExtractionRules(null, loadExtractionRules());
    expect(renderCustomFactKindLines(empty)).toEqual([]);
    expect(composeExtractionSystemPrompt("BASE", empty)).toBe("BASE");

    resetExtractionRulesCache();
    writeRules(root, doc([RUNBOOK]));
    const rules = resolveExtractionRules(null, loadExtractionRules());
    const composed = composeExtractionSystemPrompt("BASE", rules);
    expect(composed.startsWith("BASE\n\n")).toBe(true);
    expect(composed).toContain('category="runbook"');
    // Deterministic: the same rules must produce a byte-identical prompt, or a
    // no-op re-save changes what every window was asked.
    expect(composeExtractionSystemPrompt("BASE", rules)).toBe(composed);
  });
});

describe("custom_fact_kinds — accepted set is claim snapshot ∪ latest (G2)", () => {
  it("keeps a kind deleted mid-run, and picks up one added mid-run", () => {
    writeRules(root, doc([RUNBOOK]));
    const snapshot = resolveExtractionRules(null, loadExtractionRules());
    expect([...acceptedCustomFactKindIds(snapshot)]).toEqual(["runbook"]);

    // The operator deletes `runbook` and adds `postmortem` while the claim runs.
    resetExtractionRulesCache();
    writeRules(root, doc([POSTMORTEM], { revision: 2 }));
    const accepted = acceptedCustomFactKindIds(snapshot);
    // Deletion applies from the NEXT claim: this run's candidates are not dropped.
    expect(accepted.has("runbook")).toBe(true);
    // Addition is safe immediately — it can only relabel, never admit.
    expect(accepted.has("postmortem")).toBe(true);

    // A new claim reads the file fresh and the deleted kind is gone.
    resetExtractionRulesCache();
    const next = resolveExtractionRules(null, loadExtractionRules());
    expect([...acceptedCustomFactKindIds(next)]).toEqual(["postmortem"]);
  });

  it("falls back to the snapshot alone when the file cannot be read", () => {
    writeRules(root, doc([RUNBOOK]));
    const snapshot = resolveExtractionRules(null, loadExtractionRules());
    resetExtractionRulesCache();
    fs.writeFileSync(path.join(root, "overlays", "extraction-rules.json"), "{ broken");
    // A broken file holds extraction anyway (pre-claim gate); it must not also
    // make an in-flight claim start dropping candidates it was told to keep.
    expect([...acceptedCustomFactKindIds(snapshot)]).toEqual(["runbook"]);
    expect([...acceptedCustomFactKindIds(null)]).toEqual([]);
  });
});
