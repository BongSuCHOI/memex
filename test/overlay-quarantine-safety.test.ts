/**
 * The quarantine file is shared state, and two things about it were wrong.
 *
 *  1. A rules write cleared quarantine rows for patterns it had NOT changed.
 *     `applyOverlayChange` passed `null` as the document for the `extraction-rules`
 *     overlay, so the live set was empty and every row the overlay owned was
 *     reaped — re-saving the same regex, or editing only `preferred_language`,
 *     un-quarantined a pattern that still blows its budget and released the hold
 *     behind it. §2.3.4's contract is that EDITING a pattern clears its row,
 *     nothing else does.
 *  2. The write was read-merge-rename with no concurrency control at all, so two
 *     processes that read the same previous file lost whichever row the later
 *     rename did not know about. A stamp compare-and-swap narrowed that; it could
 *     not close it, because the `rename` is a syscall LATER than the check. The
 *     whole read-merge-rename now runs inside a write mutex.
 *  3. A row kept in memory for ever after a successful write made a long-running
 *     process ignore another process's `quarantine clear` — and put the cleared
 *     row back in the file on its next write. A persisted row is a MIRROR of the
 *     file; only an unpersisted row is this process's own fallback.
 *
 * A temp `MEMEX_OVERLAY_DIR` is pinned, not just `MEMEX_HOME`: the override wins,
 * and these tests write real overlay files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadExtractionRules,
  resetExtractionRulesCache,
  setExtractionRules,
} from "../src/extraction-rules.js";
import {
  quarantinePattern,
  replaceQuarantine,
  readQuarantine,
  resetQuarantineMemory,
  type QuarantineEntry,
} from "../src/overlay-matcher.js";
import { patternSourceSha8 } from "../src/overlay-regex.js";

const PATTERN = "\\bsk-[A-Za-z0-9_-]{16,}";
const OTHER = "\\bghp_[A-Za-z0-9]{20,}";

let root: string;
let overlayDir: string;
let quarantineFile: string;
let env: Record<string, string | undefined>;

function entry(id: string, source: string, flags = ""): QuarantineEntry {
  return {
    overlay: "extraction-rules",
    pattern_id: id,
    source_sha8: patternSourceSha8(source, flags),
    at: new Date().toISOString(),
    elapsed_ms: 50,
    input_chars: 100,
    surface: "extractor",
  };
}

/** Write the file the way ANOTHER process would: tmp + rename, no coordination. */
function writeFileAsOtherProcess(entries: QuarantineEntry[]): void {
  const tmp = `${quarantineFile}.other.tmp`;
  fs.mkdirSync(path.dirname(quarantineFile), { recursive: true });
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ schema: "memex.overlay-quarantine", version: 1, entries }, null, 2)}\n`,
  );
  fs.renameSync(tmp, quarantineFile);
}

function fileEntryIds(): string[] {
  const parsed = JSON.parse(fs.readFileSync(quarantineFile, "utf8")) as { entries: QuarantineEntry[] };
  return parsed.entries.map((row) => row.pattern_id).sort();
}

function rulesDoc(patterns: Array<{ id: string; source: string }>, extra: Record<string, unknown> = {}) {
  return {
    schema: "memex.extraction-rules-overlay",
    version: 1,
    never_extract_patterns: patterns.map((pattern) => ({
      id: pattern.id,
      source: pattern.source,
      flags: "",
      scope: "both" as const,
    })),
    ...extra,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memex-quarantine-"));
  env = {
    MEMEX_HOME: process.env.MEMEX_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    MEMEX_OVERLAY_DIR: process.env.MEMEX_OVERLAY_DIR,
    MEMEX_DISABLE_OVERLAYS: process.env.MEMEX_DISABLE_OVERLAYS,
  };
  process.env.MEMEX_HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
  overlayDir = path.join(root, "overlays");
  process.env.MEMEX_OVERLAY_DIR = overlayDir;
  delete process.env.MEMEX_DISABLE_OVERLAYS;
  quarantineFile = path.join(overlayDir, "quarantine.json");
  fs.mkdirSync(overlayDir, { recursive: true });
  resetQuarantineMemory();
  resetExtractionRulesCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuarantineMemory();
  resetExtractionRulesCache();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("saving extraction rules only clears the patterns it changed", () => {
  it("keeps the row when a pattern is re-saved untouched and only a language changes", async () => {
    await setExtractionRules(rulesDoc([{ id: "user.secret", source: PATTERN }]), {
      surface: "cli",
      probe: false,
    });
    quarantinePattern(entry("user.secret", PATTERN));
    resetQuarantineMemory(); // prove it came from the FILE, not this process's memory
    expect(readQuarantine().map((row) => row.pattern_id)).toEqual(["user.secret"]);

    await setExtractionRules(
      rulesDoc([{ id: "user.secret", source: PATTERN }], { preferred_language: "ko" }),
      { surface: "cli", probe: false, expectedRevision: 1 },
    );

    // Still quarantined, so the rule is still OFF and extraction still HOLDS —
    // which is the only honest state for a pattern that has not been fixed.
    expect(readQuarantine().map((row) => row.pattern_id)).toEqual(["user.secret"]);
    resetExtractionRulesCache();
    const loaded = loadExtractionRules();
    expect(loaded.quarantined.map((row) => row.pattern_id)).toEqual(["user.secret"]);
    expect(loaded.issues.some((issue) => issue.code === "PATTERN_QUARANTINED")).toBe(true);
  });

  it("clears the row when the regex itself is edited", async () => {
    await setExtractionRules(rulesDoc([{ id: "user.secret", source: PATTERN }]), {
      surface: "cli",
      probe: false,
    });
    quarantinePattern(entry("user.secret", PATTERN));
    resetQuarantineMemory();

    await setExtractionRules(rulesDoc([{ id: "user.secret", source: OTHER }]), {
      surface: "cli",
      probe: false,
      expectedRevision: 1,
    });

    expect(readQuarantine()).toEqual([]);
  });

  it("clears the row when the pattern is removed outright", async () => {
    await setExtractionRules(rulesDoc([{ id: "user.secret", source: PATTERN }]), {
      surface: "cli",
      probe: false,
    });
    quarantinePattern(entry("user.secret", PATTERN));
    resetQuarantineMemory();

    await setExtractionRules(rulesDoc([]), { surface: "cli", probe: false, expectedRevision: 1 });

    expect(readQuarantine()).toEqual([]);
  });

  it("never touches another overlay's rows", async () => {
    quarantinePattern({ ...entry("gate.slow", PATTERN), overlay: "recall-gate" });
    resetQuarantineMemory();

    await setExtractionRules(rulesDoc([]), { surface: "cli", probe: false });

    expect(readQuarantine().map((row) => row.pattern_id)).toEqual(["gate.slow"]);
  });
});

describe("a quarantine write cannot lose a concurrent writer's row", () => {
  it("retries when the file moved between the read and the rename", () => {
    quarantinePattern(entry("first", PATTERN));
    resetQuarantineMemory();

    // Another process writes its own row in the window between our read and our
    // rename. Without the compare-and-swap our rename lands anyway and its row
    // is gone.
    const real = fs.writeFileSync;
    let injected = false;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: never, data: never, options: never) => {
      const result = (real as unknown as typeof fs.writeFileSync)(file, data, options);
      if (!injected && String(file).startsWith(quarantineFile) && String(file).endsWith(".tmp")) {
        injected = true;
        writeFileAsOtherProcess([entry("first", PATTERN), entry("concurrent", OTHER)]);
      }
      return result;
    }) as typeof fs.writeFileSync);

    quarantinePattern(entry("ours", "\\bxoxb-[A-Za-z0-9-]{10,}"));

    expect(injected).toBe(true);
    expect(fileEntryIds()).toEqual(["concurrent", "first", "ours"]);
  });

  it("refuses a concurrent write BETWEEN the stamp check and the rename", () => {
    // The stamp CAS is read at one instant and the `rename` is a later syscall, so
    // a second writer that passed the same check in between used to have its rows
    // overwritten — silently, because a new process cannot tell a lost row from a
    // row that was never written. The seam is the rename itself: by then the stamp
    // has been checked and the file has not moved yet.
    let injected = false;
    let competitorWrote: boolean | null = null;
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((from: never, to: never) => {
      if (!injected && String(to) === quarantineFile) {
        injected = true;
        competitorWrote = replaceQuarantine([entry("concurrent", OTHER)]);
      }
      return (realRename as unknown as typeof fs.renameSync)(from, to);
    }) as typeof fs.renameSync);

    quarantinePattern(entry("ours", PATTERN));

    expect(injected).toBe(true);
    // Told no, rather than landing a write our rename then erases.
    expect(competitorWrote).toBe(false);
    expect(fileEntryIds()).toEqual(["ours"]);
  });

  it("drops a persisted row once another process has cleared the file", () => {
    quarantinePattern(entry("ours", PATTERN));
    expect(fileEntryIds()).toEqual(["ours"]);

    // Another process ran `memex gate quarantine clear --all`.
    writeFileAsOtherProcess([]);

    // A long-running process has to honour that: the file is the source of truth
    // for a row that reached it, and our copy is only a mirror of it.
    expect(readQuarantine()).toEqual([]);
    // And the mirror must not come back through our next write either.
    quarantinePattern(entry("later", OTHER));
    expect(fileEntryIds()).toEqual(["later"]);
  });

  it("keeps an UNPERSISTED row when the file could not be written", () => {
    // A read-only data root: the exclusion still holds in this process, and that
    // row exists nowhere else, so a readable file must not prune it away.
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((from: never, to: never) => {
      if (String(to) === quarantineFile) throw new Error("EROFS");
      return (realRename as unknown as typeof fs.renameSync)(from, to);
    }) as typeof fs.renameSync);
    quarantinePattern(entry("ours", PATTERN));
    vi.restoreAllMocks();

    expect(fs.existsSync(quarantineFile)).toBe(false);
    writeFileAsOtherProcess([entry("theirs", OTHER)]);
    expect(readQuarantine().map((row) => row.pattern_id).sort()).toEqual(["ours", "theirs"]);
  });

  it("merges rows a previous writer put in the file", () => {
    writeFileAsOtherProcess([entry("theirs", OTHER)]);
    quarantinePattern(entry("ours", PATTERN));
    expect(fileEntryIds()).toEqual(["ours", "theirs"]);
  });
});
