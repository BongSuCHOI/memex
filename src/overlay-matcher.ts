/**
 * Time-boxed execution of user overlay regexes (decisions-v2 D1, decisions-v3 G3).
 *
 * THIS IS THE SAFETY BOUNDARY. Not the grammar subset — see
 * src/overlay-regex.ts's header for the counterexample that passes every
 * structural rule and still fails to terminate. The guarantee this module makes
 * is narrow and exact:
 *
 *   a slow user pattern cannot stop the matching thread.
 *
 * It is NOT "slow patterns do not exist". A pattern that burns its 50 ms
 * execution budget is QUARANTINED: the worker is terminated, the pattern is
 * recorded in `overlays/quarantine.json`, and every later load drops it from
 * matching until the operator fixes or clears it.
 *
 * Two handles, one implementation:
 *  - `persistentMatcher()` — one per inject daemon (it lives inside the MCP
 *    server, so the worker is resident for the session and the compiled regexes
 *    are memoised across prompts). Respawns at most once per 5 s after a death.
 *  - `oneShotMatcher()` — the cold hook, the CLI, the extraction worker. Creates
 *    its worker on first use and never respawns.
 *
 * Cost when there is no overlay: ZERO. `match()` with an empty pattern list
 * returns without constructing a worker or sending a message, so an installation
 * with no overlay file runs exactly the 0.6.9 path.
 *
 * `match()` NEVER throws and never rejects. Every failure is a field on the
 * result, because the gate's contract is that a prompt is never broken by the
 * overlay machinery (the extraction side reads the same fields and fails CLOSED
 * instead — §2.3.4's asymmetry).
 */

import { Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { overlayDir, overlayQuarantinePath, type OverlayName } from "./paths.js";
import { patternSourceSha8 } from "./overlay-regex.js";
import type { GateIntent } from "./recall-gate.js";

/** Wall clock for ONE request's own execution window. Queue wait is excluded. */
export const MATCH_WALL_MS = 50;
/**
 * Budget for bringing a worker ONLINE, kept separate from MATCH_WALL_MS (G3).
 *
 * Spawning a Node worker measures at 10-40 ms, so folding it into the 50 ms
 * execution budget made the first prompt after a daemon start time out on
 * startup alone — and a startup timeout must never quarantine a pattern, so the
 * overlay would have been silently dropped on exactly the prompt that paid for
 * it. Exhausting THIS budget yields `unavailable` with no quarantine; only the
 * 50 ms that follows can attribute a timeout to a pattern.
 */
export const MATCHER_STARTUP_MS = 500;
/** Minimum interval between respawn attempts after an unexpected worker death. */
export const MATCHER_RESPAWN_MS = 5_000;
/** Prompt prefix handed to the worker. A constant factor, NOT a defence. */
export const MATCH_INPUT_CHARS = 8_000;
/** Entries kept in quarantine.json (§1.3). */
export const QUARANTINE_MAX_ENTRIES = 200;

export interface UserPatternSpec {
  id: string;
  intent?: GateIntent | null;
  source: string;
  flags: string;
  /** Which overlay the pattern came from — decides the quarantine row's owner. */
  overlay?: OverlayName;
}

export interface QuarantineEntry {
  overlay: OverlayName;
  pattern_id: string;
  /** sha8(source \0 flags): editing the regex changes it, which auto-clears. */
  source_sha8: string;
  at: string;
  elapsed_ms: number;
  input_chars: number;
  surface: string;
}

export interface UserPatternHits {
  /** Overlay pattern ids that fired, per intent (the gate's input). */
  intents: Partial<Record<GateIntent, string[]>>;
  /** Every pattern id that matched, intent or not (the extraction side's input). */
  matched: string[];
  /** True when this request's own 50 ms window ran out. */
  timedOut: boolean;
  /** Ids newly quarantined by THIS call. Only ever set on an execution timeout. */
  quarantined: string[];
  /** True when the worker could not be used at all (startup, death, queue drain). */
  unavailable: boolean;
  /**
   * True when the request's text was longer than the input cap and only the
   * prefix was evaluated.
   *
   * The cap is a COST bound for the recall path, where a prefix answer is the
   * right trade. It is not a safety property, so the storage boundary — which
   * must never let unexamined text through — reads this field and treats a
   * truncated answer as a check that did not finish (§3.4, G1).
   */
  truncated: boolean;
  /** EXECUTION window only — queue wait and worker startup are excluded. */
  elapsedMs: number;
  /**
   * Regexes this request had to compile. 0 means the resident worker's memo held,
   * which is the difference between the warm and the cold matcher cost.
   */
  compiledPatterns: number;
}

export interface MatchRequest {
  text: string;
  patterns: readonly UserPatternSpec[];
  /** Default overlay for quarantine rows when a spec does not name one. */
  overlay?: OverlayName;
  /** Free-form origin recorded on a quarantine row: 'daemon' | 'fallback' | … */
  surface?: string;
}

export interface MatcherHandle {
  /**
   * Evaluate `patterns` against `text`. Resolves even on timeout, worker death
   * or a missing worker_threads implementation — never throws, never rejects.
   */
  match(input: MatchRequest): Promise<UserPatternHits>;
  dispose(): void;
  state(): "ready" | "dead" | "unavailable";
}

export const EMPTY_USER_PATTERN_HITS: UserPatternHits = Object.freeze({
  intents: Object.freeze({}) as Partial<Record<GateIntent, string[]>>,
  matched: Object.freeze([]) as unknown as string[],
  timedOut: false,
  quarantined: Object.freeze([]) as unknown as string[],
  unavailable: false,
  truncated: false,
  elapsedMs: 0,
  compiledPatterns: 0,
});

function unavailableHits(elapsedMs: number, timedOut = false): UserPatternHits {
  return {
    intents: {}, matched: [], timedOut, quarantined: [], unavailable: true, truncated: false,
    elapsedMs, compiledPatterns: 0,
  };
}

interface WorkerReply {
  generation: number;
  hits: { byPattern: Array<{ id: string; intent: GateIntent | null; matched: boolean }> };
  elapsedMs: number;
  compiled?: number;
}

function workerEntry(): URL {
  return new URL("./overlay-matcher-worker.mjs", import.meta.url);
}

/**
 * Narrow seams, used by test/overlay-matcher*.test.ts.
 *
 * Production callers pass nothing. `entry` lets a test stand in a worker that
 * dies or never answers, which is the only way to exercise the death and
 * queue-drain branches for real; `respawnMs` shortens the 5 s respawn window so
 * the suite does not have to wait it out.
 */
export interface MatcherOptions {
  respawnMs?: number;
  entry?: URL;
}

class TimeBoxedMatcher implements MatcherHandle {
  private worker: Worker | null = null;
  private progress: Int32Array | null = null;
  private generation = 0;
  private status: "ready" | "dead" | "unavailable" = "ready";
  private goneAt = 0;
  private disposed = false;
  /** True only while WE are terminating, so 'exit' is not read as a death. */
  private terminating = false;
  private pending: ((reply: WorkerReply | null) => void) | null = null;
  private pendingGeneration = 0;
  /** Resolves true once the current worker is executing, false if it never got there. */
  private online: Promise<boolean> | null = null;
  /** Serialization tail: one request per worker at a time (G3). */
  private tail: Promise<unknown> = Promise.resolve();
  /** Observability for tests: how many workers this handle has constructed. */
  spawnCount = 0;

  constructor(
    private readonly persistent: boolean,
    private readonly options: MatcherOptions = {},
  ) {}

  state(): "ready" | "dead" | "unavailable" {
    if (this.disposed) return "unavailable";
    return this.status;
  }

  match(input: MatchRequest): Promise<UserPatternHits> {
    // Zero-cost path: no overlay patterns means no worker and no message.
    if (input.patterns.length === 0) return Promise.resolve(EMPTY_USER_PATTERN_HITS);
    if (this.disposed) return Promise.resolve(unavailableHits(0));
    const run = () => this.runOne(input);
    const queued: Promise<UserPatternHits> = this.tail.then(run, run);
    // The tail must never reject, or a later request would inherit the rejection.
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.killWorker();
  }

  /* -------------------------------------------------------------------- */

  private ensureWorker(): Worker | null {
    if (this.worker && this.status === "ready") return this.worker;
    if (this.status !== "ready") {
      // A handle that lost its worker answers `unavailable` until the respawn
      // window opens; a one-shot handle never respawns at all.
      if (!this.persistent) return null;
      if (Date.now() - this.goneAt < (this.options.respawnMs ?? MATCHER_RESPAWN_MS)) return null;
    }
    return this.spawn();
  }

  private spawn(): Worker | null {
    try {
      const buffer = new SharedArrayBuffer(8);
      const progress = new Int32Array(buffer);
      Atomics.store(progress, 0, 0);
      Atomics.store(progress, 1, -1);
      const worker = new Worker(this.options.entry ?? workerEntry(), { workerData: { progress: buffer } });
      // Never hold a process open. During a request the race's own timer keeps
      // the event loop alive, so the reply still arrives in a short-lived hook.
      worker.unref();
      let settleOnline: (ready: boolean) => void = () => {};
      this.online = new Promise<boolean>((resolve) => {
        settleOnline = resolve;
      });
      worker.once("error", () => settleOnline(false));
      worker.once("exit", () => settleOnline(false));
      worker.on("message", (message: WorkerReply & { ready?: boolean }) => {
        if (message?.ready === true) return settleOnline(true);
        const resolve = this.pending;
        if (!resolve) return;
        if (Number(message?.generation) !== this.pendingGeneration) return;
        this.pending = null;
        resolve(message);
      });
      worker.on("error", () => this.onWorkerGone());
      worker.on("exit", () => this.onWorkerGone());
      this.worker = worker;
      this.progress = progress;
      this.status = "ready";
      this.spawnCount++;
      return worker;
    } catch {
      // worker_threads unavailable, resource limit, missing file: all the same
      // answer — the overlay is simply not applied, and it is visible.
      this.worker = null;
      this.progress = null;
      this.online = null;
      this.status = "unavailable";
      this.goneAt = Date.now();
      return null;
    }
  }

  /**
   * Wait for the worker to be executing, under its OWN budget.
   *
   * A startup that never lands is `unavailable` with no quarantine — the
   * pattern list had nothing to do with it.
   */
  private async awaitOnline(): Promise<boolean> {
    const online = this.online;
    if (!online) return false;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), MATCHER_STARTUP_MS);
    });
    try {
      return await Promise.race([online, expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** An unexpected death: the in-flight request and the queue get `unavailable`. */
  private onWorkerGone(): void {
    if (this.terminating) return;
    this.worker = null;
    this.progress = null;
    this.online = null;
    this.status = "dead";
    this.goneAt = Date.now();
    const resolve = this.pending;
    this.pending = null;
    if (resolve) resolve(null);
  }

  private killWorker(): void {
    const worker = this.worker;
    this.worker = null;
    this.progress = null;
    this.online = null;
    this.status = "dead";
    this.goneAt = Date.now();
    if (!worker) return;
    this.terminating = true;
    try {
      void worker.terminate();
    } catch {
      /* already gone */
    } finally {
      this.terminating = false;
    }
  }

  private async runOne(input: MatchRequest): Promise<UserPatternHits> {
    if (this.disposed) return unavailableHits(0);
    const worker = this.ensureWorker();
    if (!worker) return unavailableHits(0);
    // Startup is NOT part of the 50 ms execution budget (G3).
    if (!(await this.awaitOnline())) {
      this.killWorker();
      return unavailableHits(0);
    }
    if (this.disposed) return unavailableHits(0);

    // `elapsedMs` reports the EXECUTION window only. Queue wait and worker
    // startup are deliberately excluded: they are not this pattern list's cost,
    // and the 50 ms cap is stated against exactly this clock.
    const started = Date.now();
    const generation = ++this.generation;
    const truncated = input.text.length > MATCH_INPUT_CHARS;
    const text = truncated ? input.text.slice(0, MATCH_INPUT_CHARS) : input.text;
    const patterns = input.patterns;
    const reply = new Promise<WorkerReply | null>((resolve) => {
      this.pending = resolve;
      this.pendingGeneration = generation;
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), MATCH_WALL_MS);
    });

    try {
      worker.postMessage({
        generation,
        text,
        patterns: patterns.map((pattern) => ({
          id: pattern.id,
          source: pattern.source,
          flags: pattern.flags ?? "",
          intent: pattern.intent ?? null,
        })),
      });
    } catch {
      if (timer) clearTimeout(timer);
      this.pending = null;
      this.killWorker();
      return unavailableHits(Date.now() - started);
    }

    const outcome = await Promise.race([reply, timeout]);
    if (timer) clearTimeout(timer);

    if (outcome !== "timeout" && outcome !== null) {
      return this.collect(outcome, patterns, Date.now() - started, truncated);
    }
    if (outcome === null) {
      // Worker died under us. Nothing is attributable: no quarantine.
      return unavailableHits(Date.now() - started);
    }

    // --- Timeout. Decide whether it is attributable (G3). ---------------
    this.pending = null;
    const progress = this.progress;
    const runningGeneration = progress ? Atomics.load(progress, 0) : -1;
    const index = progress ? Atomics.load(progress, 1) : -1;
    const elapsedMs = Date.now() - started;
    const attributable =
      runningGeneration === generation && index >= 0 && index < patterns.length;
    // Terminate either way: this worker is wedged or its answer is no longer
    // wanted, and the queue behind it is drained as `unavailable`.
    this.killWorker();
    if (!attributable) {
      // Queue wait, startup, or a reply that was already in flight. `-1` is
      // NEVER grounds for quarantine.
      return unavailableHits(elapsedMs, true);
    }
    const culprit = patterns[index];
    quarantinePattern({
      overlay: culprit.overlay ?? input.overlay ?? "recall-gate",
      pattern_id: culprit.id,
      source_sha8: patternSourceSha8(culprit.source, culprit.flags ?? ""),
      at: new Date().toISOString(),
      elapsed_ms: MATCH_WALL_MS,
      input_chars: text.length,
      surface: input.surface ?? "unknown",
    });
    return {
      intents: {},
      matched: [],
      timedOut: true,
      quarantined: [culprit.id],
      unavailable: false,
      truncated,
      elapsedMs,
      compiledPatterns: 0,
    };
  }

  private collect(
    reply: WorkerReply,
    patterns: readonly UserPatternSpec[],
    elapsedMs: number,
    truncated: boolean,
  ): UserPatternHits {
    const intents: Partial<Record<GateIntent, string[]>> = {};
    const matched: string[] = [];
    const byIndex = new Map(patterns.map((pattern, index) => [index, pattern]));
    reply.hits.byPattern.forEach((entry, index) => {
      if (!entry.matched) return;
      matched.push(entry.id);
      const intent = entry.intent ?? byIndex.get(index)?.intent ?? null;
      if (!intent) return;
      (intents[intent] ??= []).push(entry.id);
    });
    return {
      intents, matched, timedOut: false, quarantined: [], unavailable: false, truncated, elapsedMs,
      compiledPatterns: Number(reply.compiled ?? 0),
    };
  }
}

