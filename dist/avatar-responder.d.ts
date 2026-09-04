import Database from 'better-sqlite3';
import type { AvatarResponse } from './types.js';
import { type FactSearchScope } from './fact-db.js';
export declare function askAvatar(db: Database.Database, question: string, project?: string, scope?: 'project' | 'global' | 'all', identityScope?: FactSearchScope): Promise<AvatarResponse>;
