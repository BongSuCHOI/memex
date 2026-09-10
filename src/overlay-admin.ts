/**
 * Write side of the user overlays (§1.5, §2.4). WRITE-ONLY MODULE.
 *
 * Only the CLI and the Web UI server load this. It imports the ui-audit writer,
 * which drags in `ontology-db`, so it must never appear on the injection fast
 * path — the read leaf is src/recall-gate-overlay.ts (§1.4).
 *
 * The lock discipline follows `inject-daemon.ts:904-975`, with the three
 * corrections the v3 review forced:
 *
 *  - D3: `withOverlayLock(async body)` does `return await body()` and only then
 *    releases, so an async validation (probe included) finishes INSIDE the lock.
 *    v2's synchronous wrapper released in a `finally` that ran before the probe
 *    promise settled.
 *  - D3: the "unreadable lock" observation state is MODULE level and the second
 *    look happens 250 ms later IN THE SAME CALL. v2 rebuilt the set per call and
 *    threw on the first look, so a corrupt lock could never be recovered.
 *  - G4: observation count and acquisition attempts are separate budgets. After a
 *    successful removal the loop gets one more acquisition attempt, so a single
 *    CLI invocation actually performs the write it was asked for. v3 ended the
 *    loop right after the delete and raised `OverlayLockedError` anyway.
 *
 * A LIVE holder is never stolen from, in any branch.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  overlayDir,
  overlayFilePath,
  overlayHistoryIndexPath,
  overlayLockPath,
  overlaySnapshotDir,
  overlaySnapshotPath,
  type OverlayName,
} from "./paths.js";
import { canonicalJson, overlayIssue, patternSourceSha8, userPatternId, type Issue } from "./overlay-regex.js";
import {
  readQuarantine,
  replaceQuarantine,
  quarantineKey,
  type QuarantineEntry,
} from "./overlay-matcher.js";
import {
  RECALL_GATE_OVERLAY_SCHEMA,
  RECALL_GATE_OVERLAY_VERSION,
  recallGateOverlayHash,
  validateRecallGateOverlayDoc,
  type RecallGateOverlayDoc,
  type UserGatePattern,
  type ValidationResult,
} from "./recall-gate-overlay.js";
import { appendUiAuditLine } from "./ontology-admin.js";
import { BUILTIN_GATE_PATTERNS, type GateIntent, type GateLexicon } from "./recall-gate.js";

const BUILTIN_BY_INTENT = new Map<GateIntent, Array<{ id: string }>>();
for (const pattern of BUILTIN_GATE_PATTERNS) {
  const list = BUILTIN_BY_INTENT.get(pattern.intent) ?? [];
  list.push(pattern);
  BUILTIN_BY_INTENT.set(pattern.intent, list);
}

export type Surface = "cli" | "web-ui";

/** Snapshots kept per overlay, for `rollback` (§1.3). */
export const HISTORY_SNAPSHOT_LIMIT = 20;
/** `history.jsonl` rotates to `.old` above this (logs.cjs:44 precedent). */
const HISTORY_INDEX_MAX_BYTES = 1024 * 1024;
/** Second look at an unreadable lock, in the same call (D3). */
export const SECOND_LOOK_MS = 250;
/** Extra wait for a caller that joins an existing unreadable-lock observation (see withOverlayLock). */
export const FOLLOWER_GRACE_MS = 25;
/** Wall clock for the write-path measuring probe (§2.3.2). */
export const PROBE_WALL_MS = 300;

export class OverlayLockedError extends Error {
  constructor(readonly holderPid: number | null) {
    super(
      holderPid === null
        ? "another process is writing the overlay (its lock could not be read)"
        : `another process (pid ${holderPid}) is writing the overlay`,
    );
    this.name = "OverlayLockedError";
  }
}

export class OverlayStaleError extends Error {
  constructor(readonly currentRevision: number, readonly expectedRevision: number) {
    super(`the overlay is at revision ${currentRevision} (expected ${expectedRevision}) — it changed elsewhere first`);
    this.name = "OverlayStaleError";
  }
}

export class OverlayInvalidError extends Error {
  constructor(readonly issues: Issue[]) {
    super(`the overlay failed validation (${issues.filter((i) => i.severity === "error").length} error(s))`);
    this.name = "OverlayInvalidError";
  }
}

/* -------------------------------------------------------------------------- */
/* Lock (§1.5 / D3 / G4)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `mtimeMs:size` of every lock THIS PROCESS has already found unreadable.
 *
 * Module level on purpose (D3): per-call state made the second look unreachable,
 * which turned one corrupt lock into a permanent refusal. `inject-daemon.ts:896`
 * keeps the same state outside its wrapper for the same reason.
 */
