export declare function dataRoot(): string;
export declare function observationLogPath(): string;
export declare function recordHookEvent(event: string, info: {
    sessionId?: unknown;
    cwd?: unknown;
}): void;
export declare function lastObserved(event: string): string | null;
