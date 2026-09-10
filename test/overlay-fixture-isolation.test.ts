/**
 * The overlay suites must not be able to reach a real overlay directory (#30 §7).
 *
 * `MEMEX_OVERLAY_DIR` has a HIGHER priority than `MEMEX_HOME` in src/paths.ts, and
 * the extraction-rules fixtures used to set only `MEMEX_HOME`. In a shell where the
 * override is exported — a benchmark harness, a second checkout, an operator
 * pointing the CLI at another directory — those suites called the production
 * `setExtractionRules` with no revision guard against the REAL rules file, and
 * rewrote its history index and quarantine with it.
 *
 * This suite deliberately exports the hazard and proves the fixture helper beats
 * it, in both directions: the write lands in the temp root, and the sentinel
 * directory is byte-identical afterwards.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractionRulesOverlayPath, overlayDir } from "../src/paths.js";
import { resetExtractionRulesCache, setExtractionRules } from "../src/extraction-rules.js";
import { resetQuarantineMemory } from "../src/overlay-matcher.js";
import { pinOverlayEnv, restoreOverlayEnv } from "./extraction-rules-fixture.js";

const SENTINEL = {
  schema: "memex.extraction-rules-overlay",
  version: 1,
  revision: 9,
  exclude_topics: ["사내 인사 평가"],
  never_extract_patterns: [] as unknown[],
};

let tmp: string;
let sentinelDir: string;
let workRoot: string;
let outer: Record<string, string | undefined>;

/** Every byte of every file under `dir`, so "unchanged" means exactly that. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      for (const [key, value] of Object.entries(snapshot(full))) out[`${name}/${key}`] = value;
      continue;
    }
    out[name] = fs.readFileSync(full, "utf8");
  }
  return out;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "memex-overlay-isolation-"));
  sentinelDir = path.join(tmp, "real-overlays");
  workRoot = path.join(tmp, "work");
  fs.mkdirSync(sentinelDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sentinelDir, "extraction-rules.json"),
    `${JSON.stringify(SENTINEL, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(sentinelDir, "history.jsonl"), "");
  outer = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  // The inherited hazard: an operator's override is exported in this shell.
  process.env.MEMEX_OVERLAY_DIR = sentinelDir;
  resetQuarantineMemory();
  resetExtractionRulesCache();
});

afterEach(() => {
  restoreOverlayEnv();
  for (const [key, value] of Object.entries(outer)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuarantineMemory();
  resetExtractionRulesCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("pinOverlayEnv", () => {
  it("is the only thing that redirects the overlay path away from the override", () => {
    // Setting MEMEX_HOME alone is NOT enough — this is the defect, stated.
    process.env.MEMEX_HOME = workRoot;
    expect(overlayDir()).toBe(sentinelDir);
    expect(extractionRulesOverlayPath()).toBe(path.join(sentinelDir, "extraction-rules.json"));

    pinOverlayEnv(workRoot);
    expect(overlayDir()).toBe(path.join(workRoot, "overlays"));
    expect(extractionRulesOverlayPath()).toBe(
      path.join(workRoot, "overlays", "extraction-rules.json"),
    );
  });

  it("leaves a real overlay directory byte-identical across a production write", async () => {
    const before = snapshot(sentinelDir);
    pinOverlayEnv(workRoot);

    const result = await setExtractionRules(
      {
        schema: "memex.extraction-rules-overlay",
        version: 1,
        never_extract_patterns: [
          { id: "user.secret", source: "\\bsk-[A-Za-z0-9_-]{16,}", flags: "", scope: "both" },
        ],
      },
      { surface: "cli", probe: false },
    );

    expect(result.revision).toBe(1);
    expect(fs.existsSync(path.join(workRoot, "overlays", "extraction-rules.json"))).toBe(true);
    expect(snapshot(sentinelDir)).toEqual(before);
  });

  it("restores the inherited override afterwards", () => {
    pinOverlayEnv(workRoot);
    expect(process.env.MEMEX_OVERLAY_DIR).toBe(path.join(workRoot, "overlays"));
    restoreOverlayEnv();
    expect(process.env.MEMEX_OVERLAY_DIR).toBe(sentinelDir);
  });
});
