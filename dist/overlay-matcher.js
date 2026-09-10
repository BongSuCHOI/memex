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
import { overlayDir, overlayQuarantinePath } from "./paths.js";
import { patternSourceSha8 } from "./overlay-regex.js";
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
export const EMPTY_USER_PATTERN_HITS = Object.freeze({
    intents: Object.freeze({}),
    matched: Object.freeze([]),
    timedOut: false,
    quarantined: Object.freeze([]),
    unavailable: false,
    elapsedMs: 0,
});
function unavailableHits(elapsedMs, timedOut = false) {
    return { intents: {}, matched: [], timedOut, quarantined: [], unavailable: true, elapsedMs };
}
function workerEntry() {
    return new URL("./overlay-matcher-worker.mjs", import.meta.url);
}
class TimeBoxedMatcher {
    persistent;
    worker = null;
    progress = null;
    generation = 0;
    status = "ready";
    goneAt = 0;
    disposed = false;
    /** True only while WE are terminating, so 'exit' is not read as a death. */
    terminating = false;
    pending = null;
    pendingGeneration = 0;
    /** Resolves true once the current worker is executing, false if it never got there. */
    online = null;
    /** Serialization tail: one request per worker at a time (G3). */
    tail = Promise.resolve();
    /** Observability for tests: how many workers this handle has constructed. */
    spawnCount = 0;
    constructor(persistent) {
        this.persistent = persistent;
    }
    state() {
        if (this.disposed)
            return "unavailable";
        return this.status;
    }
    match(input) {
        // Zero-cost path: no overlay patterns means no worker and no message.
        if (input.patterns.length === 0)
            return Promise.resolve(EMPTY_USER_PATTERN_HITS);
        if (this.disposed)
            return Promise.resolve(unavailableHits(0));
        const run = () => this.runOne(input);
        const queued = this.tail.then(run, run);
        // The tail must never reject, or a later request would inherit the rejection.
        this.tail = queued.then(() => undefined, () => undefined);
        return queued;
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.killWorker();
    }
    /* -------------------------------------------------------------------- */
    ensureWorker() {
        if (this.worker && this.status === "ready")
            return this.worker;
        if (this.status !== "ready") {
            // A handle that lost its worker answers `unavailable` until the respawn
            // window opens; a one-shot handle never respawns at all.
            if (!this.persistent)
                return null;
            if (Date.now() - this.goneAt < MATCHER_RESPAWN_MS)
                return null;
        }
        return this.spawn();
    }
    spawn() {
        try {
            const buffer = new SharedArrayBuffer(8);
            const progress = new Int32Array(buffer);
            Atomics.store(progress, 0, 0);
            Atomics.store(progress, 1, -1);
            const worker = new Worker(workerEntry(), { workerData: { progress: buffer } });
            // Never hold a process open. During a request the race's own timer keeps
            // the event loop alive, so the reply still arrives in a short-lived hook.
            worker.unref();
            let settleOnline = () => { };
            this.online = new Promise((resolve) => {
                settleOnline = resolve;
            });
            worker.once("error", () => settleOnline(false));
            worker.once("exit", () => settleOnline(false));
            worker.on("message", (message) => {
                if (message?.ready === true)
                    return settleOnline(true);
                const resolve = this.pending;
                if (!resolve)
                    return;
                if (Number(message?.generation) !== this.pendingGeneration)
                    return;
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
        }
        catch {
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
    async awaitOnline() {
        const online = this.online;
        if (!online)
            return false;
        let timer;
        const expired = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), MATCHER_STARTUP_MS);
        });
        try {
            return await Promise.race([online, expired]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
    /** An unexpected death: the in-flight request and the queue get `unavailable`. */
    onWorkerGone() {
        if (this.terminating)
            return;
        this.worker = null;
        this.progress = null;
        this.online = null;
        this.status = "dead";
        this.goneAt = Date.now();
        const resolve = this.pending;
        this.pending = null;
        if (resolve)
            resolve(null);
    }
    killWorker() {
        const worker = this.worker;
        this.worker = null;
        this.progress = null;
        this.online = null;
        this.status = "dead";
        this.goneAt = Date.now();
        if (!worker)
            return;
        this.terminating = true;
        try {
            void worker.terminate();
        }
        catch {
            /* already gone */
        }
        finally {
            this.terminating = false;
        }
    }
    async runOne(input) {
        if (this.disposed)
            return unavailableHits(0);
        const worker = this.ensureWorker();
        if (!worker)
            return unavailableHits(0);
        // Startup is NOT part of the 50 ms execution budget (G3).
        if (!(await this.awaitOnline())) {
            this.killWorker();
            return unavailableHits(0);
        }
        if (this.disposed)
            return unavailableHits(0);
        // `elapsedMs` reports the EXECUTION window only. Queue wait and worker
        // startup are deliberately excluded: they are not this pattern list's cost,
        // and the 50 ms cap is stated against exactly this clock.
        const started = Date.now();
        const generation = ++this.generation;
        const text = input.text.length > MATCH_INPUT_CHARS ? input.text.slice(0, MATCH_INPUT_CHARS) : input.text;
        const patterns = input.patterns;
        const reply = new Promise((resolve) => {
            this.pending = resolve;
            this.pendingGeneration = generation;
        });
        let timer;
        const timeout = new Promise((resolve) => {
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
        }
        catch {
            if (timer)
                clearTimeout(timer);
            this.pending = null;
            this.killWorker();
            return unavailableHits(Date.now() - started);
        }
        const outcome = await Promise.race([reply, timeout]);
        if (timer)
            clearTimeout(timer);
        if (outcome !== "timeout" && outcome !== null) {
            return this.collect(outcome, patterns, Date.now() - started);
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
        const attributable = runningGeneration === generation && index >= 0 && index < patterns.length;
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
            elapsedMs,
        };
    }
    collect(reply, patterns, elapsedMs) {
        const intents = {};
        const matched = [];
        const byIndex = new Map(patterns.map((pattern, index) => [index, pattern]));
        reply.hits.byPattern.forEach((entry, index) => {
            if (!entry.matched)
                return;
            matched.push(entry.id);
            const intent = entry.intent ?? byIndex.get(index)?.intent ?? null;
            if (!intent)
                return;
            (intents[intent] ??= []).push(entry.id);
        });
        return { intents, matched, timedOut: false, quarantined: [], unavailable: false, elapsedMs };
    }
}
/** One resident worker per inject daemon; respawns at most once per 5 s. */
export function persistentMatcher() {
    return new TimeBoxedMatcher(true);
}
/** A throwaway worker for the cold hook, the CLI and the extraction worker. */
export function oneShotMatcher() {
    return new TimeBoxedMatcher(false);
}
/**
 * A handle that can never run a user pattern. Used where a matcher is structurally
 * required but overlays are switched off (`MEMEX_DISABLE_OVERLAYS=1`).
 */
export function disabledMatcher() {
    return {
        match: (input) => Promise.resolve(input.patterns.length === 0 ? EMPTY_USER_PATTERN_HITS : unavailableHits(0)),
        dispose: () => { },
        state: () => "unavailable",
    };
}
/* -------------------------------------------------------------------------- */
/* Quarantine state                                                            */
/* -------------------------------------------------------------------------- */
const QUARANTINE_SCHEMA = "memex.overlay-quarantine";
const QUARANTINE_VERSION = 1;
/**
 * Quarantine rows this process could not persist.
 *
 * The write is best-effort — a read-only data root must not turn a slow pattern
 * into a hung hook — but the EXCLUSION is not: an entry that failed to reach the
 * file still drops the pattern from matching in this process. Only the
 * cross-process visibility degrades.
 */
const memoryQuarantine = new Map();
let memoryGeneration = 0;
export function quarantineKey(patternId, sourceSha8) {
    return `${patternId}|${sourceSha8}`;
}
/** Bumped whenever an in-memory fallback row appears, so load caches invalidate. */
export function quarantineMemoryGeneration() {
    return memoryGeneration;
}
function readQuarantineFile() {
    try {
        const parsed = JSON.parse(fs.readFileSync(overlayQuarantinePath(), "utf8"));
        if (parsed?.schema !== QUARANTINE_SCHEMA)
            return [];
        if (Number(parsed.version) !== QUARANTINE_VERSION)
            return [];
        if (!Array.isArray(parsed.entries))
            return [];
        return parsed.entries.filter(isQuarantineEntry);
    }
    catch {
        // Absent or damaged: no pattern is quarantined. This is the SAFE default for
        // the gate (a live rule keeps working) and the extraction side never relies
        // on this file to decide what to forbid.
        return [];
    }
}
function isQuarantineEntry(value) {
    if (!value || typeof value !== "object")
        return false;
    const entry = value;
    return ((entry.overlay === "recall-gate" || entry.overlay === "extraction-rules") &&
        typeof entry.pattern_id === "string" && entry.pattern_id.length > 0 &&
        typeof entry.source_sha8 === "string");
}
/** File ∪ in-memory fallback, newest last, deduplicated by (pattern_id, sha8). */
export function readQuarantine() {
    const merged = new Map();
    for (const entry of readQuarantineFile()) {
        merged.set(quarantineKey(entry.pattern_id, entry.source_sha8), entry);
    }
    for (const [key, entry] of memoryQuarantine)
        merged.set(key, entry);
    return [...merged.values()];
}
export function isQuarantinedPattern(entries, patternId, source, flags) {
    const sha8 = patternSourceSha8(source, flags ?? "");
    return entries.some((entry) => entry.pattern_id === patternId && entry.source_sha8 === sha8);
}
function writeQuarantineAtomic(entries) {
    const target = overlayQuarantinePath();
    const body = `${JSON.stringify({ schema: QUARANTINE_SCHEMA, version: QUARANTINE_VERSION, entries }, null, 2)}\n`;
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        const stat = fs.existsSync(target) ? fs.lstatSync(target) : null;
        if (stat?.isSymbolicLink())
            return false;
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        // tmp+rename changes the inode, which is what makes the load caches'
        // `mtimeMs:size:ino` key a reliable invalidation signal (§1.1).
        fs.renameSync(tmp, target);
        return true;
    }
    catch {
        try {
            fs.unlinkSync(tmp);
        }
        catch {
            /* never created */
        }
        return false;
    }
}
/**
 * Record a quarantined pattern. Merge is a SET UNION keyed on
 * (pattern_id, source_sha8), so concurrent writers cannot lose an entry and no
 * lock, revision or CAS is involved.
 */
export function quarantinePattern(entry) {
    const key = quarantineKey(entry.pattern_id, entry.source_sha8);
    const merged = new Map();
    for (const existing of readQuarantineFile()) {
        merged.set(quarantineKey(existing.pattern_id, existing.source_sha8), existing);
    }
    for (const [memoryEntryKey, memoryEntry] of memoryQuarantine)
        merged.set(memoryEntryKey, memoryEntry);
    if (!merged.has(key))
        merged.set(key, entry);
    let entries = [...merged.values()];
    if (entries.length > QUARANTINE_MAX_ENTRIES) {
        entries = entries.slice(entries.length - QUARANTINE_MAX_ENTRIES);
    }
    if (writeQuarantineAtomic(entries)) {
        // Persisted: later loads read it from the file and the memory copy can go.
        memoryQuarantine.delete(key);
        return;
    }
    memoryQuarantine.set(key, entry);
    memoryGeneration++;
}
/**
 * Replace the persisted set. Owned by src/overlay-admin.ts (`clearQuarantine`,
 * `clearQuarantineForChangedPatterns`); nothing on the read path calls it.
 */
export function replaceQuarantine(entries) {
    const keep = new Set(entries.map((entry) => quarantineKey(entry.pattern_id, entry.source_sha8)));
    for (const key of [...memoryQuarantine.keys()]) {
        if (!keep.has(key)) {
            memoryQuarantine.delete(key);
            memoryGeneration++;
        }
    }
    return writeQuarantineAtomic(entries);
}
/** Test-only: forget the in-memory fallback rows of this process. */
export function resetQuarantineMemory() {
    if (memoryQuarantine.size === 0)
        return;
    memoryQuarantine.clear();
    memoryGeneration++;
}
/** Directory the quarantine file lives in — exported for doctor's detail line. */
export function quarantineLocation() {
    return path.join(overlayDir(), "quarantine.json");
}
