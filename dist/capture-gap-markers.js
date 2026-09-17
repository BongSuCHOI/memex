// Issue #162 — durable intent markers for hook invocations that touch capture.
//
// A continuity hook has a HOST timeout (3 s; 5 s for PreCompact) that the hook
// process cannot observe: the host kills it, no exit handler runs, and nothing
// is written. Before 0.7.24 that left no trace at all — the Stop row was simply
// missing from hook-events.jsonl and the skipped capture was invisible.
//
// The marker fixes exactly that. It is written to the filesystem BEFORE any DB
// access (so a host kill during the DB wait cannot prevent it) and deleted once
// the hook completes. A marker left behind therefore means: "a capture-relevant
// hook ran and did not finish", together with the byte boundary the transcript
// had at that moment — the datum #163's replay design needs.
//
// Deliberately file-based and DB-free: the whole point is that the database was
// unavailable (or too slow) when the marker had to be written.
import fs from "node:fs";
import path from "node:path";
import { getMemexHome } from "./paths.js";
/** Markers older than this are pruned on a hook's success path (best effort). */
export const CAPTURE_GAP_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
/** Upper bound on directory entries any single call will look at. */
const MARKER_SCAN_LIMIT = 500;
export function captureGapDir() {
    return path.join(getMemexHome(), "continuity", "gaps");
}
/** Keep a marker file name a single path segment regardless of the inputs. */
function safeSegment(value) {
    const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned.slice(0, 80) || "unknown";
}
export function captureGapMarkerPath(event, sessionId, invocationId) {
    return path.join(captureGapDir(), `${safeSegment(event)}-${safeSegment(sessionId)}-${safeSegment(invocationId)}.json`);
}
/**
 * Write the marker atomically (temp + rename). Returns the marker path, or null
 * when the filesystem refuses — observability must never break a hook.
 */
export function writeCaptureGapMarker(marker) {
    try {
        const file = captureGapMarkerPath(marker.event, marker.sessionId, marker.invocationId);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(marker) + "\n");
        fs.renameSync(temp, file);
        return file;
    }
    catch {
        return null;
    }
}
export function deleteCaptureGapMarker(file) {
    if (!file)
        return false;
    try {
        fs.rmSync(file, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
function parseMarker(file) {
    try {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!value || typeof value !== "object")
            return null;
        if (typeof value.event !== "string" || typeof value.sessionId !== "string")
            return null;
        return {
            invocationId: typeof value.invocationId === "string" ? value.invocationId : "",
            event: value.event,
            source: typeof value.source === "string" ? value.source : null,
            sessionId: value.sessionId,
            cwd: typeof value.cwd === "string" ? value.cwd : "",
            transcriptPath: typeof value.transcriptPath === "string" ? value.transcriptPath : null,
            transcriptBytes: typeof value.transcriptBytes === "number" ? value.transcriptBytes : null,
            turnId: typeof value.turnId === "string" ? value.turnId : null,
            ts: typeof value.ts === "string" ? value.ts : "",
        };
    }
    catch {
        return null;
    }
}
/** Oldest-first by `ts`; malformed files are skipped, never thrown on. */
export function listCaptureGapMarkers() {
    const dir = captureGapDir();
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of entries.slice(0, MARKER_SCAN_LIMIT)) {
        if (!name.endsWith(".json"))
            continue;
        const file = path.join(dir, name);
        const marker = parseMarker(file);
        if (marker)
            out.push({ file, marker });
    }
    out.sort((a, b) => (a.marker.ts < b.marker.ts ? -1 : a.marker.ts > b.marker.ts ? 1 : 0));
    return out;
}
/**
 * Markers of THIS session whose SessionStart source was `clear` or `compact`.
 *
 * A skipped epoch advance is the one lifecycle transition that does not heal
 * itself (continuity-core.ts advanceContextEpoch clears residency; without it
 * inject-core suppresses the very facts the new context lost), so the inject
 * path replays it from the marker.
 */
export function listEpochAdvanceMarkers(sessionId) {
    if (!sessionId)
        return [];
    return listCaptureGapMarkers().filter(({ marker }) => marker.sessionId === sessionId &&
        (marker.source === "clear" || marker.source === "compact"));
}
/**
 * Drop markers older than `maxAgeMs`. Bounded and best effort: called from a
 * hook's success path, where a failure must cost nothing.
 */
export function pruneCaptureGapMarkers(maxAgeMs = CAPTURE_GAP_MARKER_MAX_AGE_MS, now = Date.now()) {
    let pruned = 0;
    try {
        for (const { file, marker } of listCaptureGapMarkers()) {
            const ts = Date.parse(marker.ts);
            if (!Number.isFinite(ts) || now - ts <= maxAgeMs)
                continue;
            if (deleteCaptureGapMarker(file))
                pruned++;
        }
    }
    catch {
        /* pruning is maintenance, never a correctness step */
    }
    return pruned;
}
