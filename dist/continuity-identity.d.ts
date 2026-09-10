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
    /**
     * Repository default branch: `origin/HEAD`, then the repository's
     * `init.defaultBranch`, then the user's global/system `init.defaultBranch`.
     */
    defaultBranch: string | null;
    reason: "existing-path" | "explicit" | "git-common-dir" | "approved-remote" | "new-isolated";
}
/**
 * 0.6.0 scope model (#16/#18). A session carries a *branch signal* only when it
 * runs on a non-default branch (or a worktree checked out on one). Default
 * branch and non-git sessions carry none, and their memory belongs to the
 * project-common tier instead of a per-session stream.
 */
export type BranchSignalKind = "none" | "default" | "branch";
export interface BranchSignal {
    kind: BranchSignalKind;
    /** The captured branch name, kept for display even when it is the default. */
    branch: string | null;
    /** Recorded on the fact and in the Chronicle event that places it. */
    tierReason: "no-branch-signal" | "default-branch" | string;
}
/** Fallback default-branch names when the repository states none. */
export declare const CONVENTIONAL_DEFAULT_BRANCHES: readonly ["main", "master"];
export declare function isDefaultBranchName(branch: string | null | undefined, defaultBranch: string | null | undefined): boolean;
export declare function branchSignalFor(input: {
    branch?: string | null;
    defaultBranch?: string | null;
}): BranchSignal;
/**
 * Deterministic workstream identity. A branch signal keys on (project, branch)
 * so two worktrees of the same repository on the same branch share one stream
 * (they share the project via the git-common-dir rule but not the workspace
 * row); no branch signal keys on the project alone so every default-branch and
 * non-git session of a project reuses ONE default stream instead of minting a
 * per-session `ws-<hash(project, session)>`.
 */
export declare function deterministicWorkstreamId(projectId: string, branch: string | null): string;
export declare function inspectWorkspaceLocation(cwd: string): {
    gitCommonDir: string | null;
    remoteFingerprint: string | null;
    locationKind: WorkspaceLocationKind;
    branch: string | null;
    defaultBranch: string | null;
    gitCommonIdentity: string | null;
    gitDirIdentity: string | null;
};
/**
 * #21 — `WORKSPACE_LOCATION_CHANGED`. Its id is derived from the transition's
 * shape, not from the clock, so re-running the same session start records the
 * same single event instead of one per session.
 */
export declare function recordWorkspaceLocationChange(db: Database.Database, input: {
    workspaceId: string;
    projectId: string;
    from: string;
    to: string;
    gitCommonDir: string | null;
    remoteFingerprint: string | null;
    branch: string | null;
    changedFields: string[];
    conflictProjectIds: string[];
    now?: string;
}): string;
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
/** The branch signal a session carries, read from its bound workspace row. */
export declare function sessionBranchSignal(db: Database.Database, input: {
    workspaceId?: string | null;
    branch?: string | null;
}): BranchSignal;
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
    /** Optional timestamp filter; automatic residency uses afterSeq. */
    afterCreatedAt?: string | null;
    /** Automatic continuity reads the oldest unconsumed eligible sequence. */
    afterSeq?: number;
    limit?: number;
    now?: string;
}): Array<Record<string, unknown>>;
/** Commit only the emitted eligible prefix; a purge/rebind/epoch race retries. */
export declare function commitHotEvidenceCursor(db: Database.Database, input: {
    sessionId: string;
    projectId: string;
    workstreamId: string;
    contextEpoch: number;
    fromSeq: number;
    emittedSeqs: number[];
}): void;
export declare function assignFactSubject(db: Database.Database, input: {
    factId: string;
    projectId: string;
    subjectKey: string;
    promotionState: "decision" | "project-current" | "workspace" | "workstream";
    /**
     * #18 — `no-branch-signal` is admissible evidence for project-current: a
     * non-git or default-branch session has no branch for the fact to belong
     * to, so project-common IS its grounded placement, not a promotion.
     */
    evidence: "explicit-decision" | "merged" | "validated" | "experimental" | "no-branch-signal";
    /** Recorded on the fact: `no-branch-signal` | `default-branch` | `branch:<name>`. */
    tierReason?: string | null;
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
