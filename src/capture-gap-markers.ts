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

/** Upper bound on markers any single call will RETURN. */
const MARKER_SCAN_LIMIT = 500;
/** Upper bound on files a single call will open, after the name prefilters. */
const MARKER_PARSE_LIMIT = 20_000;

export interface CaptureGapMarker {
  invocationId: string;
  event: string;
  source: string | null;
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  /** fs.statSync(transcript).size at hook start, or null when unavailable. */
  transcriptBytes: number | null;
  turnId: string | null;
  ts: string;
}

export interface LoadedCaptureGapMarker {
  file: string;
  marker: CaptureGapMarker;
}

export function captureGapDir(): string {
  return path.join(getMemexHome(), "continuity", "gaps");
}

/** Keep a marker file name a single path segment regardless of the inputs. */
function safeSegment(value: string): string {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.slice(0, 80) || "unknown";
}

export function captureGapMarkerPath(
  event: string,
  sessionId: string,
  invocationId: string,
): string {
  return path.join(
    captureGapDir(),
    `${safeSegment(event)}-${safeSegment(sessionId)}-${safeSegment(invocationId)}.json`,
  );
}

/**
 * Write the marker atomically (temp + rename). Returns the marker path, or null
 * when the filesystem refuses — observability must never break a hook.
 */
export function writeCaptureGapMarker(marker: CaptureGapMarker): string | null {
  try {
    const file = captureGapMarkerPath(marker.event, marker.sessionId, marker.invocationId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(marker) + "\n");
    fs.renameSync(temp, file);
    return file;
  } catch {
    return null;
  }
}

export function deleteCaptureGapMarker(file: string | null | undefined): boolean {
  if (!file) return false;
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

function parseMarker(file: string): CaptureGapMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<CaptureGapMarker>;
    if (!value || typeof value !== "object") return null;
    if (typeof value.event !== "string" || typeof value.sessionId !== "string") return null;
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
  } catch {
    return null;
  }
}

/**
 * Oldest-first by `ts`; malformed files are skipped, never thrown on.
 *
 * EVERY selective filter runs before the bound, and the bound applies to what
 * is RETURNED, never to what the scan is allowed to look at. That ordering is
 * the whole point (#162 review 2/3): capping the directory listing first and
 * filtering afterwards made a session's epoch-repair marker invisible for ever
 * behind a few hundred markers that were never candidates — first other
 * sessions' markers, then the session's OWN Interrupt markers — and the inject
 * replay reads this same list.
 *
 * `sessionId` and `event` are also matched on the FILE NAME, which carries
 * both, so the common case never parses a file it cannot want. `match` sees the
 * parsed marker for everything the name cannot answer (`source`, `ts`).
 */
export function listCaptureGapMarkers(
  options: {
    sessionId?: string;
    event?: string;
    match?: (marker: CaptureGapMarker) => boolean;
    limit?: number;
  } = {},
): LoadedCaptureGapMarker[] {
  const dir = captureGapDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const limit = options.limit ?? MARKER_SCAN_LIMIT;
  // `<event>-<session>-<invocation>.json`, each segment already sanitized.
  const wantedSession = options.sessionId ? `-${safeSegment(options.sessionId)}-` : null;
  const wantedEvent = options.event ? `${safeSegment(options.event)}-` : null;
  const out: LoadedCaptureGapMarker[] = [];
  let scanned = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    // The name is only a cheap prefilter; the parsed marker below decides.
    if (wantedSession && !name.includes(wantedSession)) continue;
    if (wantedEvent && !name.startsWith(wantedEvent)) continue;
    // A bound on work that survives a pathological directory, deliberately far
    // above the returned limit so it can never be what hides a candidate.
    if (++scanned > MARKER_PARSE_LIMIT) break;
    const file = path.join(dir, name);
    const marker = parseMarker(file);
    if (!marker) continue;
    if (options.sessionId && marker.sessionId !== options.sessionId) continue;
    if (options.event && marker.event !== options.event) continue;
    if (options.match && !options.match(marker)) continue;
    out.push({ file, marker });
    if (out.length >= limit) break;
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
export function listEpochAdvanceMarkers(sessionId: string): LoadedCaptureGapMarker[] {
  if (!sessionId) return [];
  // Both predicates go IN, not after: the session's own Stop/Interrupt markers
  // are far more numerous than its SessionStart ones, so filtering afterwards
  // is exactly how the marker that matters fell out of the window.
  return listCaptureGapMarkers({
    sessionId,
    event: "SessionStart",
    match: (marker) => marker.source === "clear" || marker.source === "compact",
  });
}

/**
 * Drop markers older than `maxAgeMs`. Bounded and best effort: called from a
 * hook's success path, where a failure must cost nothing.
 */
export function pruneCaptureGapMarkers(
  maxAgeMs: number = CAPTURE_GAP_MARKER_MAX_AGE_MS,
  now: number = Date.now(),
): number {
  let pruned = 0;
  try {
    for (const { file, marker } of listCaptureGapMarkers()) {
      const ts = Date.parse(marker.ts);
      if (!Number.isFinite(ts) || now - ts <= maxAgeMs) continue;
      if (deleteCaptureGapMarker(file)) pruned++;
    }
  } catch {
    /* pruning is maintenance, never a correctness step */
  }
  return pruned;
}
