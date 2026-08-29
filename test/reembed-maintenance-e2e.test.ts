import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it } from 'vitest';
import { initDatabase } from '../src/db.js';
import { EMBEDDING_VERSION } from '../src/embeddings.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let sandbox: string | undefined;

function moduleReexport(relativePath: string): string {
  return `export * from ${JSON.stringify(pathToFileURL(path.join(REPO, relativePath)).href)};\n`;
}

function writeRuntimeFixture(): void {
  const scripts = path.join(sandbox!, 'scripts');
  const dist = path.join(sandbox!, 'dist');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(sandbox!, 'package.json'), '{"type":"module"}\n');

  const maintenanceSource = fs.readFileSync(
    path.join(REPO, 'scripts', 'session-start-maintenance.js'),
    'utf8',
  );
  // Keep the production selection and worker code intact, but make detached
  // child execution synchronous inside the fixture so completion is an exact
  // process signal instead of a timing-dependent poll.
  for (const anchor of ["import { spawn } from 'node:child_process';", 'child.unref();']) {
    if (!maintenanceSource.includes(anchor)) throw new Error(`maintenance harness anchor missing: ${anchor}`);
  }
  fs.writeFileSync(
    path.join(scripts, 'session-start-maintenance.js'),
    maintenanceSource
      .replace("import { spawn } from 'node:child_process';", "import { spawnSync as spawn } from 'node:child_process';")
      .replaceAll('child.unref();', "if (child.status !== 0) throw new Error('fixture worker failed');"),
  );
  fs.copyFileSync(path.join(REPO, 'scripts', 'reembed-worker.js'), path.join(scripts, 'reembed-worker.js'));
  fs.writeFileSync(path.join(scripts, 'fact-consolidate-worker.js'), 'process.exit(0);\n');

  fs.writeFileSync(path.join(dist, 'db.js'), moduleReexport('dist/db.js'));
  fs.writeFileSync(path.join(dist, 'paths.js'), moduleReexport('dist/paths.js'));
  fs.writeFileSync(path.join(dist, 'ontology-db.js'), moduleReexport('dist/ontology-db.js'));
  fs.writeFileSync(path.join(dist, 'reembed-selector.js'), moduleReexport('dist/reembed-selector.js'));
  fs.writeFileSync(path.join(dist, 'exchange-reembed.js'), moduleReexport('dist/exchange-reembed.js'));
  fs.writeFileSync(path.join(dist, 'pending-extraction.js'), `
export function getExtractionConfig() { return {}; }
export function pendingExtractionCoreQuery() {
  return { sql: 'SELECT NULL AS session_id WHERE 0', params: [] };
}
`);
  fs.writeFileSync(path.join(dist, 'embeddings.js'), `
export const EMBEDDING_VERSION = ${EMBEDDING_VERSION};
export const EMBEDDING_MODEL = 'deterministic-test-model';
export async function initEmbeddings() {}
export async function generateEmbedding(text) {
  const seed = Math.max(1, String(text).length % 127);
  return Array.from({ length: 384 }, (_, i) => ((seed + i) % 127) / 127);
}
export async function generateExchangeEmbedding(user, assistant) {
  return generateEmbedding(user + assistant);
}
`);
}

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

