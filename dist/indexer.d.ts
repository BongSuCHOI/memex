/**
 * Summary freshness (재감사 §6): a summary is current only while the archive
 * has not changed since it was written. A resumed rollout grows the archive
 * file, so its mtime then postdates the summary — regenerate instead of
 * advertising the truncated summary forever. No extra state: the archive is
 * Memex-owned and append-only, so mtime is a reliable change signal.
 */
export declare function summaryNeedsRefresh(archivePath: string, summaryPath: string): boolean;
export declare function processBatch<T, R>(items: T[], processor: (item: T) => Promise<R>, concurrency: number): Promise<R[]>;
export declare function indexConversations(limitToProject?: string, maxConversations?: number, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexSession(sessionId: string, concurrency?: number, noSummaries?: boolean): Promise<void>;
export declare function indexUnprocessed(concurrency?: number, noSummaries?: boolean): Promise<void>;