const unreadableSeen = new Map<string, number>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function holdsOurLock(lockPath: string, payload: string): boolean {
  try {
    return fs.readFileSync(lockPath, "utf8") === payload;
  } catch {
    return false;
  }
}

/** EPERM means the process exists and belongs to someone else: still alive. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Identity of the lock FILE, not of its contents: inode, mtime and size. */
function lockStamp(stat: fs.Stats): string {
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

/**
 * Is this still the same abandoned lock we decided to remove?
 *
 * Called IMMEDIATELY before the `unlink`, and it is the difference between
 * reclaiming an abandoned lock and stealing a live one. Two processes can observe
 * the same corrupt stamp; if A recovers first and re-acquires for real, B's wait
 * has elapsed against a file that is now A's live lock — and removing it would put
 * two writers inside the same critical section, which is precisely what the
 * revision CAS and the async validation window cannot survive.
 *
 * False means "do not remove": the inode, mtime or size moved, the holder pid
 * changed, the holder is alive after all, or the file is already gone.
 */
function lockStillAbandoned(lockPath: string, stamp: string, holder: number): boolean {
  try {
    const text = fs.readFileSync(lockPath, "utf8");
    if (lockStamp(fs.statSync(lockPath)) !== stamp) return false;
    let pid = -1;
    try {
      pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
    } catch {
      pid = -1;
    }
    const current = Number.isInteger(pid) && pid > 0 ? pid : -1;
    if (current !== holder) return false;
    if (current > 0 && pidAlive(current)) return false;
    return true;
  } catch {
    // Vanished or unreadable right now: there is nothing of ours to remove.
    return false;
  }
}

/** Test-only: forget this process's unreadable-lock observations. */
export function resetOverlayLockObservations(): void {
  unreadableSeen.clear();
}

/**
 * Run `body` under the overlay's write lock. Read-modify-write AND the whole
 * async validation happen inside.
 */
export async function withOverlayLock<T>(file: string, body: () => Promise<T>): Promise<T> {
  const lockPath = overlayLockPath(file);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let held = false;
  /** Observations of an unreadable lock — capped at 2 (G4: separate from attempts). */
  let looks = 0;
  let lastHolder: number | null = null;
  for (let attempt = 0; attempt < 3 && !held; attempt++) {
    const staging = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // Atomic create-WITH-content: write under a private name, then link(2) it
      // into place. There is no instant at which a competitor can observe our
      // lock empty and call it abandoned.
      fs.writeFileSync(staging, payload, { mode: 0o600 });
      fs.linkSync(staging, lockPath);
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        try { fs.unlinkSync(staging); } catch { /* never created */ }
        throw error;
      }
      let text: string | null = null;
      let stamp = "";
      try {
        text = fs.readFileSync(lockPath, "utf8");
        stamp = lockStamp(fs.statSync(lockPath));
      } catch {
        /* it vanished between the EEXIST and the read */
      }
      if (text === null) continue; // the holder released it — try to create again
      let holder = -1;
      try {
        holder = Number((JSON.parse(text) as { pid?: unknown }).pid);
      } catch {
        /* no readable holder — decided just below */
      }
      const attributable = Number.isInteger(holder) && holder > 0;
      if (attributable && pidAlive(holder)) {
        // A live holder is NEVER stolen from.
        throw new OverlayLockedError(holder);
      }
      lastHolder = attributable ? holder : null;
      if (!attributable) {
        const first = unreadableSeen.get(stamp);
        if (first === undefined) {
          if (++looks >= 2) throw new OverlayLockedError(null);
          unreadableSeen.set(stamp, Date.now());
          // Second look in the SAME call: a writer caught mid-flight changes the
          // stamp, an abandoned lock does not.
          await delay(SECOND_LOOK_MS);
          continue;
        }
        const waited = Date.now() - first;
        // A follower shares the observer's window but yields a short grace
        // AFTER it: with `Date.now()` granularity both timers can otherwise
        // expire in the same tick in either order, and the observer that made
        // the observation should be the one that recovers. The re-stat below
        // then sees the observer's live lock and this call refuses cleanly.
        const follower = looks === 0; // this call did not make the observation
        await delay(Math.max(0, SECOND_LOOK_MS - waited) + (follower ? FOLLOWER_GRACE_MS : 0));
        // Same stamp after the wait: nothing is behind this lock.
      }
      // Re-stat and re-read before removing, never on the observation from
      // before the wait: see `lockStillAbandoned`.
      if (!lockStillAbandoned(lockPath, stamp, attributable ? holder : -1)) continue;
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* raced another reclaimer */
      }
      // G4: the removal succeeded, so the next iteration IS the one extra
      // acquisition attempt that makes this call perform its write.
    } finally {
      try { fs.unlinkSync(staging); } catch { /* never created, or already linked away */ }
    }
  }
  if (!held) throw new OverlayLockedError(lastHolder);
  try {
    // `return await` — the lock outlives the probe, not the other way round (D3).
    return await body();
  } finally {
    // Only ever remove OUR lock: a competitor may have reclaimed it by now.
    if (holdsOurLock(lockPath, payload)) {
      try { fs.unlinkSync(lockPath); } catch { /* someone reclaimed it */ }
    }
  }
}