describe('SessionStart missing primary fact vector self-heal', () => {
  it('repairs a current-version active fact whose vec_facts row is missing', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-reembed-maintenance-'));
    const memexHome = path.join(sandbox, 'home');
    const dbPath = path.join(memexHome, 'conversation-index', 'db.sqlite');
    writeRuntimeFixture();

    const previousHome = process.env.MEMEX_HOME;
    const previousDb = process.env.MEMEX_DB_PATH;
    process.env.MEMEX_HOME = memexHome;
    process.env.MEMEX_DB_PATH = dbPath;
    try {
      const db = initDatabase();
      db.prepare(`
        INSERT INTO facts (
          id, fact, category, scope_type, scope_project, created_at, updated_at,
          is_active, ontology_category_id, embedding_version, needs_consolidation
        ) VALUES (
          'missing-primary', 'current fact without its primary vector', 'fixture',
          'global', NULL, ?, ?, 1, 'fixture-category', ?, 0
        )
      `).run(new Date().toISOString(), new Date().toISOString(), EMBEDDING_VERSION);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM vec_facts_rowids WHERE id = 'missing-primary'",
      ).get()).toEqual({ count: 0 });
      db.close();
    } finally {
      if (previousHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = previousHome;
      if (previousDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = previousDb;
    }

    const maintenance = spawnSync(
      process.execPath,
      [path.join(sandbox, 'scripts', 'session-start-maintenance.js')],
      {
        cwd: sandbox,
        env: { ...process.env, MEMEX_HOME: memexHome, MEMEX_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(maintenance.status).toBe(0);
    expect(maintenance.stderr).toBe('');

    const check = new Database(dbPath, { readonly: true });
    sqliteVec.load(check);
    try {
      expect(check.prepare(`
        SELECT f.embedding_version,
               f.embedding IS NOT NULL AS has_stored_embedding,
               EXISTS(SELECT 1 FROM vec_facts_rowids v WHERE v.id = f.id) AS has_primary_vector
        FROM facts f WHERE f.id = 'missing-primary'
      `).get()).toEqual({
        embedding_version: EMBEDDING_VERSION,
        has_stored_embedding: 1,
        has_primary_vector: 1,
      });
    } finally {
      check.close();
    }
  });
});

describe('SessionStart stale category vector self-heal', () => {
  it('re-embeds a stale-generation category through the maintenance → reembed worker path', () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-reembed-maintenance-'));
    const memexHome = path.join(sandbox, 'home');
    const dbPath = path.join(memexHome, 'conversation-index', 'db.sqlite');
    writeRuntimeFixture();

    const previousHome = process.env.MEMEX_HOME;
    const previousDb = process.env.MEMEX_DB_PATH;
    process.env.MEMEX_HOME = memexHome;
    process.env.MEMEX_DB_PATH = dbPath;
    try {
      const db = initDatabase();
      db.prepare(
        "INSERT INTO ontology_domains (id, name) VALUES ('fixture-domain', 'Fixture Domain')",
      ).run();
      // embedding_version 0 = stale generation (never embedded with the
      // current model) — the category selector must see it as pending.
      db.prepare(`
        INSERT INTO ontology_categories (id, domain_id, name, description, created_at, embedding_version)
        VALUES ('fixture-category', 'fixture-domain', 'Fixture Category', 'fixture description', ?, 0)
      `).run(new Date().toISOString());
      db.close();
    } finally {
      if (previousHome === undefined) delete process.env.MEMEX_HOME;
      else process.env.MEMEX_HOME = previousHome;
      if (previousDb === undefined) delete process.env.MEMEX_DB_PATH;
      else process.env.MEMEX_DB_PATH = previousDb;
    }

    const maintenance = spawnSync(
      process.execPath,
      [path.join(sandbox, 'scripts', 'session-start-maintenance.js')],
      {
        cwd: sandbox,
        env: { ...process.env, MEMEX_HOME: memexHome, MEMEX_DB_PATH: dbPath },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    expect(maintenance.status).toBe(0);
    expect(maintenance.stderr).toBe('');

    const check = new Database(dbPath, { readonly: true });
    sqliteVec.load(check);
    try {
      expect(check.prepare(`
        SELECT c.embedding_version,
               EXISTS(SELECT 1 FROM vec_categories_rowids v WHERE v.id = c.id) AS has_vector
        FROM ontology_categories c WHERE c.id = 'fixture-category'
      `).get()).toEqual({
        embedding_version: EMBEDDING_VERSION,
        has_vector: 1,
      });
    } finally {
      check.close();
    }

    // The reembed worker's own log proves the category branch (not some other
    // repair) performed the upgrade.
    const log = fs.readFileSync(
      path.join(memexHome, 'conversation-index', 'reembed.log'),
      'utf8',
    );
    expect(log).toContain('categories: done (1)');
  });
});