/** One resident worker per inject daemon; respawns at most once per 5 s. */
export function persistentMatcher(options?: MatcherOptions): MatcherHandle {
  return new TimeBoxedMatcher(true, options);
}

/** A throwaway worker for the cold hook, the CLI and the extraction worker. */
export function oneShotMatcher(options?: MatcherOptions): MatcherHandle {
  return new TimeBoxedMatcher(false, options);
}

/**
 * A handle that can never run a user pattern. Used where a matcher is structurally
 * required but overlays are switched off (`MEMEX_DISABLE_OVERLAYS=1`).
 */
export function disabledMatcher(): MatcherHandle {
  return {
    match: (input) =>
      Promise.resolve(input.patterns.length === 0 ? EMPTY_USER_PATTERN_HITS : unavailableHits(0)),
    dispose: () => {},
    state: () => "unavailable",
  };
}

/* -------------------------------------------------------------------------- */
/* Quarantine state                                                            */
/* -------------------------------------------------------------------------- */

const QUARANTINE_SCHEMA = "memex.overlay-quarantine";
const QUARANTINE_VERSION = 1;

/**
 * Quarantine rows this process is holding outside the file.
 *
 * The write is best-effort — a read-only data root must not turn a slow pattern
 * into a hung hook — but the EXCLUSION is not: an entry that failed to reach the
 * file still drops the pattern from matching in this process. Only the
 * cross-process visibility degrades.
 *
 * A row that DID reach the file is a mirror of it, not a second source of truth.
 * Keeping mirrors alive for ever made a long-running process ignore another
 * process's `quarantine clear` — and worse, put the cleared row back in the file
 * on its next write. `persistedKeys` is what tells the two apart: a mirror whose
 * row is gone from a readable file was cleared elsewhere and is dropped, while an
 * unpersisted fallback row survives because nothing has recorded it anywhere yet.
 */
