/**
 * Issue #47 — the taxonomy stops being append-only.
 *
 * Real-root baseline at audit time: 5 domains / 20 categories / 39 relations,
 * 0 case-duplicate domains, 0 duplicate category names inside a domain — a
 * clean corpus with essentially ONE writer, which is not evidence that the
 * guards work. These tests build the states the guards are for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase } from '../src/db.js';
import {
  createCategory,
  createDomain,
  getCategoryByName,
  getDomainByName,
  getTaxonomyEpoch,
  listCategories,
  listDomains,
} from '../src/ontology-db.js';
import { mergeCategories, renameCategory } from '../src/ontology-admin.js';
import { BATCH_CLASSIFY_SYSTEM_PROMPT } from '../src/ontology-classifier.js';

const dirs: string[] = [];
const homes: Array<string | undefined> = [];

function freshDb(): { db: Database.Database; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-taxonomy-'));
  dirs.push(dir);
  homes.push(process.env.MEMEX_HOME);
  process.env.MEMEX_HOME = dir;
  const dbPath = path.join(dir, 'db.sqlite');
  return { db: initDatabase({ dbPath }), dbPath };
}

afterEach(() => {
  const home = homes.pop();
  if (home === undefined) delete process.env.MEMEX_HOME;
  else process.env.MEMEX_HOME = home;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function indexNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertFact(db: Database.Database, id: string, categoryId: string | null) {
  const now = '2026-01-01T00:00:00.000Z';
  db.prepare(`INSERT INTO facts (id, fact, category, scope_type, source_exchange_ids,
      created_at, updated_at, ontology_category_id, semantic_updated_at, lifecycle_updated_at)
    VALUES (?, ?, 'decision', 'global', '[]', ?, ?, ?, ?, ?)`)
    .run(id, `fact ${id}`, now, now, categoryId, now, now);
}

describe('issue #47 — taxonomy uniqueness, merge and rename', () => {
  it('merges pre-existing case-duplicates before creating the unique indexes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-taxonomy-dup-'));
    dirs.push(dir);
    homes.push(process.env.MEMEX_HOME);
    process.env.MEMEX_HOME = dir;
    const dbPath = path.join(dir, 'db.sqlite');

    // A pre-0.6.1 database: two 'Architecture' domains and two 'Auth'
    // categories, each with facts filed under the LATER duplicate.
    const seed = initDatabase({ dbPath });
    seed.exec(`DROP INDEX IF EXISTS idx_ontology_domains_name;
               DROP INDEX IF EXISTS idx_ontology_categories_domain_name;`);
    seed.prepare(`INSERT INTO ontology_domains (id, name, description, created_at)
      VALUES ('dom-old', 'Architecture', 'first', '2026-01-01T00:00:00.000Z')`).run();
    seed.prepare(`INSERT INTO ontology_domains (id, name, description, created_at)
      VALUES ('dom-new', 'architecture', 'duplicate', '2026-02-01T00:00:00.000Z')`).run();
    seed.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at, embedding_version)
      VALUES ('cat-old', 'dom-old', 'Auth', 'first', '2026-01-01T00:00:00.000Z', 0)`).run();
    seed.prepare(`INSERT INTO ontology_categories (id, domain_id, name, description, created_at, embedding_version)
      VALUES ('cat-new', 'dom-new', 'auth', 'duplicate', '2026-02-01T00:00:00.000Z', 0)`).run();
    insertFact(seed, 'f-old', 'cat-old');
    insertFact(seed, 'f-new', 'cat-new');
    const generationsBefore = seed
      .prepare('SELECT id, semantic_generation, lifecycle_generation, fact FROM facts ORDER BY id')
      .all();
    seed.close();

    // Re-opening runs the idempotent migration.
    const db = initDatabase({ dbPath });
    try {
      expect(listDomains(db).map((d) => d.id)).toEqual(['dom-old']);
      expect(listCategories(db).map((c) => c.id)).toEqual(['cat-old']);
      // Facts follow the surviving row; nothing about their meaning moved.
      const rows = db
        .prepare('SELECT id, ontology_category_id FROM facts ORDER BY id')
        .all() as Array<{ id: string; ontology_category_id: string }>;
      expect(rows).toEqual([
        { id: 'f-new', ontology_category_id: 'cat-old' },
        { id: 'f-old', ontology_category_id: 'cat-old' },
      ]);
      // Chronicle-free: no revision rows, no generation bumps.
      expect(
        db.prepare('SELECT id, semantic_generation, lifecycle_generation, fact FROM facts ORDER BY id').all(),
      ).toEqual(generationsBefore);
      expect(
        Number((db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get() as { n: number }).n),
      ).toBe(0);

      const names = indexNames(db);
      expect(names).toContain('idx_ontology_domains_name');
      expect(names).toContain('idx_ontology_categories_domain_name');
      // The constraint is real now.
      expect(() =>
        db.prepare(`INSERT INTO ontology_domains (id, name, created_at)
          VALUES ('dom-third', 'ARCHITECTURE', '2026-03-01T00:00:00.000Z')`).run(),
      ).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }

    // Idempotent: a second open changes nothing.
    const again = initDatabase({ dbPath });
    try {
      expect(listDomains(again).length).toBe(1);
      expect(listCategories(again).length).toBe(1);
    } finally {
      again.close();
    }
  });

  it('resolve-or-create adopts the winner instead of forking the taxonomy', () => {
    const { db } = freshDb();
    try {
      const first = createDomain(db, 'Architecture', 'first');
      const second = createDomain(db, 'architecture', 'duplicate casing');
      expect(second.id).toBe(first.id);
      expect(listDomains(db).filter((d) => d.name.toLowerCase() === 'architecture').length).toBe(1);

      const catA = createCategory(db, first.id, 'Auth', 'first');
      const catB = createCategory(db, first.id, 'AUTH', 'duplicate casing');
      expect(catB.id).toBe(catA.id);
      expect(listCategories(db, first.id).length).toBe(1);

      // Same name under a DIFFERENT domain stays a distinct category.
      const other = createDomain(db, 'Backend');
      expect(createCategory(db, other.id, 'Auth').id).not.toBe(catA.id);
      expect(getCategoryByName(db, 'auth', other.id)?.domain_id).toBe(other.id);
      expect(getDomainByName(db, 'ARCHITECTURE')?.id).toBe(first.id);
    } finally {
      db.close();
    }
  });

  it('merges two categories, re-pointing facts and dropping the source', () => {
    const { db } = freshDb();
    try {
      const domain = createDomain(db, 'Security');
      const from = createCategory(db, domain.id, 'AuthN');
      const to = createCategory(db, domain.id, 'Authentication');
      insertFact(db, 'f1', from.id);
      insertFact(db, 'f2', from.id);
      insertFact(db, 'f3', to.id);

      const plan = mergeCategories(db, {
        fromCategoryId: from.id,
        toCategoryId: to.id,
        dryRun: true,
      });
      expect(plan.dryRun).toBe(true);
      expect(plan.factsMoved).toBe(2);
      expect(listCategories(db, domain.id).length).toBe(2); // dry run wrote nothing

      const applied = mergeCategories(db, { fromCategoryId: from.id, toCategoryId: to.id });
      expect(applied.factsMoved).toBe(2);
      expect(listCategories(db, domain.id).map((c) => c.id)).toEqual([to.id]);
      expect(
        Number(
          (db.prepare('SELECT COUNT(*) AS n FROM facts WHERE ontology_category_id = ?').get(to.id) as {
            n: number;
          }).n,
        ),
      ).toBe(3);
      // Nothing else is invalidated: no attempt reset, no taxonomy epoch bump.
      expect(getTaxonomyEpoch(db)).toBe(1);
      expect(
        Number((db.prepare('SELECT COUNT(*) AS n FROM fact_revisions').get() as { n: number }).n),
      ).toBe(0);
      // One metadata-only audit line, no fact text.
      const audit = fs.readFileSync(path.join(process.env.MEMEX_HOME!, 'logs', 'ui-audit.jsonl'), 'utf8');
      expect(audit).toContain('"action":"ontology-merge"');
      expect(audit).not.toContain('fact f1');
    } finally {
      db.close();
    }
  });

  it('renames a category, keeps its facts and invalidates only its vector', () => {
    const { db } = freshDb();
    try {
      const domain = createDomain(db, 'Security');
      const category = createCategory(db, domain.id, 'AuthN');
      db.prepare('UPDATE ontology_categories SET embedding_version = 3 WHERE id = ?').run(category.id);
      insertFact(db, 'f1', category.id);

      const result = renameCategory(db, { categoryId: category.id, name: 'Authentication' });
      expect(result.previousName).toBe('AuthN');
      expect(result.name).toBe('Authentication');
      const row = db.prepare('SELECT name, embedding_version FROM ontology_categories WHERE id = ?')
        .get(category.id) as { name: string; embedding_version: number };
      expect(row.name).toBe('Authentication');
      expect(row.embedding_version).toBe(0); // re-embed worker picks it up
      expect(
        (db.prepare('SELECT ontology_category_id FROM facts WHERE id = ?').get('f1') as {
          ontology_category_id: string;
        }).ontology_category_id,
      ).toBe(category.id);

      // A rename onto an existing sibling name is refused with the merge hint.
      const other = createCategory(db, domain.id, 'Sessions');
      expect(() => renameCategory(db, { categoryId: other.id, name: 'authentication' })).toThrow(
        /already exists in this domain/,
      );
    } finally {
      db.close();
    }
  });

  it('no longer spends output tokens on is_new_domain / is_new_category', () => {
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).not.toContain('is_new_domain');
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).not.toContain('is_new_category');
    // Descriptions survive: they are the only thing used when a row is created.
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).toContain('domain_description');
    expect(BATCH_CLASSIFY_SYSTEM_PROMPT).toContain('category_description');
  });
});
