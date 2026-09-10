import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { suppressConsole } from './test-utils.js';

/**
 * Issue #35 / #48 — cross-device sync had no switch, no shared folder and no
 * export trigger.
 *
 * Observed on v0.5.2: `exportForSync()` had exactly one caller
 * (`scripts/sync-export-hook.js`), and that script appeared in no hook, no
 * `package.json` bin and no CLI command, while `memex doctor` reported
 * `sync-export: ok` with "no sync export recorded yet (first SessionEnd will
 * write one)". `ls ~/.config/memex/conversation-index/sync*` matched nothing.
 *
 * This suite drives the whole loop through src/sync-control.ts — the module the
 * CLI, the hooks, doctor and the Web UI sync tab all share.
 */

vi.mock('../src/embeddings.js', () => ({
  generateEmbedding: vi.fn().mockResolvedValue(new Array(384).fill(0.05)),
  initEmbeddings: vi.fn().mockResolvedValue(undefined),
  EMBEDDING_VERSION: 2,
  EMBEDDING_MODEL: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
}));

const AT = '2026-08-01T00:00:00.000Z';
const PROJECT_ID = 'proj-shared-0001';
const PORTABLE_KEY = 'memex:shared';
const originalEnv = { ...process.env };

describe('cross-device sync control (#35/#48)', () => {
  let temp: string;
  let shared: string;
  let rootA: string;
  let rootB: string;
  let restoreConsole: () => void;

  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-sync-control-'));
    shared = path.join(temp, 'shared-folder');
    rootA = path.join(temp, 'device-a');
    rootB = path.join(temp, 'device-b');
    for (const dir of [shared, rootA, rootB]) fs.mkdirSync(dir, { recursive: true });
    delete process.env.TEST_DB_PATH;
    delete process.env.MEMEX_DB_PATH;
    restoreConsole = suppressConsole();
  });

  afterEach(() => {
    restoreConsole();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(temp, { recursive: true, force: true });
  });

  function on(root: string): void {
    process.env.MEMEX_HOME = root;
    process.env.MEMEX_SYNC_DIR = shared;
  }

  async function seed(root: string, fact: { id: string; text: string; subject: string }) {
    on(root);
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      db.prepare(`
        INSERT OR IGNORE INTO projects(project_id, portable_project_key, display_name, memory_revision, created_at, updated_at)
        VALUES (?, ?, 'shared', 0, ?, ?)
      `).run(PROJECT_ID, PORTABLE_KEY, AT, AT);
      db.prepare(`
        INSERT INTO facts
          (id, fact, category, scope_type, scope_project, source_exchange_ids, created_at, updated_at,
           consolidated_count, is_active, embedding_version, needs_consolidation,
           semantic_generation, semantic_updated_at, lifecycle_generation, lifecycle_updated_at,
           project_id, subject_key, promotion_state, tier_reason, workspace_id, workstream_id)
        VALUES (?, ?, 'knowledge', 'project', NULL, '[]', ?, ?, 1, 1, 2, 0, 1, ?, 1, ?, ?, ?, 'project-current', 'merged', NULL, NULL)
      `).run(fact.id, fact.text, AT, AT, AT, AT, PROJECT_ID, fact.subject);
    } finally {
      db.close();
    }
  }

  async function editFact(root: string, id: string, text: string, at: string) {
    on(root);
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      db.prepare(`
        UPDATE facts
        SET fact = ?, updated_at = ?, semantic_updated_at = ?, semantic_generation = semantic_generation + 1
        WHERE id = ?
      `).run(text, at, at, id);
    } finally {
      db.close();
    }
  }

  async function readFact(root: string, id: string): Promise<string | undefined> {
    on(root);
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      return (db.prepare('SELECT fact FROM facts WHERE id = ?').get(id) as { fact: string } | undefined)?.fact;
    } finally {
      db.close();
    }
  }

  /** What one `memex sync` leaves on a receiving machine: an index, no facts. */
  async function ensureIndex(root: string): Promise<void> {
    on(root);
    const { initDatabase } = await import('../src/db.js');
    initDatabase().close();
  }

  /** Hard-delete a fact the way the tombstone-writing paths do: row gone, tombstone in. */
  async function hardDelete(root: string, id: string, at: string): Promise<void> {
    on(root);
    const { initDatabase } = await import('../src/db.js');
    const db = initDatabase();
    try {
      db.prepare('DELETE FROM facts WHERE id = ?').run(id);
      db.prepare('INSERT INTO fact_tombstones (fact_id, deleted_at, reason) VALUES (?, ?, ?)')
        .run(id, at, 'hard_delete');
    } finally {
      db.close();
    }
  }

  /** Whole-schema digest — what a migration would change and a read never does. */
  async function schemaFingerprint(dbPath: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    const { openReadDb } = await import('../src/db.js');
    const db = openReadDb(dbPath);
    try {
      const rows = db
        .prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name')
        .all();
      return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
    } finally {
      db.close();
    }
  }

  it('is OFF by default and every automatic path is a no-op', async () => {
    on(rootA);
    const control = await import('../src/sync-control.js');
    const status = control.getSyncStatus();
    expect(status.enabled).toBe(false);
    expect(status.configPath).toBe(path.join(rootA, 'sync', 'config.json'));
    // The shared folder is still resolved and reported so the user can check it
    // before turning sync on.
    expect(status.dir).toBe(shared);
    expect(status.dirSource).toBe('env');

    await seed(rootA, { id: 'fact-off', text: 'nothing should leave', subject: 'shared.off.case' });
    expect(control.runSyncExport()).toMatchObject({ skipped: 'disabled', result: null });
    await expect(control.runSyncImport()).resolves.toMatchObject({ skipped: 'disabled', result: null });
    // Nothing was published: no device directory, no status file.
    expect(fs.existsSync(path.join(shared, 'devices'))).toBe(false);
    expect(control.getSyncStatus().lastExport).toBeNull();
  });

  it('MEMEX_SYNC_DIR wins over a configured folder and the local default', async () => {
    on(rootA);
    const { getSyncStatus, setSyncEnabled } = await import('../src/sync-control.js');
    const configured = path.join(temp, 'configured-folder');
    setSyncEnabled({ enabled: true, dir: configured });
    expect(getSyncStatus().dir).toBe(shared); // env still wins
    expect(getSyncStatus().dirSource).toBe('env');

    delete process.env.MEMEX_SYNC_DIR;
    expect(getSyncStatus().dir).toBe(configured);
    expect(getSyncStatus().dirSource).toBe('configured');

    setSyncEnabled({ enabled: true, dir: null });
    expect(getSyncStatus().dir).toBe(path.join(rootA, 'conversation-index', 'sync'));
    expect(getSyncStatus().dirSource).toBe('default');
  });

  it('A exports, B imports, B edits and exports, A converges — and a corrupt generation is rejected', async () => {
    const control = await import('../src/sync-control.js');

    // --- A: enable, seed, export ---
    await seed(rootA, { id: 'fact-shared', text: 'deploys run from main', subject: 'shared.deploy.rule' });
    on(rootA);
    const enabled = control.setSyncEnabled({ enabled: true });
    expect(enabled.enabled).toBe(true);
    expect(enabled.dir).toBe(shared);

    const firstExport = control.runSyncExport();
    expect(firstExport.skipped).toBeNull();
    expect(firstExport.result?.facts).toBe(1);
    const afterExport = control.getSyncStatus();
    expect(afterExport.lastExport?.ok).toBe(true);
    expect(afterExport.peers).toHaveLength(1);
    expect(afterExport.peers[0].isSelf).toBe(true);
    expect(afterExport.peers[0].counts?.facts).toBe(1);

    // An unchanged machine must not publish an empty generation (#48 B).
    expect(control.runSyncExport()).toMatchObject({ skipped: 'unchanged' });
    // …but an explicit request still does.
    expect(control.runSyncExport({ force: true }).skipped).toBeNull();

    // --- B: enable, import (+N) ---
    on(rootB);
    control.setSyncEnabled({ enabled: true });
    const firstImport = await control.runSyncImport();
    expect(firstImport.skipped).toBeNull();
    expect(firstImport.result?.newFacts).toBe(1);
    expect(firstImport.result?.malformedRows).toEqual([]);
    expect(await readFact(rootB, 'fact-shared')).toBe('deploys run from main');

    // --- B: edit and export ---
    await editFact(rootB, 'fact-shared', 'deploys run from release branches', '2026-08-05T00:00:00.000Z');
    on(rootB);
    const bExport = control.runSyncExport();
    expect(bExport.skipped).toBeNull();
    on(rootB);
    expect(control.getSyncStatus().peers).toHaveLength(2);

    // --- A: import (~N) ---
    on(rootA);
    const secondImport = await control.runSyncImport();
    expect(secondImport.result?.updatedFacts).toBeGreaterThanOrEqual(1);
    expect(secondImport.result?.malformedRows).toEqual([]);
    expect(await readFact(rootA, 'fact-shared')).toBe('deploys run from release branches');

    // --- a corrupted generation is rejected as a whole ---
    on(rootB);
    const bDeviceId = control.getSyncStatus().deviceId!;
    const bDeviceDir = path.join(shared, 'devices', bDeviceId);
    const bGeneration = (JSON.parse(fs.readFileSync(path.join(bDeviceDir, 'CURRENT'), 'utf-8')) as {
      generation: string;
    }).generation;
    const metaPath = path.join(bDeviceDir, 'generations', bGeneration, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    (meta.files as Record<string, { sha256: string }>)['facts.jsonl'].sha256 = 'f'.repeat(64);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    on(rootA);
    const rejected = await control.runSyncImport();
    expect(rejected.result?.malformedRows.length).toBeGreaterThan(0);
    expect(rejected.result?.malformedRows.some((issue) => issue.error.includes('sha256 mismatch'))).toBe(true);

    // --- disabling stops every automatic path again ---
    on(rootA);
    control.setSyncEnabled({ enabled: false });
    expect(control.runSyncExport()).toMatchObject({ skipped: 'disabled' });
    await expect(control.runSyncImport()).resolves.toMatchObject({ skipped: 'disabled' });
    // The switch is local state in the data root, not something that travels.
    expect(fs.existsSync(path.join(rootA, 'sync', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(shared, 'config.json'))).toBe(false);
  });

  it('doctor reports skipped(off), then warn, then ok as the switch and the export move', async () => {
    const codexHome = path.join(temp, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
    process.env.CODEX_HOME = codexHome;
    on(rootA);
    const { doctor } = await import('../src/lifecycle.js');
    const check = async () => (await doctor()).json.find((entry) => (entry as { name: string }).name === 'sync-export') as
      | { name: string; status: string; detail: string }
      | undefined;

    expect((await check())?.status).toBe('ok');
    expect((await check())?.detail).toContain('skipped(off)');

    const control = await import('../src/sync-control.js');
    control.setSyncEnabled({ enabled: true });
    expect((await check())?.status).toBe('warn');
    expect((await check())?.detail).toContain('nothing has been exported yet');

    await seed(rootA, { id: 'fact-doctor', text: 'doctor sees an export', subject: 'shared.doctor.case' });
    on(rootA);
    expect(control.runSyncExport().skipped).toBeNull();
    expect((await check())?.status).toBe('ok');
    expect((await check())?.detail).toContain('last export ok');
  });

  /**
   * Issue #68 — observed procedure: export to folder A, `memex sync enable
   * --dir B` (empty), then `memex sync export` →
   *   "sync export skipped: no durable change since the last export"
   * and B never received a generation until the DB itself changed. The status
   * file is LOCAL, so folder A's fingerprint was read as a verdict about B.
   */
  it('a new shared folder gets its own first export instead of inheriting the old fingerprint', async () => {
    await seed(rootA, { id: 'fact-dest', text: 'must reach both folders', subject: 'shared.dest.case' });
    const control = await import('../src/sync-control.js');
    const folderA = path.join(temp, 'folder-a');
    const folderB = path.join(temp, 'folder-b');
    process.env.MEMEX_HOME = rootA;
    delete process.env.MEMEX_SYNC_DIR; // env would pin ONE folder for both halves

    control.setSyncEnabled({ enabled: true, dir: folderA });
    expect(control.runSyncExport().skipped).toBeNull();
    // The empty-generation guard still holds for the SAME folder (#48 B).
    expect(control.runSyncExport()).toMatchObject({ skipped: 'unchanged' });
    const deviceId = control.getSyncStatus().deviceId!;
    expect(fs.existsSync(path.join(folderA, 'devices', deviceId, 'CURRENT'))).toBe(true);

    control.setSyncEnabled({ enabled: true, dir: folderB });
    // Switching folders drops the fingerprint recorded for the old destination.
    expect(control.getSyncStatus().lastExport?.stateFingerprint).toBeUndefined();
    expect(control.runSyncExport().skipped).toBeNull();
    expect(fs.existsSync(path.join(folderB, 'devices', deviceId, 'CURRENT'))).toBe(true);
    // And the new folder gets its own skip baseline.
    expect(control.runSyncExport()).toMatchObject({ skipped: 'unchanged' });
  });

  /**
   * Issue #67 — observed: {"flipped":true,"fingerprintChanged":false,
   * "row":{"status":"emitted",...}}. `status`/`emitted_at` are exported
   * columns, but the gate read only COUNT(*) and MAX(created_at), so the
   * convergence never left the device.
   */
  it('a recall receipt flipping to emitted moves the fingerprint and publishes a generation', async () => {
    await seed(rootA, { id: 'fact-receipt', text: 'receipts travel too', subject: 'shared.receipt.case' });
    const control = await import('../src/sync-control.js');
    control.setSyncEnabled({ enabled: true });
    expect(control.runSyncExport().skipped).toBeNull();

    const { initDatabase, recordRecallEvent, markRecallEventEmitted } = await import('../src/db.js');
    const { durableStateFingerprint } = await import('../src/sync-export.js');
    let receiptId: string | null = null;
    let before = '';
    let after = '';
    let db = initDatabase();
    try {
      receiptId = recordRecallEvent(db, {
        sessionId: 'sess-receipt', project: '/shared', prompt: 'hello',
        factIds: [], context: 'some injected context',
      });
      expect(receiptId).not.toBeNull();
    } finally {
      db.close();
    }
    // Publish the `prepared` receipt so only the flip is left to detect.
    expect(control.runSyncExport().skipped).toBeNull();
    expect(control.runSyncExport()).toMatchObject({ skipped: 'unchanged' });

    db = initDatabase();
    try {
      before = durableStateFingerprint(db);
      expect(markRecallEventEmitted(db, { sessionId: 'sess-receipt', prompt: 'hello', id: receiptId! })).toBe(true);
      after = durableStateFingerprint(db);
    } finally {
      db.close();
    }
    expect(after).not.toBe(before);
    // Before the fix this reported `unchanged` and the flip never propagated.
    expect(control.runSyncExport().skipped).toBeNull();
  });

  /**
   * Issue #48 (0.6.3) — manual file transfer, device aliases and conflict
   * history. The shared folder needs a folder both machines can see; this half
   * is the path for a user who has none, and it must be the SAME protocol-v5
   * generation so it gets the same validation.
   */
  describe('manual generation archives (#48)', () => {
    /** Data root with NO shared folder at all — the case a zip exists for. */
    function standalone(root: string): void {
      process.env.MEMEX_HOME = root;
      delete process.env.MEMEX_SYNC_DIR;
    }

    it('carries one generation to the other device as a zip, with sync switched off', async () => {
      const control = await import('../src/sync-control.js');
      const { readZip } = await import('../src/zip.js');

      await seed(rootA, { id: 'fact-by-hand', text: 'deploys run from main', subject: 'shared.byhand.rule' });
      standalone(rootA);
      // Sync is OFF: a manual archive is exactly the no-shared-folder case.
      expect(control.getSyncStatus().enabled).toBe(false);
      const archive = control.exportGenerationArchive();
      expect(archive.path.startsWith(path.join(rootA, 'sync', 'exports'))).toBe(true);
      expect(fs.existsSync(archive.path)).toBe(true);
      expect(archive.counts.facts).toBe(1);
      expect(archive.deviceAlias).toBeNull();
      // A device id exists only after an export, so the alias is set here and
      // travels in the NEXT generation's manifest.
      control.setDeviceAlias(archive.deviceId, '집 맥미니');
      const reexported = control.exportGenerationArchive();
      const entries = readZip(fs.readFileSync(reexported.path));
      expect([...entries.keys()].sort()).toEqual([
        'fact-revisions.jsonl', 'fact-tombstones.jsonl', 'facts.jsonl', 'meta.json', 'recall-events.jsonl',
      ]);
      expect(JSON.parse(entries.get('meta.json')!.toString('utf8'))).toMatchObject({
        protocol_version: 5,
        device_alias: '집 맥미니',
      });
      // Nothing reached the shared folder: it was never configured.
      expect(fs.existsSync(path.join(shared, 'devices'))).toBe(false);

      // --- B: preview, then import the file ---
      standalone(rootB);
      // A machine with no index yet is told to run `memex sync` once; a dry-run
      // never creates one on the way to answering (#97).
      expect(control.previewImportArchive(reexported.path).rejected.map((issue) => issue.error).join(' '))
        .toMatch(/no local index yet/);
      await ensureIndex(rootB);
      standalone(rootB);
      const preview = control.previewImportArchive(reexported.path);
      expect(preview.deviceAlias).toBe('집 맥미니');
      expect(preview.generation).toBe(reexported.generation);
      expect(preview).toMatchObject({ newFacts: 1, updatedFacts: 0, deletedFacts: 0, rejected: [] });
      // A preview changes nothing.
      expect(await readFact(rootB, 'fact-by-hand')).toBeUndefined();

      standalone(rootB);
      const imported = await control.importArchive(reexported.path);
      expect(imported.result).toMatchObject({ newFacts: 1 });
      expect(imported.result.malformedRows).toEqual([]);
      expect(await readFact(rootB, 'fact-by-hand')).toBe('deploys run from main');

      // A second import of the same file is a no-op, not a duplicate.
      standalone(rootB);
      expect((await control.importArchive(reexported.path)).result.newFacts).toBe(0);
    });

    it('refuses a file that is not a generation, and its own export', async () => {
      const control = await import('../src/sync-control.js');
      const { createZip } = await import('../src/zip.js');
      await seed(rootA, { id: 'fact-refuse', text: 'only real generations', subject: 'shared.refuse.rule' });
      standalone(rootA);
      const archive = control.exportGenerationArchive();

      // Its own export: the clocks make it harmless, but it is always a mistake.
      expect(() => control.previewImportArchive(archive.path)).toThrow(/exported by THIS device/);

      standalone(rootB);
      const notAZip = path.join(temp, 'notes.txt');
      fs.writeFileSync(notAZip, 'just some text');
      expect(() => control.previewImportArchive(notAZip)).toThrow(/sync archive is not a readable zip/);
      expect(() => control.previewImportArchive(path.join(temp, 'missing.zip'))).toThrow(/sync archive was not found/);
      expect(() => control.previewImportArchive('relative/path.zip')).toThrow(/sync archive path must be absolute/);

      const halfGeneration = path.join(temp, 'half.zip');
      fs.writeFileSync(halfGeneration, createZip([{ name: 'meta.json', data: Buffer.from('{"protocol_version":5}') }]));
      expect(() => control.previewImportArchive(halfGeneration)).toThrow(/is missing facts\.jsonl/);

      // A real generation with a broken payload is rejected by the v5 integrity
      // pass, not by a separate weaker check: reported, never half-imported.
      const { readZip } = await import('../src/zip.js');
      const original = readZip(fs.readFileSync(archive.path));
      const corrupted = path.join(temp, 'corrupt.zip');
      fs.writeFileSync(corrupted, createZip([...original].map(([name, data]) => ({
        name,
        data: name === 'facts.jsonl' ? Buffer.from(data.toString('utf8').replace('only real generations', 'tampered')) : data,
      }))));
      standalone(rootB);
      const rejected = control.previewImportArchive(corrupted);
      expect(rejected.newFacts).toBe(0);
      expect(rejected.rejected.some((issue) => issue.error.includes('sha256 mismatch'))).toBe(true);
      expect((await control.importArchive(corrupted)).result.newFacts).toBe(0);
    });

    /**
     * Issue #95 (0.6.6) — the privacy contract, not a convenience. The archive
     * path used to call `exportForSync()` with no destination, so the exporter
     * resolved the SHARED folder and `getSyncDir()` created it: with the switch
     * off, and even after the user had deleted the folder, one `--archive`
     * re-created the iCloud/Dropbox folder and published plaintext memories into
     * it while `memex sync status` still said `Sync: OFF`.
     *
     * The shipped test above cannot see this: `standalone()` only ever runs with
     * a shared folder that was NEVER configured.
     */
    it('publishes nothing into a configured shared folder while sync is off (#95)', async () => {
      const control = await import('../src/sync-control.js');
      const { readZip } = await import('../src/zip.js');
      await seed(rootA, { id: 'fact-offline', text: 'stays on this machine', subject: 'shared.offline.rule' });
      standalone(rootA);
      control.setSyncEnabled({ enabled: true, dir: shared }); // configured once,
      control.setSyncEnabled({ enabled: false }); // then switched off,
      fs.rmSync(shared, { recursive: true, force: true }); // and deleted.

      const archive = control.exportGenerationArchive();
      // The zip is still a complete protocol-v5 generation…
      expect(fs.existsSync(archive.path)).toBe(true);
      expect(archive.counts.facts).toBe(1);
      expect([...readZip(fs.readFileSync(archive.path)).keys()].sort()).toEqual([
        'fact-revisions.jsonl', 'fact-tombstones.jsonl', 'facts.jsonl', 'meta.json', 'recall-events.jsonl',
      ]);
      // …and nothing reached, or re-created, the shared folder.
      expect(fs.existsSync(shared)).toBe(false);
      expect(control.getSyncStatus().enabled).toBe(false);
      expect(control.getSyncStatus().peers).toEqual([]);
      // Nor the historical default shared folder, for a root that configured none.
      expect(fs.existsSync(path.join(rootA, 'conversation-index', 'sync', 'devices'))).toBe(false);
      // The record of what reached the destination still says "never".
      expect(control.getSyncStatus().lastExport).toBeNull();
      // Staging is scratch: it does not survive the call.
      expect(fs.readdirSync(path.join(rootA, 'sync')).filter((name) => name.startsWith('archive-staging-')))
        .toEqual([]);
    });

    /**
     * Issue #97 (0.6.6) — `--dry-run` promised to change nothing and created a
     * database, running every `CREATE TABLE`/`ALTER TABLE` migration and a
     * normalizing `UPDATE` before the rollback-only transaction even opened.
     * The shipped assertion (`readFact()` is undefined) cannot observe it: that
     * helper calls `initDatabase()` itself.
     */
    it('a dry-run neither creates nor migrates the local database (#97)', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-dry', text: 'dry runs write nothing', subject: 'shared.dry.rule' });
      standalone(rootA);
      const archive = control.exportGenerationArchive();

      // B has no index at all — nothing is seeded there.
      standalone(rootB);
      const dbPath = path.join(rootB, 'conversation-index', 'db.sqlite');
      expect(fs.existsSync(dbPath)).toBe(false);
      const preview = control.previewImportArchive(archive.path);
      expect(fs.existsSync(dbPath)).toBe(false);
      expect(fs.existsSync(path.join(rootB, 'conversation-index'))).toBe(false);
      expect(preview).toMatchObject({ newFacts: 0, updatedFacts: 0, deletedFacts: 0 });
      expect(preview.rejected.map((issue) => issue.error).join(' ')).toMatch(/no local index yet/);
      // The file is still identified, so the CLI can name what it refused to read.
      expect(preview.generation).toBe(archive.generation);

      // With an index present the preview runs for real and leaves the schema alone.
      await seed(rootB, { id: 'fact-local', text: 'local', subject: 'shared.local.rule' });
      standalone(rootB);
      const before = await schemaFingerprint(dbPath);
      const real = control.previewImportArchive(archive.path);
      expect(real).toMatchObject({ newFacts: 1, rejected: [] });
      expect(await schemaFingerprint(dbPath)).toBe(before);
      expect(await readFact(rootB, 'fact-dry')).toBeUndefined();
    });

    it('exports only inside the data root', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-confined', text: 'writes stay inside the root', subject: 'shared.confined.rule' });
      standalone(rootA);
      expect(() => control.exportGenerationArchive({ outPath: path.join(temp, 'escape.zip') }))
        .toThrow(/must stay inside the data root/);
      expect(() => control.exportGenerationArchive({ outPath: path.join(rootA, 'named.tar') }))
        .toThrow(/must end with \.zip/);
      const named = control.exportGenerationArchive({ outPath: path.join(rootA, 'sync', 'exports', 'named.zip') });
      expect(named.path).toBe(path.join(rootA, 'sync', 'exports', 'named.zip'));
      expect(fs.existsSync(named.path)).toBe(true);
    });

    /**
     * Issue #101 (0.6.6) — containment was a `path.resolve()` string prefix test,
     * and `path.resolve()` does not resolve symlinks, so one link inside the data
     * root carried a write outside it. The default destination was not checked at
     * all.
     */
    it('cannot write outside the data root through a symlink (#101)', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-link', text: 'no escape', subject: 'shared.link.rule' });
      standalone(rootA);
      const outside = path.join(temp, 'outside');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'precious.zip'), 'USER DATA');
      fs.symlinkSync(outside, path.join(rootA, 'link'));

      expect(() => control.exportGenerationArchive({ outPath: path.join(rootA, 'link', 'precious.zip') }))
        .toThrow(/must stay inside the data root/);
      expect(fs.readFileSync(path.join(outside, 'precious.zip'), 'utf8')).toBe('USER DATA');

      // The mirror-image misbehaviour: the SAME directory named through its real
      // path (macOS /var -> /private/var) used to be refused. It is legitimate.
      const viaReal = control.exportGenerationArchive({
        outPath: path.join(fs.realpathSync(rootA), 'sync', 'exports', 'real.zip'),
      });
      expect(fs.existsSync(viaReal.path)).toBe(true);

      // A final component that is itself a link is refused, not followed.
      fs.symlinkSync(viaReal.path, path.join(rootA, 'alias-link.zip'));
      expect(() => control.exportGenerationArchive({ outPath: path.join(rootA, 'alias-link.zip') }))
        .toThrow(/is a symlink/);

      // The DEFAULT destination is held to the same rule — a user who linked
      // `<data root>/sync/exports` into iCloud gets a refusal, not a quiet write.
      fs.rmSync(path.join(rootA, 'sync', 'exports'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(rootA, 'sync', 'exports'));
      expect(() => control.exportGenerationArchive()).toThrow(/data root/);
      expect(fs.readdirSync(outside).sort()).toEqual(['precious.zip']);
    });

    /**
     * Issue #105 (0.6.7) — #101's realpath comparison dropped the part of a path
     * that does not exist yet, so a data root that had never been created
     * collapsed to its deepest EXISTING ancestor and the boundary widened to that
     * ancestor: with `MEMEX_HOME=<temp>/never-created/root`, all of `<temp>` read
     * as "inside the data root" and `<temp>/escape.zip` was written.
     *
     * A pointed `MEMEX_DB_PATH` makes that the ordinary case rather than a corner
     * one: the index is real, so the export succeeds, and the only thing missing
     * is the root the boundary is supposed to be drawn around.
     */
    it('keeps the boundary at the data root when the root does not exist yet (#105)', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-unborn', text: 'no escape before mkdir', subject: 'shared.unborn.rule' });
      const dbPath = path.join(rootA, 'conversation-index', 'db.sqlite');
      expect(fs.existsSync(dbPath)).toBe(true);

      const unborn = path.join(temp, 'never-created', 'root');
      standalone(unborn);
      process.env.MEMEX_DB_PATH = dbPath;
      expect(fs.existsSync(unborn)).toBe(false);

      const escape = path.join(temp, 'escape-105.zip');
      expect(() => control.exportGenerationArchive({ outPath: escape }))
        .toThrow(/must stay inside the data root/);
      expect(fs.existsSync(escape)).toBe(false);
      // A refusal costs no generation and leaves no staging behind.
      expect(fs.existsSync(unborn)).toBe(false);

      // The deepest existing ancestor itself is not inside the root either.
      expect(() => control.exportGenerationArchive({ outPath: path.join(temp, 'never-created', 'sibling.zip') }))
        .toThrow(/must stay inside the data root/);

      // The default destination inside the not-yet-created root still works.
      const made = control.exportGenerationArchive();
      expect(made.path.startsWith(path.join(unborn, 'sync', 'exports') + path.sep)).toBe(true);
      expect(fs.existsSync(made.path)).toBe(true);
      // ...and so does an explicit path inside it, created on the way.
      const named = control.exportGenerationArchive({ outPath: path.join(unborn, 'carry', 'named.zip') });
      expect(fs.existsSync(named.path)).toBe(true);
    });

    it('names devices locally, and only this device name travels', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-alias', text: 'aliases are local state', subject: 'shared.alias.rule' });
      on(rootA);
      control.setSyncEnabled({ enabled: true });
      control.runSyncExport();
      const deviceA = control.getSyncStatus().deviceId!;
      control.setDeviceAlias(deviceA, '  집 맥미니  ');
      expect(control.getSyncStatus().deviceAlias).toBe('집 맥미니');
      expect(formatStatus(control)).toContain('"집 맥미니"');
      // The alias lives beside the switch, never in the shared folder.
      expect(fs.existsSync(path.join(rootA, 'sync', 'devices.json'))).toBe(true);
      expect(fs.existsSync(path.join(shared, 'devices.json'))).toBe(false);
      // It only travels after the next generation carries it.
      control.runSyncExport({ force: true });

      on(rootB);
      control.setSyncEnabled({ enabled: true });
      const peer = control.getSyncStatus().peers.find((entry) => entry.deviceId === deviceA)!;
      expect(peer.alias).toBe('집 맥미니');
      expect(peer.aliasIsLocal).toBe(false);
      // A local override wins and is not undone by the peer's next export.
      control.setDeviceAlias(deviceA, '작업실 맥');
      expect(control.getSyncStatus().peers.find((entry) => entry.deviceId === deviceA)).toMatchObject({
        alias: '작업실 맥',
        aliasIsLocal: true,
      });
      on(rootA);
      control.runSyncExport({ force: true });
      on(rootB);
      expect(control.getSyncStatus().peers.find((entry) => entry.deviceId === deviceA)?.alias).toBe('작업실 맥');
      // Clearing falls back to whatever the peer published.
      control.setDeviceAlias(deviceA, null);
      expect(control.getSyncStatus().peers.find((entry) => entry.deviceId === deviceA)?.alias).toBe('집 맥미니');
      expect(() => control.setDeviceAlias('../escape', 'x')).toThrow(/device id is not a sync device identifier/);
    });

    /**
     * Issue #98 (0.6.6) — the alias is a field of every manifest this device
     * publishes, but the export gate's fingerprint only read the DB, so renaming
     * a device reported `skipped: "unchanged"` forever and the peer kept showing
     * the old name (or a UUID) until some unrelated durable change happened. The
     * test above misses it because it uses `runSyncExport({ force: true })`.
     */
    it('publishes a new generation when only this device own alias changed (#98)', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-alias-gate', text: 'alias travels', subject: 'shared.aliasgate.rule' });
      on(rootA);
      control.setSyncEnabled({ enabled: true });
      expect(control.runSyncExport().skipped).toBeNull();
      // An idle machine still publishes nothing (#48 B).
      expect(control.runSyncExport().skipped).toBe('unchanged');

      const deviceId = control.getSyncStatus().deviceId!;
      control.setDeviceAlias(deviceId, '집 맥미니');
      expect(control.runSyncExport().skipped).toBeNull();
      expect(publishedAlias(deviceId)).toBe('집 맥미니');
      expect(control.runSyncExport().skipped).toBe('unchanged');

      // Clearing the name propagates too.
      control.setDeviceAlias(deviceId, null);
      expect(control.runSyncExport().skipped).toBeNull();
      expect(publishedAlias(deviceId)).toBeNull();

      // A name this machine gives a PEER is a local override that never travels,
      // so it must not make this device publish either.
      control.setDeviceAlias('some-peer-device-id', '작업실 맥');
      expect(control.runSyncExport().skipped).toBe('unchanged');
    });

    /** device_alias of the generation a peer would read for `deviceId`. */
    function publishedAlias(deviceId: string): string | null {
      const deviceDir = path.join(shared, 'devices', deviceId);
      const { generation } = JSON.parse(fs.readFileSync(path.join(deviceDir, 'CURRENT'), 'utf8')) as {
        generation: string;
      };
      const meta = JSON.parse(
        fs.readFileSync(path.join(deviceDir, 'generations', generation, 'meta.json'), 'utf8'),
      ) as { device_alias: string | null };
      return meta.device_alias;
    }

    function formatStatus(control: typeof import('../src/sync-control.js')): string {
      return control.formatSyncStatus(control.getSyncStatus());
    }
  });

  /**
   * Issue #103 (0.6.6) — a preview must say what the apply will do.
   *
   * An apply reflects the incoming tombstones FIRST and only then plans the
   * facts, so `planFactImports` sees the deletions arriving in the same payload
   * (it reads the local `fact_tombstones` table; the incoming set is not passed
   * in). The preview used to compute both plans independently on the untouched
   * database, so a fact the apply would skip was announced as `~1`.
   *
   * Today's shipped callers stage ONE device's ONE generation, where a fact row
   * and a tombstone for the same id cannot co-occur — the second test pins that
   * invariant, so the day one export can carry both, this stays honest.
   */
  describe('import preview agrees with apply (#103)', () => {
    it('reflects incoming tombstones before planning facts', async () => {
      const control = await import('../src/sync-control.js');
      const rootC = path.join(temp, 'device-c');
      fs.mkdirSync(rootC, { recursive: true });

      // A publishes the fact alive, with a newer meaning than C holds.
      await seed(rootA, { id: 'fact-shared', text: 'deploys run from main', subject: 'shared.preview.rule' });
      await editFact(rootA, 'fact-shared', 'deploys run from release branches', '2026-08-02T00:00:00.000Z');
      on(rootA);
      control.setSyncEnabled({ enabled: true });
      expect(control.runSyncExport().skipped).toBeNull();

      // B hard-deletes the same fact LATER, and carries one memory of its own.
      await seed(rootB, { id: 'fact-shared', text: 'deploys run from main', subject: 'shared.preview.rule' });
      await seed(rootB, { id: 'fact-b-only', text: 'b has its own memory', subject: 'shared.bonly.rule' });
      await hardDelete(rootB, 'fact-shared', '2026-08-03T00:00:00.000Z');
      on(rootB);
      control.setSyncEnabled({ enabled: true });
      expect(control.runSyncExport().skipped).toBeNull();

      // C holds the older copy and reads both generations at once.
      await seed(rootC, { id: 'fact-shared', text: 'deploys run from main', subject: 'shared.preview.rule' });
      on(rootC);
      const { previewSyncImport, importFromSync } = await import('../src/sync-import.js');
      const preview = previewSyncImport({ syncDir: shared });
      // The preview changed nothing, so the apply below starts from the same state.
      expect(await readFact(rootC, 'fact-shared')).toBe('deploys run from main');

      on(rootC);
      const applied = await importFromSync({ syncDir: shared });
      expect(preview.rejected).toEqual([]);
      expect(applied.malformedRows).toEqual([]);
      // Before the fix: preview said ~1 for a fact the apply never touched.
      expect(preview.updatedFacts).toBe(0);
      expect(preview.updatedFacts).toBe(applied.updatedFacts);
      expect(preview.newFacts).toBe(applied.newFacts);
      expect(preview.deletedFacts).toBe(applied.deletedFacts);
      expect(preview).toMatchObject({ newFacts: 1, deletedFacts: 1, conflicts: [] });
      // The deletion won on C, and B's own memory arrived.
      expect(await readFact(rootC, 'fact-shared')).toBeUndefined();
      expect(await readFact(rootC, 'fact-b-only')).toBe('b has its own memory');
    });

    it('one export never carries a fact row and a tombstone for the same id', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-alive', text: 'still here', subject: 'shared.alive.rule' });
      await seed(rootA, { id: 'fact-gone', text: 'deleted later', subject: 'shared.gone.rule' });
      await hardDelete(rootA, 'fact-gone', '2026-08-04T00:00:00.000Z');
      on(rootA);
      control.setSyncEnabled({ enabled: true });
      expect(control.runSyncExport().skipped).toBeNull();
      const deviceA = control.getSyncStatus().deviceId!;
      const generationDir = path.join(
        shared,
        'devices',
        deviceA,
        'generations',
        (JSON.parse(fs.readFileSync(path.join(shared, 'devices', deviceA, 'CURRENT'), 'utf8')) as {
          generation: string;
        }).generation,
      );
      const ids = (file: string, key: string): string[] =>
        fs.readFileSync(path.join(generationDir, file), 'utf8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => String((JSON.parse(line) as Record<string, unknown>)[key]));
      const facts = new Set(ids('facts.jsonl', 'id'));
      const tombstones = new Set(ids('fact-tombstones.jsonl', 'fact_id'));
      expect([...facts]).toEqual(['fact-alive']);
      expect([...tombstones]).toEqual(['fact-gone']);
      expect([...facts].filter((id) => tombstones.has(id))).toEqual([]);
    });
  });

  /**
   * Issue #48 (0.6.3) — conflict history. Without this, a peer silently
   * overwriting a memory this device edited left no trace at all.
   */
  describe('SYNC_IMPORTED conflict history (#48)', () => {
    async function events(root: string): Promise<Array<Record<string, unknown>>> {
      on(root);
      const { initDatabase } = await import('../src/db.js');
      const db = initDatabase();
      try {
        return db.prepare(
          "SELECT id, fact_id, previous_fact, new_fact, actor, event_kind, effective_at_source, projection_applied, outcome_json FROM fact_revisions WHERE event_kind = 'SYNC_IMPORTED'",
        ).all() as Array<Record<string, unknown>>;
      } finally {
        db.close();
      }
    }

    it('records which device won, in both directions, and keeps the record local', async () => {
      const control = await import('../src/sync-control.js');
      await seed(rootA, { id: 'fact-conflict', text: 'deploys run from main', subject: 'shared.conflict.rule' });
      on(rootA);
      control.setSyncEnabled({ enabled: true });
      expect(control.runSyncExport().skipped).toBeNull();
      const deviceA = control.getSyncStatus().deviceId!;
      control.setDeviceAlias(deviceA, 'A의 맥');
      control.runSyncExport({ force: true });

      on(rootB);
      control.setSyncEnabled({ enabled: true });
      await control.runSyncImport();
      // A new fact is convergence, not a conflict: no event yet.
      expect(await events(rootB)).toEqual([]);

      // --- peer wins: B's newer edit overrides A ---
      await editFact(rootB, 'fact-conflict', 'deploys run from release branches', '2026-08-05T00:00:00.000Z');
      on(rootB);
      control.runSyncExport({ force: true });
      on(rootA);
      expect((await control.runSyncImport()).result?.updatedFacts).toBeGreaterThanOrEqual(1);
      const onA = await events(rootA);
      expect(onA).toHaveLength(1);
      expect(onA[0]).toMatchObject({
        fact_id: 'fact-conflict',
        actor: 'sync',
        event_kind: 'SYNC_IMPORTED',
        effective_at_source: 'peer',
        projection_applied: 0,
        previous_fact: 'deploys run from main',
        new_fact: 'deploys run from release branches',
      });
      expect(JSON.parse(String(onA[0].outcome_json))).toMatchObject({ winner: 'peer', reason: 'peer-newer' });
      // Re-importing the same generation collapses on the content-derived id.
      on(rootA);
      await control.runSyncImport();
      expect(await events(rootA)).toHaveLength(1);

      // --- local wins: A edits later, then imports B's older generation ---
      await editFact(rootA, 'fact-conflict', 'deploys run from tags', '2026-08-09T00:00:00.000Z');
      on(rootA);
      await control.runSyncImport();
      const bothWays = await events(rootA);
      expect(bothWays).toHaveLength(2);
      const localWin = bothWays.map((row) => JSON.parse(String(row.outcome_json)) as { winner: string; source_device_alias: string | null })
        .find((outcome) => outcome.winner === 'local');
      expect(localWin).toBeDefined();
      // The local edit stood, and the record names the device it beat.
      expect(await readFact(rootA, 'fact-conflict')).toBe('deploys run from tags');

      // --- the history itself never travels (src/sync-export.ts) ---
      on(rootA);
      control.runSyncExport({ force: true });
      const generation = (JSON.parse(
        fs.readFileSync(path.join(shared, 'devices', deviceA, 'CURRENT'), 'utf-8'),
      ) as { generation: string }).generation;
      const payload = fs.readFileSync(
        path.join(shared, 'devices', deviceA, 'generations', generation, 'fact-revisions.jsonl'),
        'utf-8',
      );
      expect(payload).not.toContain('SYNC_IMPORTED');
      // And a device that never conflicted still publishes nothing extra for it.
      on(rootB);
      await control.runSyncImport();
      expect((await events(rootB)).length).toBeGreaterThanOrEqual(0);
    });
  });

  it('the export hook script is registered on SessionEnd as a timed synchronous entry', async () => {
    const { LIFECYCLE_COMMANDS, SYNC_LIFECYCLE_SCRIPTS, isLifecycleScriptRegistered } =
      await import('../src/lifecycle.js');
    // The regression: before 0.6.1 this script was in no hook at all.
    expect(isLifecycleScriptRegistered(SYNC_LIFECYCLE_SCRIPTS.export)).toBe(true);
    const entry = LIFECYCLE_COMMANDS.SessionEnd.find(
      (command) => command.script === SYNC_LIFECYCLE_SCRIPTS.export,
    );
    // #110: no `async` — Codex runs SessionEnd hooks synchronously and warned when told otherwise.
    expect(entry).toMatchObject({ timeout: 10 });
    expect(entry).not.toHaveProperty('async');
    // The bounded capture fence stays synchronous and untouched beside it.
    expect(LIFECYCLE_COMMANDS.SessionEnd[0]).toMatchObject({
      script: 'scripts/continuity-hook.js',
      timeout: 3,
    });
    const manifest = JSON.parse(fs.readFileSync('hooks.json', 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean; timeout?: number }> }>>;
    };
    const manifestEntries = manifest.hooks.SessionEnd.flatMap((block) => block.hooks);
    expect(manifestEntries).toHaveLength(2);
    expect(manifestEntries[1]).toMatchObject({
      command: 'node "${PLUGIN_ROOT}/cli/runtime-exec.js" memex-hook-sync-export',
      timeout: 10,
    });
    expect(manifestEntries[1]).not.toHaveProperty('async');
  });
});