const memoryQuarantine = new Map<string, QuarantineEntry>();
/** Keys of `memoryQuarantine` that a successful write put in the file. */
const persistedKeys = new Set<string>();
let memoryGeneration = 0;

export function quarantineKey(patternId: string, sourceSha8: string): string {
  return `${patternId}|${sourceSha8}`;
}

/** Bumped whenever an in-memory fallback row appears, so load caches invalidate. */
export function quarantineMemoryGeneration(): number {
  return memoryGeneration;
}

/**
 * The file's rows, and whether the file could be READ AS A LIST at all.
 *
 * `readable: false` is not "the list is empty": an absent or damaged file says
 * nothing about what an operator cleared, so it must not be mistaken for a
 * deliberate clear (see `pruneMirroredMemory`). For matching, both still mean "no
 * pattern is quarantined" — the SAFE default for the gate (a live rule keeps
 * working), and the extraction side never relies on this file to decide what to
 * forbid.
 */
function readQuarantineFile(): { readable: boolean; entries: QuarantineEntry[] } {
  try {
    const parsed = JSON.parse(fs.readFileSync(overlayQuarantinePath(), "utf8")) as {
      schema?: unknown;
      version?: unknown;
      entries?: unknown;
    };
    if (parsed?.schema !== QUARANTINE_SCHEMA) return { readable: false, entries: [] };
    if (Number(parsed.version) !== QUARANTINE_VERSION) return { readable: false, entries: [] };
    if (!Array.isArray(parsed.entries)) return { readable: false, entries: [] };
    return { readable: true, entries: parsed.entries.filter(isQuarantineEntry) };
  } catch {
    return { readable: false, entries: [] };
  }
}

