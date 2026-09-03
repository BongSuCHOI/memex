import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase } from '../src/db.js';
import { insertFact, getActiveFacts } from '../src/fact-db.js';
import { buildConsolidationPrompt, applyConsolidationResult } from '../src/consolidator.js';
import { deactivateFactTransactional, restoreFact, StaleFactMutationError } from '../src/fact-management.js';
import { createRelation } from '../src/ontology-db.js';
import { EMBEDDING_VERSION } from '../src/embeddings.js';
import { suppressConsole } from './test-utils.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const restoreConsole = suppressConsole();

vi.mock('../src/embeddings.js', () => ({
  EMBEDDING_VERSION: 73,
  generateEmbedding: vi.fn(async () => new Array(384).fill(0.75)),
}));

describe('Consolidator', () => {
  describe('buildConsolidationPrompt', () => {
    it('should format two facts for comparison', () => {
      const prompt = buildConsolidationPrompt('Uses Riverpod', 'Chose Riverpod over Bloc');
      expect(prompt).toContain('Uses Riverpod');
      expect(prompt).toContain('Chose Riverpod over Bloc');
      expect(prompt).toContain('Existing fact');
      expect(prompt).toContain('New fact');
    });
  });

  describe('applyConsolidationResult', () => {
    let db: Database.Database;
    const testDir = path.join(os.tmpdir(), 'consolidator-test-' + Date.now());
    const dbPath = path.join(testDir, 'test.db');

    beforeEach(() => {
      fs.mkdirSync(testDir, { recursive: true });
      process.env.TEST_DB_PATH = dbPath;
      db = initDatabase();
    });

    afterEach(() => {
      db.close();
      delete process.env.TEST_DB_PATH;
      fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('should merge DUPLICATE facts', async () => {
      const id1 = insertFact(db, { fact: 'Named export usage', category: 'preference', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Only use named exports', category: 'preference', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: null });
      const insertExchange = db.prepare(`
        INSERT INTO exchanges
          (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, '/proj', ?, 'question', 'proposal', ?, 1, 2)
      `);
      insertExchange.run('ctx-existing', new Date().toISOString(), '/tmp/ctx-existing.jsonl');
      insertExchange.run('ctx-new', new Date().toISOString(), '/tmp/ctx-new.jsonl');
      db.prepare(`
        INSERT INTO fact_context_dependencies
          (fact_id, exchange_id, dependency_kind, created_at)
        VALUES (?, ?, 'assistant_context', ?)
      `).run(id1, 'ctx-existing', new Date().toISOString());
      db.prepare(`
        INSERT INTO fact_context_dependencies
          (fact_id, exchange_id, dependency_kind, created_at)
        VALUES (?, ?, 'recall_influenced_assistant', ?)
      `).run(id2, 'ctx-new', new Date().toISOString());

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'DUPLICATE', merged_fact: '', reason: 'same content',
      });

      const active = getActiveFacts(db);
      expect(active).toHaveLength(1);
      expect(active[0].consolidated_count).toBe(2);
      expect(db.prepare(`
        SELECT exchange_id, dependency_kind
        FROM fact_context_dependencies WHERE fact_id = ?
        ORDER BY exchange_id
      `).all(id1)).toEqual([
        { exchange_id: 'ctx-existing', dependency_kind: 'assistant_context' },
        { exchange_id: 'ctx-new', dependency_kind: 'recall_influenced_assistant' },
      ]);
    });

    // 재감사 P1-4(v4): consolidation은 ACTIVE 참가자끼리 판정한다 — LLM 왕복
    // 동안 참가자의 lifecycle이 움직였으면(deactivate→restore) semantic
    // generation은 그대로여도 verdict 전체가 stale이다.
    it('discards a DUPLICATE verdict whose participant lifecycle moved during the comparison (P1-4 v4)', async () => {
      const id1 = insertFact(db, { fact: 'Named export usage', category: 'preference', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Only use named exports', category: 'preference', scope_type: 'global', scope_project: null, source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      const existing = facts.find(f => f.id === id1)!;
      const dup = facts.find(f => f.id === id2)!;

      // LLM-await churn: semantic_generation is untouched, lifecycle advances.
      deactivateFactTransactional(db, id2);
      await restoreFact(db, id2);

      await expect(applyConsolidationResult(db, existing, dup, {
        relation: 'DUPLICATE', merged_fact: '', reason: 'same content',
      })).rejects.toThrow(StaleFactMutationError);
      // The stale verdict deactivated nothing.
      expect(getActiveFacts(db)).toHaveLength(2);
    });

    it('carries both interpretive context lineages into an EVOLUTION survivor', async () => {
      const id1 = insertFact(db, { fact: 'Uses API v1', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Migrating to API v2', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const insertExchange = db.prepare(`
        INSERT INTO exchanges
          (id, project, timestamp, user_message, assistant_message, archive_path, line_start, line_end)
        VALUES (?, '/proj', ?, 'question', 'proposal', ?, 1, 2)
      `);
      insertExchange.run('ctx-v1', new Date().toISOString(), '/tmp/ctx-v1.jsonl');
      insertExchange.run('ctx-v2', new Date().toISOString(), '/tmp/ctx-v2.jsonl');
      const insertDependency = db.prepare(`
        INSERT INTO fact_context_dependencies
          (fact_id, exchange_id, dependency_kind, created_at)
        VALUES (?, ?, 'assistant_context', ?)
      `);
      insertDependency.run(id1, 'ctx-v1', new Date().toISOString());
      insertDependency.run(id2, 'ctx-v2', new Date().toISOString());

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'EVOLUTION', merged_fact: 'Uses API v2', reason: 'version upgrade',
      });

      expect(db.prepare(`
        SELECT exchange_id FROM fact_context_dependencies
        WHERE fact_id = ? ORDER BY exchange_id
      `).all(id1)).toEqual([{ exchange_id: 'ctx-v1' }, { exchange_id: 'ctx-v2' }]);
    });

    it('discards a CONTRADICTION verdict whose existing fact lifecycle moved during the comparison (P1-4 v4)', async () => {
      const id1 = insertFact(db, { fact: 'Uses Zustand', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Switched to React Context', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      const existing = facts.find(f => f.id === id1)!;
      const dup = facts.find(f => f.id === id2)!;

      deactivateFactTransactional(db, id1);
      await restoreFact(db, id1);

      await expect(applyConsolidationResult(db, existing, dup, {
        relation: 'CONTRADICTION', merged_fact: 'Changed state management to React Context', reason: 'tech stack change',
      })).rejects.toThrow(StaleFactMutationError);
      // Neither the meaning rewrite nor the participant deactivation landed.
      const active = getActiveFacts(db);
      expect(active).toHaveLength(2);
      expect(active.find(f => f.id === id1)!.fact).toBe('Uses Zustand');
    });

    it('discards a CONTRADICTION verdict whose new-fact participant lifecycle moved during the comparison (P1-4 v4)', async () => {
      const id1 = insertFact(db, { fact: 'Uses Zustand', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Switched to React Context', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      const existing = facts.find(f => f.id === id1)!;
      const dup = facts.find(f => f.id === id2)!;

      deactivateFactTransactional(db, id2);
      await restoreFact(db, id2);

      await expect(applyConsolidationResult(db, existing, dup, {
        relation: 'CONTRADICTION', merged_fact: 'Changed state management to React Context', reason: 'tech stack change',
      })).rejects.toThrow(StaleFactMutationError);
      expect(getActiveFacts(db)).toHaveLength(2);
    });

    it('should handle CONTRADICTION - current identity keeps predecessor lineage', async () => {
      const id1 = insertFact(db, { fact: 'Uses Zustand', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'Switched to React Context', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'CONTRADICTION', merged_fact: 'Changed state management to React Context', reason: 'tech stack change',
      });

      const active = getActiveFacts(db);
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id1);
      expect(active[0].fact).toBe('Changed state management to React Context');
      expect(db.prepare('SELECT previous_fact, new_fact FROM fact_revisions WHERE fact_id = ?').get(id1)).toEqual({
        previous_fact: 'Uses Zustand',
        new_fact: 'Changed state management to React Context',
      });
    });

    it('should handle EVOLUTION as one semantic generation', async () => {
      const oldEmbedding = new Array(384).fill(0.1);
      const id1 = insertFact(db, { fact: 'Uses API v1', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: oldEmbedding, fact_kr: 'API v1 사용', embedding_kr: oldEmbedding });
      const id2 = insertFact(db, { fact: 'Migrating to API v2', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: new Array(384).fill(0.2) });
      db.prepare("UPDATE facts SET ontology_category_id = 'old-category', ontology_attempts = 2 WHERE id = ?").run(id1);
      createRelation(db, id1, 'SUPPORTS', id2, 'old meaning relation');
      const oldVector = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get(id1) as { embedding: Buffer };

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'EVOLUTION', merged_fact: 'Now using API v2', reason: 'version upgrade',
      });

      const active = getActiveFacts(db);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toBe('Now using API v2');
      expect(active[0].consolidated_count).toBe(2);
      const row = db.prepare('SELECT embedding, embedding_version, fact_kr, ontology_category_id, ontology_attempts FROM facts WHERE id = ?').get(id1) as Record<string, unknown>;
      expect(row.embedding_version).toBe(EMBEDDING_VERSION);
      expect(row.fact_kr).toBeNull();
      expect(row.ontology_category_id).toBeNull();
      expect(row.ontology_attempts).toBe(0);
      const currentVector = db.prepare('SELECT embedding FROM vec_facts WHERE id = ?').get(id1) as { embedding: Buffer };
      expect(Buffer.from(currentVector.embedding).equals(Buffer.from(oldVector.embedding))).toBe(false);
      expect(db.prepare('SELECT COUNT(*) AS c FROM vec_facts_kr WHERE id = ?').get(id1)).toEqual({ c: 0 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM ontology_relations WHERE source_fact_id = ? OR target_fact_id = ?').get(id1, id1)).toEqual({ c: 0 });
    });

    it('rolls back the whole semantic generation when derived-state invalidation fails', async () => {
      const id1 = insertFact(db, { fact: 'Uses API v1', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: new Array(384).fill(0.1) });
      const id2 = insertFact(db, { fact: 'Migrating to API v2', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: new Array(384).fill(0.2) });
      createRelation(db, id1, 'SUPPORTS', id2, 'must roll back');
      db.exec(`CREATE TRIGGER block_relation_delete BEFORE DELETE ON ontology_relations BEGIN SELECT RAISE(ABORT, 'blocked relation delete'); END`);
      const before = db.prepare('SELECT fact, embedding, is_active FROM facts WHERE id IN (?, ?) ORDER BY id').all(id1, id2);
      const facts = getActiveFacts(db);

      await expect(applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'EVOLUTION', merged_fact: 'Now using API v2', reason: 'version upgrade',
      })).rejects.toThrow(/blocked relation delete/);

      expect(db.prepare('SELECT fact, embedding, is_active FROM facts WHERE id IN (?, ?) ORDER BY id').all(id1, id2)).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS c FROM fact_revisions').get()).toEqual({ c: 0 });
    });

    it('rolls back the whole DUPLICATE merge when deactivation fails mid-transaction', async () => {
      const id1 = insertFact(db, { fact: 'Same decision A', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: new Array(384).fill(0.1) });
      const id2 = insertFact(db, { fact: 'Same decision B', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: new Array(384).fill(0.2) });
      db.exec(`CREATE TRIGGER block_dup_deactivate BEFORE UPDATE ON facts WHEN NEW.is_active = 0 BEGIN SELECT RAISE(ABORT, 'blocked dup deactivate'); END`);
      const before = db.prepare('SELECT fact, is_active FROM facts WHERE id IN (?, ?) ORDER BY id').all(id1, id2);
      const facts = getActiveFacts(db);

      await expect(applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'DUPLICATE', merged_fact: '', reason: 'same content',
      })).rejects.toThrow(/blocked dup deactivate/);

      // The survivor's count/provenance update and the duplicate's
      // deactivation are one transaction — a mid-branch failure must leave
      // both facts exactly as before (no merged count on an active duplicate).
      expect(db.prepare('SELECT fact, is_active FROM facts WHERE id IN (?, ?) ORDER BY id').all(id1, id2)).toEqual(before);
      expect(db.prepare('SELECT COUNT(*) AS c FROM vec_facts').get()).toEqual({ c: 2 });
      expect(db.prepare('SELECT consolidated_count FROM facts WHERE id = ?').get(id1)).toEqual({ consolidated_count: 1 });
    });

    it('should use newFact.fact when merged_fact is empty on CONTRADICTION', async () => {
      const id1 = insertFact(db, { fact: 'Old approach', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'New approach', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'CONTRADICTION', merged_fact: '', reason: 'LLM returned empty',
      });

      const active = getActiveFacts(db);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toBe('New approach'); // falls back to newFact
    });

    it('should use newFact.fact when merged_fact is whitespace on EVOLUTION', async () => {
      const id1 = insertFact(db, { fact: 'v1 config', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      const id2 = insertFact(db, { fact: 'v2 config', category: 'knowledge', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts.find(f => f.id === id1)!, facts.find(f => f.id === id2)!, {
        relation: 'EVOLUTION', merged_fact: '   ', reason: 'whitespace only',
      });

      const active = getActiveFacts(db);
      expect(active).toHaveLength(1);
      expect(active[0].fact).toBe('v2 config'); // falls back to newFact
    });

    it('should keep both for INDEPENDENT', async () => {
      insertFact(db, { fact: 'Uses React', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });
      insertFact(db, { fact: 'Uses PostgreSQL', category: 'decision', scope_type: 'project', scope_project: '/proj', source_exchange_ids: [], embedding: null });

      const facts = getActiveFacts(db);
      await applyConsolidationResult(db, facts[0], facts[1], {
        relation: 'INDEPENDENT', merged_fact: '', reason: 'unrelated',
      });

      expect(getActiveFacts(db)).toHaveLength(2);
    });
  });
});
