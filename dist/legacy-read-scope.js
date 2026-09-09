import { canonicalizeProjectPath } from './project-identity.js';
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
export function adaptLegacyFactForRead(db, fact) {
    if (fact.scope_type !== 'project' || fact.project_id || !fact.scope_project ||
        (fact.promotion_state && fact.promotion_state !== 'legacy-project') || !hasTable(db, 'workspaces'))
        return fact;
    const row = db.prepare('SELECT project_id FROM workspaces WHERE canonical_path = ? ORDER BY workspace_id LIMIT 1')
        .get(canonicalizeProjectPath(fact.scope_project));
    return row ? { ...fact, project_id: row.project_id, promotion_state: 'legacy-project' } : fact;
}
/** Read-only compatibility: paths resolve at the edge, never inside the core. */
export function adaptLegacyReadScope(db, scope) {
    if (!scope)
        throw new Error('ReadScope is required');
    if (scope.type !== 'project' && scope.type !== 'exact-project' && scope.type !== 'other-projects')
        return scope;
    if (!scope.project?.trim())
        throw new Error('legacy read scope requires a project path');
    const project = canonicalizeProjectPath(scope.project);
    const row = hasTable(db, 'workspaces') ? db.prepare('SELECT project_id FROM workspaces WHERE canonical_path = ? ORDER BY workspace_id LIMIT 1')
        .get(project) : undefined;
    if (row)
        return scope.type === 'other-projects'
            ? { type: 'other-project-id', projectId: row.project_id }
            : { type: 'project-id', projectId: row.project_id, includeGlobal: scope.type === 'project' };
    // Unmapped historical data stays readable by an explicit legacy key. No
    // workspace creation, identity promotion or experimental workstream widening.
    const columns = new Set(db.prepare('PRAGMA table_info(facts)').all().map(row => row.name));
    const ids = db.prepare(`SELECT id, scope_type, scope_project FROM facts
    ${columns.has('promotion_state') ? "WHERE COALESCE(promotion_state, 'legacy-project') IN ('legacy-project', 'decision', 'project-current')" : ''}`)
        .all().filter(fact => {
        if (fact.scope_type === 'global')
            return scope.type === 'project';
        if (fact.scope_type !== 'project' || !fact.scope_project)
            return false;
        const same = canonicalizeProjectPath(fact.scope_project) === project;
        return scope.type === 'other-projects' ? !same : same;
    });
    return { type: 'fact-ids', factIds: ids.map(row => row.id) };
}
/** Legacy optional arguments default to global, never to all projects. */
export function legacyOptionalReadScope(db, project, type, identity) {
    return adaptLegacyReadScope(db, identity ?? (type === 'all' ? { type: 'all' }
        : type === 'global' || !project ? { type: 'global' } : { type: 'project', project }));
}