/**
 * Drop the mirrors the file no longer has.
 *
 * Only for a file that was readable: a row this process persisted and that is now
 * absent was cleared by someone else, and honouring that is the whole point of
 * `quarantine clear` being a cross-process command. Unpersisted rows stay — they
 * are the read-only-data-root fallback and exist nowhere but here.
 */
function pruneMirroredMemory(file: { readable: boolean; entries: QuarantineEntry[] }): void {
  if (!file.readable) return;
  const present = new Set(file.entries.map((entry) => quarantineKey(entry.pattern_id, entry.source_sha8)));
  for (const key of [...memoryQuarantine.keys()]) {
    if (!persistedKeys.has(key) || present.has(key)) continue;
    memoryQuarantine.delete(key);
    persistedKeys.delete(key);
    memoryGeneration++;
  }
}

function isQuarantineEntry(value: unknown): value is QuarantineEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.overlay === "recall-gate" || entry.overlay === "extraction-rules") &&
    typeof entry.pattern_id === "string" && entry.pattern_id.length > 0 &&
    typeof entry.source_sha8 === "string"
  );
}

/**
 * File ∪ in-memory fallback, newest last, deduplicated by (pattern_id, sha8).
 *
 * The file is re-read on every call — there is deliberately no cache here, so a
 * `quarantine clear` in another process is visible to the next read in this one.
 */
export function readQuarantine(): QuarantineEntry[] {
  const file = readQuarantineFile();
  pruneMirroredMemory(file);
  const merged = new Map<string, QuarantineEntry>();
  for (const entry of file.entries) {
    merged.set(quarantineKey(entry.pattern_id, entry.source_sha8), entry);
  }
  for (const [key, entry] of memoryQuarantine) merged.set(key, entry);
  return [...merged.values()];
}

export function isQuarantinedPattern(
  entries: readonly QuarantineEntry[],
  patternId: string,
  source: string,
  flags: string,
): boolean {
  const sha8 = patternSourceSha8(source, flags ?? "");
  return entries.some((entry) => entry.pattern_id === patternId && entry.source_sha8 === sha8);
}

/** Attempts a single `quarantinePattern` makes when the file moves under it. */
const QUARANTINE_WRITE_ATTEMPTS = 3;
/** A write mutex with a dead holder, older than this, is broken. */
export const QUARANTINE_MUTEX_TTL_MS = 2000;

