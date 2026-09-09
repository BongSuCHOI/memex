import type Database from 'better-sqlite3';
import type { Fact } from './types.js';

/** What a caller may read. Never grants permission to mutate a fact. */
export type ReadScope =
  | { type: 'global' }
  | { type: 'all' }
  | { type: 'fact-ids'; factIds: readonly string[] }
  | { type: 'other-project-id'; projectId: string }
  | { type: 'project-id'; projectId: string; includeGlobal?: boolean }
  | { type: 'workspace-id'; projectId: string; workspaceId: string; includeGlobal?: boolean }
  | { type: 'workstream-id'; projectId: string; workspaceId?: string | null; workstreamId: string; includeGlobal?: boolean }
  | { type: 'session-id'; projectId: string; sessionId: string; includeGlobal?: boolean };

export function readScopeForFact(fact: Fact): ReadScope | null {
  if (fact.scope_type === 'global') return { type: 'global' };
  if (!fact.project_id) return null;
  if (fact.promotion_state === 'workstream') return fact.workstream_id
    ? { type: 'workstream-id', projectId: fact.project_id, workspaceId: fact.workspace_id, workstreamId: fact.workstream_id } : null;
  if (fact.promotion_state === 'workspace') return fact.workspace_id
    ? { type: 'workspace-id', projectId: fact.project_id, workspaceId: fact.workspace_id } : null;
  return { type: 'project-id', projectId: fact.project_id };
}

/**
 * #38 — a session that never attached to a project, or whose project was
 * quarantined because its identity came from an untrusted cwd (`/`), degrades
 * to global-only reading. Reading nothing but global facts is safe; reading
 * another project's facts as your own is the leak this replaces.
 */
export function readScopeForSession(db: Database.Database, sessionId: string): ReadScope | null {
  const row = db.prepare(`
    SELECT s.project_id, s.workspace_id, s.workstream_id,
           COALESCE(p.quarantined, 0) AS quarantined
    FROM session_memory_state s LEFT JOIN projects p ON p.project_id = s.project_id
    WHERE s.session_id = ?
  `).get(sessionId) as {
    project_id: string | null; workspace_id: string | null; workstream_id: string | null;
    quarantined: number;
  } | undefined;
  if (!row) return null;
  if (Number(row.quarantined) === 1) return { type: 'global' };
  return row.project_id && row.workstream_id
    ? { type: 'workstream-id', projectId: row.project_id, workspaceId: row.workspace_id, workstreamId: row.workstream_id }
    : { type: 'global' };
}

export function assertReadScope(db: Database.Database, scope: ReadScope): void {
  if (!scope || typeof scope !== 'object') throw new Error('ReadScope is required');
  if (scope.type === 'global' || scope.type === 'all') return;
  if (scope.type === 'fact-ids') {
    if (!Array.isArray(scope.factIds) || !scope.factIds.every(id => typeof id === 'string' && id.length > 0)) throw new Error('invalid fact-id ReadScope');
    return;
  }
  if (!['project-id', 'workspace-id', 'workstream-id', 'session-id', 'other-project-id'].includes(scope.type)) throw new Error('unsupported ReadScope');
  if (!scope.projectId || typeof scope.projectId !== 'string') throw new Error('ReadScope requires projectId');
  const belongs = (table: string, column: string, id: string | null | undefined) => {
    if (!id || typeof id !== 'string') throw new Error(`ReadScope requires ${column}`);
    const row = db.prepare(`SELECT project_id FROM ${table} WHERE ${column} = ?`).get(id) as { project_id: string | null } | undefined;
    if (!row || row.project_id !== scope.projectId) throw new Error(`${column} is outside ReadScope projectId`);
  };
  if (scope.type === 'workspace-id') belongs('workspaces', 'workspace_id', scope.workspaceId);
  if (scope.type === 'workstream-id') {
    belongs('minimal_workstreams', 'workstream_id', scope.workstreamId);
    if (scope.workspaceId) belongs('workspaces', 'workspace_id', scope.workspaceId);
  }
  if (scope.type === 'session-id') belongs('session_memory_state', 'session_id', scope.sessionId);
}
