/**
 * CX-02 — one-shot migration of pre-canonical data.
 *
 * Recomputes exchanges.project / facts.scope_project from their own cwd
 * evidence. Rows without usable evidence are reported as ambiguous and left
 * untouched (never guessed into a project). Applying creates a backup of the
 * database file first and verifies row counts before/after.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalizeProjectPath, projectStorageKey } from './project-identity.js';
export function planMigration(db) {
    const rows = db.prepare('SELECT id, project, cwd FROM exchanges').all();
    const movable = [];
    const ambiguous = [];
    let alreadyCanonical = 0;
    for (const r of rows) {
        const current = r.project ?? '';
        const cwd = (r.cwd ?? '').trim();
        if (!cwd) {
            // No evidence in the row itself; recovery via source rollout is a
            // separate explicit step (reindex), never an automatic guess here.
            ambiguous.push({ id: r.id, project: current || '(empty)', reason: 'no cwd column value' });
            continue;
        }
        // Only an absolute cwd is trustworthy evidence. Legacy relative slugs
        // ('-Users-me-app', bare basenames) would resolve into phantom '/…'
        // identities — report them as ambiguous instead of guessing.
        if (!path.isAbsolute(cwd)) {
            ambiguous.push({ id: r.id, project: current, reason: 'cwd is not an absolute path (legacy slug?)' });
            continue;
        }
        const canonical = canonicalizeProjectPath(cwd);
        if (!canonical) {
            ambiguous.push({ id: r.id, project: current, reason: 'unusable cwd value' });
            continue;
        }
        if (current === canonical) {
            alreadyCanonical++;
            continue;
        }
        movable.push({ id: r.id, from: current, to: canonical });
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").all();
    const factsRescope = [];
    if (tables.length > 0) {
        const factRows = db.prepare("SELECT id, scope_project FROM facts WHERE scope_type = 'project' AND scope_project IS NOT NULL").all();
        for (const f of factRows) {
            if (!path.isAbsolute(f.scope_project))
                continue; // legacy slug: never guess
            const canonical = canonicalizeProjectPath(f.scope_project);
            if (canonical && canonical !== f.scope_project) {
                factsRescope.push({ id: f.id, from: f.scope_project, to: canonical });
            }
        }
    }
    return { totalExchanges: rows.length, alreadyCanonical, movable, ambiguous, factsRescope };
}
/** Backup via the SQLite backup API so WAL-resident commits are included. */
async function backupDatabase(db) {
    const backup = `${db.name}.pre-project-migration-${Date.now()}`;
    await db.backup(backup);
    return backup;
}
export async function applyMigration(db, dbPath) {
    const plan = planMigration(db);
    const before = {
        exchanges: db.prepare('SELECT COUNT(*) AS c FROM exchanges').get().c,
        facts: (() => {
            const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='facts'").all();
            return t.length
                ? db.prepare('SELECT COUNT(*) AS c FROM facts').get().c
                : -1;
        })(),
    };
    const backupPath = dbPath.endsWith('.sqlite') || fs.existsSync(dbPath) ? await backupDatabase(db) : null;
    let exchangesUpdated = 0;
    let factsUpdated = 0;
    let archivePathsUpdated = 0;
    const tx = db.transaction(() => {
        const upd = db.prepare('UPDATE exchanges SET project = ? WHERE id = ?');
        for (const m of plan.movable) {
            upd.run(m.to, m.id);
            exchangesUpdated++;
        }
        if (plan.factsRescope.length > 0) {
            const updf = db.prepare('UPDATE facts SET scope_project = ? WHERE id = ?');
            for (const f of plan.factsRescope) {
                updf.run(f.to, f.id);
                factsUpdated++;
            }
        }
    });
    tx();
    // Archive-path repair happens outside the transaction: only rewrite when the
    // storageKey copy actually exists on disk (deterministic, evidence-based).
    const sel = db.prepare('SELECT id, archive_path, cwd, project FROM exchanges').all();
    const upda = db.prepare('UPDATE exchanges SET archive_path = ? WHERE id = ?');
    for (const row of sel) {
        const canonical = row.cwd ? canonicalizeProjectPath(row.cwd) : row.project;
        if (!canonical)
            continue;
        const fileName = row.archive_path.split('/').pop() ?? '';
        const candidate = row.archive_path.replace(/[^/]+\/[^/]*$/, `${projectStorageKey(canonical)}/${fileName}`);
        if (candidate !== row.archive_path && fs.existsSync(candidate)) {
            upda.run(candidate, row.id);
            archivePathsUpdated++;
        }
    }
    const after = {
        exchanges: db.prepare('SELECT COUNT(*) AS c FROM exchanges').get().c,
        facts: before.facts === -1 ? -1 : db.prepare('SELECT COUNT(*) AS c FROM facts').get().c,
    };
    return {
        applied: true,
        backupPath,
        exchangesUpdated,
        factsUpdated,
        archivePathsUpdated,
        ambiguousCount: plan.ambiguous.length,
        countsVerified: before.exchanges === after.exchanges && before.facts === after.facts,
    };
}