/** File identity at one instant: inode, mtime, size. `null` when absent. */
function quarantineFileStamp(): string | null {
  try {
    const stat = fs.statSync(overlayQuarantinePath());
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Write mutex                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Serialize the writers of the quarantine file.
 *
 * A stamp compare-and-swap narrows the read-merge-rename race; it cannot close
 * it. Whatever instant the stamp is read at, the `rename` is a LATER syscall, and
 * a second writer that passed the same check in between has its rows overwritten
 * by ours — silently, because a new process cannot tell a lost row from a row
 * that was never there. So the window has to be owned, not measured.
 *
 * It is a separate primitive from `overlay-admin.ts`'s lock on purpose: this path
 * is synchronous (it is called from the matcher's own result handling, where an
 * `await` is not available) and it must never block a prompt, so failing to
 * acquire degrades to the in-memory fallback instead of waiting.
 */
function quarantineMutexPath(): string {
  return `${overlayQuarantinePath()}.lock`;
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

/** Short synchronous pause — this whole path runs without an event loop turn. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* no synchronous sleep available here */ }
  }
}

/** A mutex is recoverable only when its holder is gone AND it is past the TTL. */
function quarantineMutexIsDead(mutexPath: string): boolean {
  let pid = -1;
  let at = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(mutexPath, "utf8")) as { pid?: unknown; at?: unknown };
    pid = Number(parsed.pid);
    at = Number(parsed.at);
  } catch {
    pid = -1;
    at = 0;
  }
  if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
  if (!Number.isFinite(at) || at <= 0) {
    try {
      at = fs.statSync(mutexPath).mtimeMs;
    } catch {
      return false;
    }
  }
  return Date.now() - at > QUARANTINE_MUTEX_TTL_MS;
}

