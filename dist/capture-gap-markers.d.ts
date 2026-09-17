/** Markers older than this are pruned on a hook's success path (best effort). */
export declare const CAPTURE_GAP_MARKER_MAX_AGE_MS: number;
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
export declare function captureGapDir(): string;
export declare function captureGapMarkerPath(event: string, sessionId: string, invocationId: string): string;
/**
 * Write the marker atomically (temp + rename). Returns the marker path, or null
 * when the filesystem refuses — observability must never break a hook.
 */
export declare function writeCaptureGapMarker(marker: CaptureGapMarker): string | null;
export declare function deleteCaptureGapMarker(file: string | null | undefined): boolean;
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
export declare function listCaptureGapMarkers(options?: {
    sessionId?: string;
    event?: string;
    match?: (marker: CaptureGapMarker) => boolean;
    limit?: number;
}): LoadedCaptureGapMarker[];
/**
 * Markers of THIS session whose SessionStart source was `clear` or `compact`.
 *
 * A skipped epoch advance is the one lifecycle transition that does not heal
 * itself (continuity-core.ts advanceContextEpoch clears residency; without it
 * inject-core suppresses the very facts the new context lost), so the inject
 * path replays it from the marker.
 */
export declare function listEpochAdvanceMarkers(sessionId: string): LoadedCaptureGapMarker[];
/**
 * Drop markers older than `maxAgeMs`. Bounded and best effort: called from a
 * hook's success path, where a failure must cost nothing.
 */
export declare function pruneCaptureGapMarkers(maxAgeMs?: number, now?: number): number;
