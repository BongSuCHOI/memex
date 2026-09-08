import type Database from 'better-sqlite3';
import type { Fact } from './types.js';
/** What a caller may read. Never grants permission to mutate a fact. */
export type ReadScope = {
    type: 'global';
} | {
    type: 'all';
} | {
    type: 'fact-ids';
    factIds: readonly string[];
} | {
    type: 'other-project-id';
    projectId: string;
} | {
    type: 'project-id';
    projectId: string;
    includeGlobal?: boolean;
} | {
    type: 'workspace-id';
    projectId: string;
    workspaceId: string;
    includeGlobal?: boolean;
} | {
    type: 'workstream-id';
    projectId: string;
    workspaceId?: string | null;
    workstreamId: string;
    includeGlobal?: boolean;
} | {
    type: 'session-id';
    projectId: string;
    sessionId: string;
    includeGlobal?: boolean;
};
export declare function readScopeForFact(fact: Fact): ReadScope | null;
export declare function readScopeForSession(db: Database.Database, sessionId: string): ReadScope | null;
export declare function assertReadScope(db: Database.Database, scope: ReadScope): void;