/** The payload to release with, or `null` when another writer holds it. */
function acquireQuarantineMutex(): string | null {
  const mutexPath = quarantineMutexPath();
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  const staging = `${mutexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(mutexPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(staging, payload, { mode: 0o600 });
    try {
      // Atomic create-if-absent, the same discipline as the overlay lock.
      fs.linkSync(staging, mutexPath);
      return payload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      if (!quarantineMutexIsDead(mutexPath)) return null;
      try { fs.unlinkSync(mutexPath); } catch { /* another writer broke it first */ }
      try { fs.linkSync(staging, mutexPath); } catch { return null; }
      return holdsOurMutex(mutexPath, payload) ? payload : null;
    }
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(staging); } catch { /* never created, or linked away */ }
  }
}

function holdsOurMutex(mutexPath: string, payload: string): boolean {
  try {
    return fs.readFileSync(mutexPath, "utf8") === payload;
  } catch {
    return false;
  }
}

/** Release the mutex — only ever OUR own. */
function releaseQuarantineMutex(payload: string): void {
  const mutexPath = quarantineMutexPath();
  if (!holdsOurMutex(mutexPath, payload)) return;
  try { fs.unlinkSync(mutexPath); } catch { /* already broken */ }
}

/**
 * Run `body` as the only writer of the quarantine file.
 *
 * Returns `unavailable` when the mutex could not be taken. Waiting is not an
 * option on a prompt path, and the caller already has a correct degraded mode:
 * the in-memory row keeps the pattern excluded here.
 */
function withQuarantineMutex<T>(body: () => T, unavailable: T): T {
  for (let attempt = 0; attempt < QUARANTINE_WRITE_ATTEMPTS; attempt++) {
    const payload = acquireQuarantineMutex();
    if (payload === null) {
      sleepSync(5 * (attempt + 1));
      continue;
    }
    try {
      return body();
    } finally {
      releaseQuarantineMutex(payload);
    }
  }
  return unavailable;
}

/**
 * Replace the file with `entries`.
 *
 * `expectedStamp` is a compare-and-swap on the file's identity: the caller read
 * the file to build `entries`, and the rename must not land if someone else has
 * written since that read. `undefined` skips the check (the admin replace path,
 * where the operator's intent IS to overwrite).
 */
function writeQuarantineAtomic(
  entries: readonly QuarantineEntry[],
  expectedStamp?: string | null,
): boolean {
  const target = overlayQuarantinePath();
  const body = `${JSON.stringify(
    { schema: QUARANTINE_SCHEMA, version: QUARANTINE_VERSION, entries },
    null,
    2,
  )}\n`;
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const stat = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (stat?.isSymbolicLink()) return false;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    if (expectedStamp !== undefined && quarantineFileStamp() !== expectedStamp) {
      // Someone wrote between our read and here. Our `entries` no longer contain
      // their rows, so renaming would DROP them. Caller retries from a fresh read.
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      return false;
    }
    // tmp+rename changes the inode, which is what makes the load caches'
    // `mtimeMs:size:ino` key a reliable invalidation signal (§1.1).
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created */
    }
    return false;
  }
}

/**
 * Record a quarantined pattern.
 *
 * The merge is a set union keyed on (pattern_id, source_sha8), and two things make
 * it safe across processes. The whole read-merge-rename runs inside the write
 * mutex, so no second writer can pass the same stamp check and overwrite our rows
 * between our check and our rename; the stamp compare-and-swap stays as the
 * backstop for a writer that predates the mutex or ignores it.
 *
 * A row that reached the file is then a MIRROR of it (`persistedKeys`), not a
 * second source of truth: `pruneMirroredMemory` drops it when a readable file no
 * longer has it, so another process's `quarantine clear` is honoured here instead
 * of being undone by our next write.
 */
export function quarantinePattern(entry: QuarantineEntry): void {
  const key = quarantineKey(entry.pattern_id, entry.source_sha8);
  if (!memoryQuarantine.has(key)) {
    memoryQuarantine.set(key, entry);
    memoryGeneration++;
  }
  // A fresh quarantine decision, not a mirror: it must survive the prune below
  // even when the file this process last wrote has since been cleared.
  persistedKeys.delete(key);
  withQuarantineMutex(() => {
    for (let attempt = 0; attempt < QUARANTINE_WRITE_ATTEMPTS; attempt++) {
      const stamp = quarantineFileStamp();
      const file = readQuarantineFile();
      pruneMirroredMemory(file);
      const merged = new Map<string, QuarantineEntry>();
      for (const existing of file.entries) {
        merged.set(quarantineKey(existing.pattern_id, existing.source_sha8), existing);
      }
      for (const [memoryEntryKey, memoryEntry] of memoryQuarantine) merged.set(memoryEntryKey, memoryEntry);
      let entries = [...merged.values()];
      if (entries.length > QUARANTINE_MAX_ENTRIES) {
        entries = entries.slice(entries.length - QUARANTINE_MAX_ENTRIES);
      }
      if (!writeQuarantineAtomic(entries, stamp)) continue;
      // The file now holds these rows, so this process's copies of them are
      // mirrors from here on.
      for (const written of entries) {
        const writtenKey = quarantineKey(written.pattern_id, written.source_sha8);
        if (memoryQuarantine.has(writtenKey)) persistedKeys.add(writtenKey);
      }
      return;
    }
  }, undefined);
}

/**
 * Replace the persisted set. Owned by src/overlay-admin.ts (`clearQuarantine`,
 * `clearQuarantineForChangedPatterns`); nothing on the read path calls it.
 */
export function replaceQuarantine(entries: readonly QuarantineEntry[]): boolean {
  const keep = new Set(entries.map((entry) => quarantineKey(entry.pattern_id, entry.source_sha8)));
  for (const key of [...memoryQuarantine.keys()]) {
    if (!keep.has(key)) {
      memoryQuarantine.delete(key);
      persistedKeys.delete(key);
      memoryGeneration++;
    }
  }
  // Inside the mutex too: an operator's replace must not land between a
  // concurrent `quarantinePattern`'s stamp check and its rename.
  return withQuarantineMutex(() => {
    const ok = writeQuarantineAtomic(entries, undefined);
    if (ok) {
      for (const key of keep) {
        if (memoryQuarantine.has(key)) persistedKeys.add(key);
      }
    }
    return ok;
  }, false);
}

/** Test-only: forget the in-memory fallback rows of this process. */
export function resetQuarantineMemory(): void {
  persistedKeys.clear();
  if (memoryQuarantine.size === 0) return;
  memoryQuarantine.clear();
  memoryGeneration++;
}

/** Directory the quarantine file lives in — exported for doctor's detail line. */
export function quarantineLocation(): string {
  return path.join(overlayDir(), "quarantine.json");
}
