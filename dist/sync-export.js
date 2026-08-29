import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDatabase } from './db.js';
import { getMemexHome } from './paths.js';
const SYNC_DIR_NAME = 'sync';
const GENERATIONS_DIR_NAME = 'generations';
const CURRENT_MANIFEST = 'CURRENT';
/** Committed generations kept per device: current + one previous for
 * readers that resolved CURRENT between two exports. */
const GENERATIONS_TO_KEEP = 2;
const EXPORT_STATUS_FILE = 'export-status.json';
export function getSyncDir() {
    const dir = path.join(getMemexHome(), 'conversation-index', SYNC_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
function getExportStatusPath() {
    return path.join(getMemexHome(), 'conversation-index', SYNC_DIR_NAME, EXPORT_STATUS_FILE);
}
export function readExportStatus() {
    try {
        const parsed = JSON.parse(fs.readFileSync(getExportStatusPath(), 'utf8'));
        return typeof parsed?.ok === 'boolean' ? parsed : null;
    }
    catch {
        return null;
    }
}
export function recordExportStatus(status) {
    const target = getExportStatusPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    fs.renameSync(tmp, target);
}
function writeAtomic(target, body) {
    // Per-process tmp name: two concurrent exports must never rename each
    // other's half-written file.
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, target);
}
/** Delete old committed generations (keep current + one previous) and
 * crashed tmp dirs older than an hour. Old generations are immutable, so
 * removal cannot corrupt a reader that already resolved CURRENT. */
function pruneGenerations(generationsDir, currentId) {
    let entries;
    try {
        entries = fs.readdirSync(generationsDir, { withFileTypes: true });
    }
    catch {
        return;
    }
    const previous = entries
        .filter((e) => e.isDirectory() && !e.name.endsWith('.tmp') && e.name !== currentId)
        .map((e) => {
        try {
            return { name: e.name, mtimeMs: fs.statSync(path.join(generationsDir, e.name)).mtimeMs };
        }
        catch {
            return null;
        }
    })
        .filter((v) => v !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const g of previous.slice(GENERATIONS_TO_KEEP - 1)) {
        try {
            fs.rmSync(path.join(generationsDir, g.name), { recursive: true, force: true });
        }
        catch { /* best-effort housekeeping */ }
    }
    const staleTmpMs = 60 * 60 * 1000;
    for (const e of entries.filter((e) => e.isDirectory() && e.name.endsWith('.tmp'))) {
        try {
            const st = fs.statSync(path.join(generationsDir, e.name));
            if (Date.now() - st.mtimeMs > staleTmpMs) {
                fs.rmSync(path.join(generationsDir, e.name), { recursive: true, force: true });
            }
        }
        catch { /* best-effort housekeeping */ }
    }
}
/**
 * Export current and historical fact state, durable recall receipts, ontology
 * domains/categories, and relations to JSONL files.
 * These JSONL files are durable cross-device state; the large local SQLite
 * index is not copied. Conversation indexes rebuild from rollouts/archives,
 * while facts, revisions, tombstones, and recall receipts reconcile from here.
 *
 * P2-5: one export is one *generation*. Every DB read happens inside a single
 * read transaction, the whole file set is written into
 * `devices/<id>/generations/<uuid>.tmp` and committed by an atomic directory
 * rename, and only then does the `CURRENT` manifest flip atomically — so a
 * crash, a cloud-sync observer, or a concurrent export can never surface a
 * mixed snapshot (facts=N+1 with revisions=N). The importer reads committed
 * generations only. The root JSONL mirror (v1 reader compatibility) is
 * refreshed per-file after the generation commit; it is a compat surface, not
 * the authoritative device state.
 */
export function exportForSync() {
    const db = initDatabase();
    const syncDir = getSyncDir();
    try {
        let device = db.prepare("SELECT value FROM sync_meta WHERE key = 'device_id'").get();
        if (!device) {
            const value = randomUUID();
            db.prepare("INSERT INTO sync_meta (key, value) VALUES ('device_id', ?)").run(value);
            device = { value };
        }
        const deviceDir = path.join(syncDir, 'devices', device.value);
        fs.mkdirSync(deviceDir, { recursive: true });
        // One read transaction fixes the snapshot for every file in this
        // generation — WAL readers see one consistent DB state throughout.
        const readTx = db.transaction(() => {
            // Export active and inactive facts. is_active is a revision-bearing state;
            // filtering it here would make deactivation impossible to reconcile.
            // semantic_updated_at carries the meaning clock (재감사 P1-3): peers must
            // judge conflicts by the semantic event time, not by a polluted updated_at.
            const facts = db.prepare(`
        SELECT id, fact, fact_kr, category, scope_type, scope_project, source_exchange_ids,
               created_at, updated_at, consolidated_count, is_active, ontology_category_id,
               semantic_updated_at
        FROM facts ORDER BY id
      `).all();
            const revisions = db.prepare(`
        SELECT id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at
        FROM fact_revisions ORDER BY id
      `).all();
            const tombstones = db.prepare(`
        SELECT fact_id, deleted_at, reason FROM fact_tombstones ORDER BY fact_id
      `).all();
            // recall_events cannot be reconstructed from source rollouts. Export the
            // durable receipt so recalled context stays non-learnable after migration.
            const recallEvents = db.prepare(`
        SELECT id, session_id, project, prompt_hash, fact_ids, source_type,
               learnable, status, created_at, emitted_at
        FROM recall_events ORDER BY id
      `).all();
            const domains = db.prepare('SELECT * FROM ontology_domains').all();
            const categories = db.prepare('SELECT * FROM ontology_categories').all();
            // 재감사 P1-3: endpoint version은 의미 세계의 semantic_updated_at으로 기록한다 —
            // 구버전 reader를 위해 updated_at stamp는 유지한다(transition fallback).
            const relations = db.prepare(`
        SELECT r.*, sf.updated_at AS source_fact_updated_at,
               tf.updated_at AS target_fact_updated_at,
               sf.semantic_updated_at AS source_fact_semantic_updated_at,
               tf.semantic_updated_at AS target_fact_semantic_updated_at
        FROM ontology_relations r
        JOIN facts sf ON sf.id = r.source_fact_id
        JOIN facts tf ON tf.id = r.target_fact_id
        ORDER BY r.id
      `).all();
            return { facts, revisions, tombstones, recallEvents, domains, categories, relations };
        });
        const { facts, revisions, tombstones, recallEvents, domains, categories, relations } = readTx();
        const generationId = randomUUID();
        const meta = {
            protocol_version: 2,
            generation: generationId,
            device_id: device.value,
            exported_at: new Date().toISOString(),
            hostname: os.hostname(),
            facts_count: facts.length,
            revisions_count: revisions.length,
            tombstones_count: tombstones.length,
            recall_events_count: recallEvents.length,
            domains_count: domains.length,
            categories_count: categories.length,
            relations_count: relations.length,
        };
        const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const files = {
            'facts.jsonl': jsonl(facts),
            'fact-revisions.jsonl': jsonl(revisions),
            'fact-tombstones.jsonl': jsonl(tombstones),
            'recall-events.jsonl': jsonl(recallEvents),
            'ontology-domains.jsonl': jsonl(domains),
            'ontology-categories.jsonl': jsonl(categories),
            'ontology-relations.jsonl': jsonl(relations),
            'meta.json': JSON.stringify(meta, null, 2),
        };
        const generationsDir = path.join(deviceDir, GENERATIONS_DIR_NAME);
        fs.mkdirSync(generationsDir, { recursive: true });
        const genPath = path.join(generationsDir, generationId);
        const tmpPath = `${genPath}.tmp`;
        fs.rmSync(tmpPath, { recursive: true, force: true }); // leftover from a crash
        fs.mkdirSync(tmpPath, { recursive: true });
        for (const [name, body] of Object.entries(files)) {
            fs.writeFileSync(path.join(tmpPath, name), body);
        }
        fs.renameSync(tmpPath, genPath);
        // The manifest flip is the commit point: before it, readers resolve the
        // previous generation; after it, this complete one.
        writeAtomic(path.join(deviceDir, CURRENT_MANIFEST), JSON.stringify({ generation: generationId, exported_at: meta.exported_at }, null, 2));
        // Root mirror preserves v1 readers during the protocol transition. It is
        // refreshed per-file (whole-file atomic) after the generation commit —
        // the authoritative, set-atomic device state is the generation above.
        for (const [name, body] of Object.entries(files)) {
            writeAtomic(path.join(syncDir, name), body);
        }
        pruneGenerations(generationsDir, generationId);
        return {
            facts: facts.length,
            revisions: revisions.length,
            tombstones: tombstones.length,
            recallEvents: recallEvents.length,
            domains: domains.length,
            categories: categories.length,
            relations: relations.length,
        };
    }
    finally {
        db.close();
    }
}