/** True while this process holds `file`'s lock. Exported for tests and doctor. */
export function overlayLockHolder(file: string): number | null {
  try {
    const holder = Number((JSON.parse(fs.readFileSync(overlayLockPath(file), "utf8")) as { pid?: unknown }).pid);
    return Number.isInteger(holder) && holder > 0 ? holder : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Measuring probe (§2.3.2) — write path only                                  */
/* -------------------------------------------------------------------------- */

export interface ProbeResult {
  ok: boolean;
  /** Worst single `.test()` in milliseconds across the corpus. */
  maxMs: number;
  /** Labels that exceeded the wall clock (the worker was terminated). */
  tooSlow: string[];
  /** True when no probe could be run at all (worker_threads unavailable). */
  unavailable: boolean;
}

/**
 * Deterministic probe corpus: fixed shapes, the pattern's own literal alphabet
 * repeated, and — the case that actually catches nullable-separator blowups —
 * FAILING SUFFIXES, where the engine must exhaust every split before reporting
 * no match.
 */
export function probeCorpus(sources: readonly string[]): string[] {
  const probes = [
    "a".repeat(4000),
    "ab".repeat(2000),
    "가나".repeat(1000),
    "!".repeat(2000),
    " ".repeat(2000),
  ];
  const letters = [...new Set(sources.join("").replace(/[^\p{L}\p{N}]/gu, ""))];
  const alphabet = letters.join("") || "a";
  const failingSuffixes = [" ", "!", "Z"];
  for (const k of [20, 80, 400]) {
    const body = alphabet.repeat(Math.ceil(k / alphabet.length)).slice(0, k);
    probes.push(body);
    for (const suffix of failingSuffixes) probes.push(body + suffix);
    // EACH literal character on its own, not only the concatenation. For
    // `^a+b?a+b?a+$` the concatenated alphabet is "ab", and `abab…!` fails fast
    // because the `b?` slots are already filled — it is `aaaa…!` that forces the
    // engine through every split. A corpus without this misses the exact family
    // the reviewer's counterexample belongs to.
    for (const letter of letters.slice(0, 4)) {
      const run = letter.repeat(k);
      probes.push(run);
      for (const suffix of failingSuffixes) probes.push(run + suffix);
    }
  }
  probes.push(`\n${alphabet.repeat(10)}\n`);
  return probes;
}

export async function probeRegexSafety(
  cases: ReadonlyArray<{ label: string; source: string; flags: string }>,
  wallMs = PROBE_WALL_MS,
): Promise<ProbeResult> {
  if (cases.length === 0) return { ok: true, maxMs: 0, tooSlow: [], unavailable: false };
  const probes = probeCorpus(cases.map((item) => item.source));
  let worker: Worker;
  try {
    worker = new Worker(new URL("./overlay-regex-probe.mjs", import.meta.url), {
      workerData: { cases: cases.map((item) => ({ ...item, flags: item.flags ?? "" })), probes },
    });
  } catch {
    // No probe is not a refusal: the matcher's 50 ms box is the real guarantee.
    return { ok: true, maxMs: 0, tooSlow: [], unavailable: true };
  }
  worker.unref();
  const results = await new Promise<Array<{ label: string; maxMs: number }> | null>((resolve) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve(null);
    }, wallMs);
    worker.once("message", (message: { results: Array<{ label: string; maxMs: number }> }) => {
      clearTimeout(timer);
      resolve(message.results);
    });
    worker.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    worker.once("exit", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  try { void worker.terminate(); } catch { /* already gone */ }
  if (results === null) {
    // Which case was slow is not knowable after a terminate, so every candidate
    // in this batch is reported. Callers probe one candidate at a time where the
    // attribution matters.
    return { ok: false, maxMs: wallMs, tooSlow: cases.map((item) => item.label), unavailable: false };
  }
  const maxMs = results.reduce((worst, item) => Math.max(worst, item.maxMs), 0);
  return { ok: true, maxMs, tooSlow: [], unavailable: false };
}

/* -------------------------------------------------------------------------- */
/* Validation entry point (§2.3.5)                                             */
/* -------------------------------------------------------------------------- */

export type OverlayValidator = (
  doc: unknown,
  opts: { probe?: boolean; forWrite?: boolean },
) => Promise<ValidationResult>;

/**
 * Full validation for a write: structure, then the measuring probe over each
 * candidate AND over the composed pattern of its intent.
 *
 * Returns `Issue[]` with the `{severity, code, key, params, path, message}`
 * contract (G5/I2) — `path` survives to the client unchanged.
 */
export async function validateOverlay(
  overlay: OverlayName,
  doc: unknown,
  opts: { probe?: boolean; forWrite?: boolean; validator?: OverlayValidator } = {},
): Promise<ValidationResult> {
  if (overlay === "extraction-rules") {
    if (!opts.validator) {
      throw new Error(
        "extraction-rules validation is owned by src/extraction-rules.ts — pass it as opts.validator",
      );
    }
    return opts.validator(doc, { probe: opts.probe, forWrite: opts.forWrite });
  }
  const structural = validateRecallGateOverlayDoc(doc, { forWrite: opts.forWrite ?? true });
  if (!structural.ok || !structural.doc || opts.probe !== true) return structural;
  const issues = [...structural.issues];
  const added = structural.doc.patterns?.add ?? [];
  for (const pattern of added) {
    const probe = await probeRegexSafety([
      { label: pattern.id, source: pattern.source, flags: pattern.flags },
    ]);
    if (!probe.ok) {
      issues.push(
        overlayIssue(
          "error",
          "PATTERN_TOO_SLOW",
          `validation did not finish within the ${PROBE_WALL_MS} ms limit`,
          { path: "patterns.add", params: { id: pattern.id, limitMs: PROBE_WALL_MS } },
        ),
      );
    }
  }
  // The COMPOSED pattern too (§2.3.2): a branch that is fast on its own can be
  // slow once it is one alternative among sixty, because the engine retries every
  // branch at every position. Composing is exactly what the gate does at runtime,
  // so probing the individual branch alone would measure something else.
  const disabled = new Set(structural.doc.patterns?.disable ?? []);
  for (const intent of ["memory", "trace", "highImpact"] as const) {
    const userSources = added.filter((pattern) => pattern.intent === intent).map((p) => p.source);
    if (userSources.length === 0) continue;
    const builtinSources = BUILTIN_GATE_PATTERNS
      .filter((p) => p.intent === intent && p.form === "alternative" && !disabled.has(p.id))
      .map((p) => p.source);
    const probe = await probeRegexSafety([
      { label: `composed:${intent}`, source: `(${[...builtinSources, ...userSources].join("|")})`, flags: "i" },
    ]);
    if (!probe.ok) {
      issues.push(
        overlayIssue(
          "error",
          "PATTERN_TOO_SLOW",
          `the composed ${intent} pattern did not finish within the ${PROBE_WALL_MS} ms limit`,
          { path: "patterns.add", params: { intent, limitMs: PROBE_WALL_MS, composed: true } },
        ),
      );
    }
  }
  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    doc: issues.some((issue) => issue.severity === "error") ? null : structural.doc,
  };
}

/* -------------------------------------------------------------------------- */
/* Atomic write + history                                                      */
/* -------------------------------------------------------------------------- */

function writeAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stat = fs.existsSync(target) ? fs.lstatSync(target) : null;
  if (stat?.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${target}`);
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  // rename changes the inode, which is what makes the readers' `mtimeMs:size:ino`
  // cache key a reliable invalidation signal (§1.1).
  fs.renameSync(tmp, target);
}

export interface HistoryEntry {
  ts: string;
  surface: Surface;
  overlay: OverlayName;
  action: string;
  from_revision: number;
  to_revision: number;
  from_hash: string | null;
  to_hash: string | null;
  added?: string[];
  disabled?: string[];
  removed?: string[];
  counts?: Record<string, number>;
}

function appendHistoryIndex(entry: HistoryEntry): void {
  try {
    const file = overlayHistoryIndexPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const stat = fs.existsSync(file) ? fs.lstatSync(file) : null;
    if (stat?.isSymbolicLink()) return;
    if (stat && stat.size > HISTORY_INDEX_MAX_BYTES) {
      try { fs.renameSync(file, `${file}.old`); } catch { /* rotation is best-effort */ }
    }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch {
    /* the index is the only hash→content back-reference, but it must not block a write */
  }
}

function writeSnapshot(overlay: OverlayName, revision: number, doc: unknown): void {
  try {
    writeAtomic(overlaySnapshotPath(overlay, revision), doc);
    const dir = overlaySnapshotDir(overlay);
    const revisions = fs
      .readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.slice(0, -5)))
      .sort((a, b) => a - b);
    while (revisions.length > HISTORY_SNAPSHOT_LIMIT) {
      const oldest = revisions.shift();
      if (oldest === undefined) break;
      try { fs.unlinkSync(overlaySnapshotPath(overlay, oldest)); } catch { /* already gone */ }
    }
  } catch {
    /* a missing snapshot costs rollback, not correctness */
  }
}

export function listOverlayHistory(overlay: OverlayName, limit = 20): HistoryEntry[] {
  try {
    const lines = fs.readFileSync(overlayHistoryIndexPath(), "utf8").split("\n").filter(Boolean);
    const entries: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const entry = JSON.parse(lines[i]) as HistoryEntry;
        if (entry.overlay === overlay) entries.push(entry);
      } catch {
        /* a torn line is skipped, not fatal */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function readOverlaySnapshot(overlay: OverlayName, revision: number): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(overlaySnapshotPath(overlay, revision), "utf8"));
  } catch {
    return null;
  }
}

export function listOverlaySnapshots(overlay: OverlayName): number[] {
  try {
    return fs
      .readdirSync(overlaySnapshotDir(overlay))
      .filter((name) => /^\d+\.json$/.test(name))
      .map((name) => Number(name.slice(0, -5)))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                       */
/* -------------------------------------------------------------------------- */

export interface WriteResult {
  revision: number;
  hash: string | null;
  issues: Issue[];
  /** Quarantine rows cleared because the pattern's source changed. */
  quarantineCleared: string[];
}

function readUnchecked(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function emptyGateDoc(): RecallGateOverlayDoc {
  return {
    schema: RECALL_GATE_OVERLAY_SCHEMA,
    version: RECALL_GATE_OVERLAY_VERSION,
    revision: 0,
    patterns: { add: [], disable: [] },
    words: {
      add: { ack: [], continue: [], filler: [] },
      disable: { ack: [], continue: [], filler: [] },
    },
  };
}

export interface GateDelta {
  patternsAdd?: UserGatePattern[];
  patternsDisable?: string[];
  patternsRemove?: string[];
  words?: {
    add?: Partial<Record<GateLexicon, string[]>>;
    disable?: Partial<Record<GateLexicon, string[]>>;
    removeAdd?: Partial<Record<GateLexicon, string[]>>;
    removeDisable?: Partial<Record<GateLexicon, string[]>>;
  };
}

function mergeGateDelta(current: RecallGateOverlayDoc, delta: GateDelta): RecallGateOverlayDoc {
  const next: RecallGateOverlayDoc = {
    ...current,
    patterns: {
      add: [...(current.patterns?.add ?? [])],
      disable: [...(current.patterns?.disable ?? [])],
    },
    words: {
      add: { ...(current.words?.add ?? {}) },
      disable: { ...(current.words?.disable ?? {}) },
    },
  };
  const add = next.patterns!.add!;
  for (const pattern of delta.patternsAdd ?? []) {
    const index = add.findIndex((existing) => existing.id === pattern.id);
    if (index >= 0) add[index] = pattern;
    else add.push(pattern);
  }
  if (delta.patternsRemove?.length) {
    next.patterns!.add = add.filter((pattern) => !delta.patternsRemove!.includes(pattern.id));
  }
  for (const id of delta.patternsDisable ?? []) {
    if (!next.patterns!.disable!.includes(id)) next.patterns!.disable!.push(id);
  }
  // Removing a disable is how `gate patterns add` of a built-in id re-enables it.
  if (delta.patternsRemove?.length) {
    next.patterns!.disable = next.patterns!.disable!.filter((id) => !delta.patternsRemove!.includes(id));
  }
  for (const side of ["add", "disable"] as const) {
    for (const [lexicon, words] of Object.entries(delta.words?.[side] ?? {})) {
      const list = new Set(next.words![side]![lexicon as GateLexicon] ?? []);
      for (const word of words ?? []) list.add(word);
      next.words![side]![lexicon as GateLexicon] = [...list];
    }
    const removeKey = side === "add" ? "removeAdd" : "removeDisable";
    for (const [lexicon, words] of Object.entries(delta.words?.[removeKey] ?? {})) {
      const drop = new Set(words ?? []);
      next.words![side]![lexicon as GateLexicon] =
        (next.words![side]![lexicon as GateLexicon] ?? []).filter((word) => !drop.has(word));
    }
  }
  return next;
}

/**
 * Every user pattern the just-written document still declares, as quarantine keys.
 *
 * Both overlays have to be read here. Passing `null` for `extraction-rules` — which
 * is what the first version did — made the live set EMPTY, so saving the rules file
 * cleared every quarantine row the overlay owned: re-saving the same regex, or
 * editing only `preferred_language`, un-quarantined a pattern that still blows its
 * budget and then released the extraction hold behind it.
 *
 * The key is (pattern_id, source_sha8), so EDITING a regex drops its row here
 * automatically while an untouched one is kept.
 */
function livePatternKeys(overlay: OverlayName, applied: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const add = (id: unknown, source: unknown, flags: unknown): void => {
    if (typeof id !== "string" || typeof source !== "string") return;
    keys.add(quarantineKey(id, patternSourceSha8(source, typeof flags === "string" ? flags : "")));
  };
  if (overlay === "recall-gate") {
    const doc = applied as unknown as RecallGateOverlayDoc;
    for (const pattern of doc.patterns?.add ?? []) add(pattern.id, pattern.source, pattern.flags);
    return keys;
  }
  // extraction-rules: both pattern lists the validator accepts are user regexes
  // that the matcher can quarantine.
  for (const field of ["never_extract_patterns", "always_treat_as_decision_patterns"]) {
    const list = applied[field];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const pattern = raw as Record<string, unknown>;
      add(pattern.id, pattern.source, pattern.flags);
    }
  }
  return keys;
}

/**
 * Clear quarantine rows whose pattern no longer exists, or whose source changed.
 */
function clearQuarantineForChangedPatterns(
  overlay: OverlayName,
  live: ReadonlySet<string>,
): string[] {
  const entries = readQuarantine();
  const keep: QuarantineEntry[] = [];
  const cleared: string[] = [];
  for (const entry of entries) {
    if (entry.overlay !== overlay) {
      keep.push(entry);
      continue;
    }
    if (live.has(quarantineKey(entry.pattern_id, entry.source_sha8))) keep.push(entry);
    else cleared.push(entry.pattern_id);
  }
  if (cleared.length > 0) replaceQuarantine(keep);
  return cleared;
}

export interface ApplyOptions {
  surface: Surface;
  expectedRevision?: number;
  /** `validate` only: skip the measuring probe (the default runs it). */
  probe?: boolean;
  /** Required for the `extraction-rules` overlay — lane C owns its validator. */
  validator?: OverlayValidator;
  /** Audit action name, e.g. `gate.pattern-add`. */
  auditAction: string;
  /** Extra metadata-only fields for the history index. */
  history?: Partial<Pick<HistoryEntry, "added" | "disabled" | "removed" | "counts">>;
}

/**
 * Read-modify-write under the lock with revision CAS.
 *
 * `input` is either a DELTA (merged inside the lock, so nothing read outside can
 * be written back) or a FULL DOCUMENT (the caller must pass `expectedRevision`
 * when a file already exists — §1.5's lost-update contract).
 */
export async function applyOverlayChange(
  overlay: OverlayName,
  input: { delta?: GateDelta; doc?: unknown },
  opts: ApplyOptions,
): Promise<WriteResult> {
  const file = overlayFilePath(overlay);
  return withOverlayLock(file, async () => {
    const currentRaw = readUnchecked(file);
    const currentRevision = Number.isInteger(currentRaw?.revision) ? Number(currentRaw!.revision) : 0;
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
      throw new OverlayStaleError(currentRevision, opts.expectedRevision);
    }
    const fromHash = currentRaw && overlay === "recall-gate"
      ? gateHashOrNull(currentRaw)
      : null;

    let next: Record<string, unknown>;
    if (input.delta) {
      if (overlay !== "recall-gate") throw new Error("delta merging is only defined for the recall-gate overlay");
      const base = currentRaw
        ? (validateRecallGateOverlayDoc(currentRaw).doc ?? emptyGateDoc())
        : emptyGateDoc();
      next = mergeGateDelta(base, input.delta) as unknown as Record<string, unknown>;
    } else {
      if (input.doc === undefined) throw new Error("applyOverlayChange needs a delta or a document");
      next = { ...(input.doc as Record<string, unknown>) };
    }
    next.revision = currentRevision + 1;
    next.updated_at = new Date().toISOString();
    next.updated_by = { surface: opts.surface };

    const validation = await validateOverlay(overlay, next, {
      probe: opts.probe !== false,
      forWrite: true,
      validator: opts.validator,
    });
    if (!validation.ok) throw new OverlayInvalidError(validation.issues);
    const applied = (validation.doc ?? next) as unknown as Record<string, unknown>;
    applied.revision = Number(next.revision);
    applied.updated_at = next.updated_at;
    applied.updated_by = next.updated_by;

    writeAtomic(file, applied);
    const cleared = clearQuarantineForChangedPatterns(overlay, livePatternKeys(overlay, applied));
    const toHash = overlay === "recall-gate" ? gateHashOrNull(applied) : null;
    writeSnapshot(overlay, Number(applied.revision), applied);
    appendHistoryIndex({
      ts: new Date().toISOString(),
      surface: opts.surface,
      overlay,
      action: opts.auditAction,
      from_revision: currentRevision,
      to_revision: Number(applied.revision),
      from_hash: fromHash,
      to_hash: toHash,
      ...(opts.history ?? {}),
    });
    appendUiAuditLine(opts.auditAction, {
      id: String(applied.revision),
      overlay,
      from_revision: currentRevision,
      to_revision: Number(applied.revision),
      to_hash: toHash,
      ...countsOf(opts.history?.counts),
    });
    return {
      revision: Number(applied.revision),
      hash: toHash,
      issues: validation.issues,
      quarantineCleared: cleared,
    };
  });
}

function countsOf(counts: Record<string, number> | undefined): Record<string, number> {
  return counts ? { ...counts } : {};
}

function gateHashOrNull(raw: Record<string, unknown>): string | null {
  const validated = validateRecallGateOverlayDoc(raw);
  return validated.doc ? recallGateOverlayHash(validated.doc) : null;
}

/* -------------------------------------------------------------------------- */
/* Public write API (§2.4)                                                     */
/* -------------------------------------------------------------------------- */

export async function addGatePattern(
  input: { intent: GateIntent; source: string; flags?: string; note?: string },
  opts: { surface: Surface; expectedRevision?: number; probe?: boolean },
): Promise<WriteResult> {
  const flags = input.flags ?? "i";
  const id = userPatternId(input.intent, input.source, flags);
  return applyOverlayChange(
    "recall-gate",
    {
      delta: {
        patternsAdd: [
          {
            id,
            intent: input.intent,
            source: input.source,
            flags,
            ...(input.note ? { note: input.note } : {}),
            created_at: new Date().toISOString(),
          },
        ],
      },
    },
    {
      surface: opts.surface,
      expectedRevision: opts.expectedRevision,
      probe: opts.probe,
      auditAction: "gate.pattern-add",
      history: { added: [id] },
    },
  );
}

/**
 * `disable` is not `remove`: a built-in stays in the catalogue and is switched
 * off by id. A `user.*` id is deleted from `patterns.add` instead, and a regex
 * source is resolved to an id by exact `source+flags` match (a CLI convenience).
 */
export async function disableGatePattern(
  idOrSource: string,
  opts: { surface: Surface; expectedRevision?: number; flags?: string; probe?: boolean },
): Promise<WriteResult> {
  const resolved = resolveGatePatternId(idOrSource, opts.flags);
  if (resolved === null) throw new Error(`no pattern matches ${JSON.stringify(idOrSource)}`);
  const isUser = resolved.startsWith("user.");
  return applyOverlayChange(
    "recall-gate",
    {
      delta: isUser ? { patternsRemove: [resolved] } : { patternsDisable: [resolved] },
    },
    {
      surface: opts.surface,
      expectedRevision: opts.expectedRevision,
      probe: opts.probe,
      auditAction: "gate.pattern-disable",
      history: isUser ? { removed: [resolved] } : { disabled: [resolved] },
    },
  );
}

/** Resolve an id, a `user.*` id, or an exact regex source to a catalogue id. */
export function resolveGatePatternId(idOrSource: string, flags?: string): string | null {
  const raw = readUnchecked(overlayFilePath("recall-gate"));
  const doc = raw ? validateRecallGateOverlayDoc(raw).doc : null;
  const userPatterns = doc?.patterns?.add ?? [];
  if (userPatterns.some((pattern) => pattern.id === idOrSource)) return idOrSource;
  const bySource = userPatterns.find(
    (pattern) => pattern.source === idOrSource && (flags === undefined || pattern.flags === flags),
  );
  if (bySource) return bySource.id;
  // Built-ins: an exact id, or an exact source match on a catalogue term.
  const builtin = BUILTIN_GATE_PATTERNS.find(
    (pattern) =>
      pattern.id === idOrSource ||
      (pattern.source === idOrSource && (flags === undefined || pattern.flags === flags)),
  );
  return builtin ? builtin.id : null;
}

export async function setGateWords(
  lexicon: GateLexicon,
  change: { add?: string[]; disable?: string[]; removeAdd?: string[]; removeDisable?: string[] },
  opts: { surface: Surface; expectedRevision?: number; probe?: boolean },
): Promise<WriteResult> {
  return applyOverlayChange(
    "recall-gate",
    {
      delta: {
        words: {
          ...(change.add ? { add: { [lexicon]: change.add } } : {}),
          ...(change.disable ? { disable: { [lexicon]: change.disable } } : {}),
          ...(change.removeAdd ? { removeAdd: { [lexicon]: change.removeAdd } } : {}),
          ...(change.removeDisable ? { removeDisable: { [lexicon]: change.removeDisable } } : {}),
        },
      },
    },
    {
      surface: opts.surface,
      expectedRevision: opts.expectedRevision,
      probe: opts.probe,
      auditAction: "gate.words",
      history: { counts: { lexicons: 1 } },
    },
  );
}

/**
 * Reset an overlay to "nothing applied".
 *
 * The file is not deleted: it is written as an empty rule set at the next
 * revision, so the change has a revision, a snapshot and a rollback target like
 * every other change.
 */
export async function resetOverlay(
  overlay: OverlayName,
  opts: {
    surface: Surface;
    intent?: GateIntent;
    expectedRevision?: number;
    /** The extraction-rules overlay's "nothing applied" document — lane C owns it. */
    emptyDoc?: unknown;
    validator?: OverlayValidator;
  },
): Promise<WriteResult> {
  if (overlay === "extraction-rules") {
    if (opts.emptyDoc === undefined) {
      throw new Error("resetOverlay('extraction-rules') needs opts.emptyDoc from src/extraction-rules.ts");
    }
    return applyOverlayChange("extraction-rules", { doc: opts.emptyDoc }, {
      surface: opts.surface,
      expectedRevision: opts.expectedRevision,
      probe: false,
      auditAction: "rules.reset",
      validator: opts.validator,
    });
  }
  if (opts.intent) {
    // Intent-scoped reset stays a delta so other intents survive untouched.
    const raw = readUnchecked(overlayFilePath("recall-gate"));
    const doc = raw ? validateRecallGateOverlayDoc(raw).doc : null;
    const removed = (doc?.patterns?.add ?? [])
      .filter((pattern) => pattern.intent === opts.intent)
      .map((pattern) => pattern.id);
    const builtinOfIntent = new Set(
      BUILTIN_BY_INTENT.get(opts.intent)?.map((pattern) => pattern.id) ?? [],
    );
    const reEnabled = (doc?.patterns?.disable ?? []).filter((id) => builtinOfIntent.has(id));
    return applyOverlayChange(
      "recall-gate",
      { delta: { patternsRemove: [...removed, ...reEnabled] } },
      {
        surface: opts.surface,
        expectedRevision: opts.expectedRevision,
        probe: false,
        auditAction: "gate.reset",
        history: { removed, counts: { re_enabled: reEnabled.length } },
      },
    );
  }
  return applyOverlayChange("recall-gate", { doc: emptyGateDoc() }, {
    surface: opts.surface,
    expectedRevision: opts.expectedRevision,
    probe: false,
    auditAction: "gate.reset",
  });
}

export async function rollbackOverlay(
  overlay: OverlayName,
  revision: number,
  opts: { surface: Surface; expectedRevision?: number; validator?: OverlayValidator },
): Promise<WriteResult> {
  const snapshot = readOverlaySnapshot(overlay, revision);
  if (snapshot === null) {
    throw new Error(
      `no snapshot for ${overlay} revision ${revision} (kept: ${listOverlaySnapshots(overlay).join(", ") || "none"})`,
    );
  }
  return applyOverlayChange(overlay, { doc: snapshot }, {
    surface: opts.surface,
    expectedRevision: opts.expectedRevision,
    // The snapshot was probed when it was written; re-probing a rollback would
    // refuse a recovery path because the machine is busy.
    probe: false,
    validator: opts.validator,
    auditAction: overlay === "recall-gate" ? "gate.rollback" : "rules.rollback",
    history: { counts: { from_snapshot: revision } },
  });
}

/**
 * Clear quarantine rows so the pattern gets another chance.
 *
 * The quarantine file is SHARED, LOCK-FREE, union-merged state (§2.3.4), so this
 * is a plain read-filter-write rather than a revision CAS.
 */
export async function clearQuarantine(
  patternId?: string,
  opts: { surface?: Surface } = {},
): Promise<{ cleared: number; ids: string[] }> {
  const entries = readQuarantine();
  const dropped = patternId ? entries.filter((entry) => entry.pattern_id === patternId) : entries;
  const keep = patternId ? entries.filter((entry) => entry.pattern_id !== patternId) : [];
  const ids = [...new Set(dropped.map((entry) => entry.pattern_id))];
  if (ids.length === 0) return { cleared: 0, ids: [] };
  replaceQuarantine(keep);
  appendUiAuditLine("gate.quarantine-clear", {
    id: patternId ?? "all",
    surface: opts.surface ?? "cli",
    cleared: dropped.length,
  });
  return { cleared: dropped.length, ids };
}

/** Where the overlay files live — for `gate show` and doctor detail lines. */
export function overlayPaths(): { dir: string; gate: string; history: string } {
  return {
    dir: overlayDir(),
    gate: overlayFilePath("recall-gate"),
    history: overlayHistoryIndexPath(),
  };
}

/** Canonical rule JSON of a document — the hash's pre-image, for `--json` output. */
export function overlayCanonicalJson(doc: unknown): string {
  return canonicalJson(doc);
}
