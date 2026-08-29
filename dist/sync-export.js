import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'node:crypto';
import { initDatabase } from './db.js';
import { getMemexHome } from './paths.js';
const SYNC_DIR_NAME = 'sync';
export function getSyncDir() {
    const dir = path.join(getMemexHome(), 'conversation-index', SYNC_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
/**
 * Export current and historical fact state, durable recall receipts, ontology
 * domains/categories, and relations to JSONL files.
 * These JSONL files are durable cross-device state; the large local SQLite
 * index is not copied. Conversation indexes rebuild from rollouts/archives,
 * while facts, revisions, tombstones, and recall receipts reconcile from here.
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
        const writeJsonl = (name, rows) => {
            const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
            // Device-owned v2 snapshot is authoritative for multi-writer merge.
            fs.writeFileSync(path.join(deviceDir, name), body);
            // Root mirror preserves v1 readers during the protocol transition.
            fs.writeFileSync(path.join(syncDir, name), body);
        };
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
        writeJsonl('facts.jsonl', facts);
        const revisions = db.prepare(`
      SELECT id, fact_id, previous_fact, new_fact, reason, source_exchange_id, created_at
      FROM fact_revisions ORDER BY id
    `).all();
        writeJsonl('fact-revisions.jsonl', revisions);
        const tombstones = db.prepare(`
      SELECT fact_id, deleted_at, reason FROM fact_tombstones ORDER BY fact_id
    `).all();
        writeJsonl('fact-tombstones.jsonl', tombstones);
        // recall_events cannot be reconstructed from source rollouts. Export the
        // durable receipt so recalled context stays non-learnable after migration.
        const recallEvents = db.prepare(`
      SELECT id, session_id, project, prompt_hash, fact_ids, source_type,
             learnable, status, created_at, emitted_at
      FROM recall_events ORDER BY id
    `).all();
        writeJsonl('recall-events.jsonl', recallEvents);
        // Export domains
        const domains = db.prepare('SELECT * FROM ontology_domains').all();
        writeJsonl('ontology-domains.jsonl', domains);
        // Export categories
        const categories = db.prepare('SELECT * FROM ontology_categories').all();
        writeJsonl('ontology-categories.jsonl', categories);
        // Export relations
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
        writeJsonl('ontology-relations.jsonl', relations);
        // Export metadata
        const meta = {
            protocol_version: 2,
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
        const metaBody = JSON.stringify(meta, null, 2);
        fs.writeFileSync(path.join(deviceDir, 'meta.json'), metaBody);
        fs.writeFileSync(path.join(syncDir, 'meta.json'), metaBody);
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
