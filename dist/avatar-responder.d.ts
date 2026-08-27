import Database from 'better-sqlite3';
import type { AvatarResponse } from './types.js';
export declare function askAvatar(db: Database.Database, question: string, project?: string, scope?: 'project' | 'global' | 'all'): Promise<AvatarResponse>;
