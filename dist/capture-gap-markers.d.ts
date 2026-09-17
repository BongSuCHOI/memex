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
 * `sessionId` narrows the scan to ONE session, and it narrows it on the FILE
 * NAME — which carries the session id — before the bound is applied. Capping
 * the directory listing first and filtering afterwards is how a session's
 * epoch-repair marker could be lost for ever: a few hundred Interrupt markers
 * from other sessions were enough to push the one marker that mattered out of
 * the window, and the inject replay reads this same list (#162 review 2).
 */
export declare function listCaptureGapMarkers(options?: {
    sessionId?: string;
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
