import type Database from 'better-sqlite3';
import type { ReadScope } from './read-scope.js';
import type { Fact } from './types.js';
export declare function adaptLegacyFactForRead(db: Database.Database, fact: Fact): Fact;
export type LegacyReadScope = {
    type: 'project';
    project: string;
} | {
    type: 'exact-project';
    project: string;
} | {
    type: 'other-projects';
    project: string;
};
/** Read-only compatibility: paths resolve at the edge, never inside the core. */
export declare function adaptLegacyReadScope(db: Database.Database, scope: ReadScope | LegacyReadScope): ReadScope;
/** Legacy optional arguments default to global, never to all projects. */
export declare function legacyOptionalReadScope(db: Database.Database, project?: string | null, type?: 'project' | 'global' | 'all', identity?: ReadScope | LegacyReadScope): ReadScope;
