import type Database from "better-sqlite3";
export type WorkspaceLocationKind = "worktree" | "clone" | "directory";
export interface WorkspaceIdentity {
    projectId: string;
    workspaceId: string;
    canonicalPath: string;
    portableProjectKey: string | null;
    memoryRevision: number;
    locationKind: WorkspaceLocationKind;
    branch: string | null;
    reason: "existing-path" | "explicit" | "git-common-dir" | "approved-remote" | "new-isolated";
}
export declare function inspectWorkspaceLocation(cwd: string): {
    gitCommonDir: string | null;
    remoteFingerprint: string | null;
    locationKind: WorkspaceLocationKind;
    branch: string | null;
    gitCommonIdentity: string | null;
    gitDirIdentity: string | null;
};
export declare function resolveProjectWorkspace(db: Database.Database, input: {
    cwd: string;
    projectId?: string | null;
    portableProjectKey?: string | null;
    gitCommonDir?: string | null;
    remoteFingerprint?: string | null;
    locationKind?: WorkspaceLocationKind;
    branch?: string | null;
    now?: string;
}): WorkspaceIdentity;
export declare function approveRemoteProjectMapping(db: Database.Database, projectId: string, remoteFingerprint: string, now?: string): void;
export declare function linkWorkspaceToProject(db: Database.Database, input: {
    workspaceId: string;
    targetProjectId: string;
    approveRemote?: boolean;
    now?: string;
}): void;
export declare function splitWorkspace(db: Database.Database, input: {
    workspaceId: string;
    portableProjectKey?: string | null;
    displayName?: string;
    now?: string;
}): string;
export declare function bindSessionWorkstream(db: Database.Database, input: {
    sessionId: string;
    projectId: string;
    workspaceId: string;
    projectPath: string;
    explicitWorkstreamId?: string | null;
    branch?: string | null;
    prompt?: string | null;
    now?: string;
}): {
    workstreamId: string;
    reason: string;
    confidence: number;
};
export declare function createWorkstream(db: Database.Database, input: {
    projectId: string;
    workspaceId: string;
    projectPath: string;
    ownerSessionId: string;
    branch?: string | null;
    workstreamId?: string;
    topic?: string | null;
    now?: string;
}): string;
export declare function rebindSessionWorkstream(db: Database.Database, input: {
    sessionId: string;
    workstreamId: string;
    now?: string;
}): void;
export declare function indexHotEvidenceForSession(db: Database.Database, sessionId: string, options?: {
    ttlDays?: number;
    now?: string;
}): number;
export declare function readHotEvidence(db: Database.Database, input: {
    projectId: string;
    workspaceId?: string | null;
    workstreamId?: string | null;
    sessionId?: string | null;
    /** Sibling-lane read: the session's own evidence is already in its context. */
    excludeSessionId?: string | null;
    beforeCreatedAt?: string | null;
    beforeEvidenceId?: string | null;
    /** Residency watermark: only evidence indexed after this instant. */
    afterCreatedAt?: string | null;
    limit?: number;
    now?: string;
}): Array<Record<string, unknown>>;
export declare function assignFactSubject(db: Database.Database, input: {
    factId: string;
    projectId: string;
    subjectKey: string;
    promotionState: "decision" | "project-current" | "workspace" | "workstream";
    evidence: "explicit-decision" | "merged" | "validated" | "experimental";
    workspaceId?: string | null;
    workstreamId?: string | null;
}): void;
export declare function projectRevision(db: Database.Database, projectId: string): number;
export declare function sessionProjectRevisionState(db: Database.Database, sessionId: string): {
    projectId: string | null;
    seen: number;
    current: number;
};
export declare function markSessionProjectRevisionSeen(db: Database.Database, sessionId: string, expectedRevision: number): boolean;
