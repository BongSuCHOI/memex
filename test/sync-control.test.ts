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
    const check = () => doctor().json.find((entry) => (entry as { name: string }).name === 'sync-export') as
      | { name: string; status: string; detail: string }
      | undefined;

    expect(check()?.status).toBe('ok');
    expect(check()?.detail).toContain('skipped(off)');

    const control = await import('../src/sync-control.js');
    control.setSyncEnabled({ enabled: true });
    expect(check()?.status).toBe('warn');
    expect(check()?.detail).toContain('nothing has been exported yet');

    await seed(rootA, { id: 'fact-doctor', text: 'doctor sees an export', subject: 'shared.doctor.case' });
    on(rootA);
    expect(control.runSyncExport().skipped).toBeNull();
    expect(check()?.status).toBe('ok');
    expect(check()?.detail).toContain('last export ok');
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

  it('the export hook script is registered on SessionEnd as an async entry', async () => {
    const { LIFECYCLE_COMMANDS, SYNC_LIFECYCLE_SCRIPTS, isLifecycleScriptRegistered } =
      await import('../src/lifecycle.js');
    // The regression: before 0.6.1 this script was in no hook at all.
    expect(isLifecycleScriptRegistered(SYNC_LIFECYCLE_SCRIPTS.export)).toBe(true);
    const entry = LIFECYCLE_COMMANDS.SessionEnd.find(
      (command) => command.script === SYNC_LIFECYCLE_SCRIPTS.export,
    );
    expect(entry).toMatchObject({ async: true });
    // The bounded capture fence stays synchronous and untouched beside it.
    expect(LIFECYCLE_COMMANDS.SessionEnd[0]).toMatchObject({
      script: 'scripts/continuity-hook.js',
      timeout: 3,
    });
    const manifest = JSON.parse(fs.readFileSync('hooks.json', 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>>;
    };
    const manifestEntries = manifest.hooks.SessionEnd.flatMap((block) => block.hooks);
    expect(manifestEntries).toHaveLength(2);
    expect(manifestEntries[1]).toMatchObject({
      command: 'node "${PLUGIN_ROOT}/cli/runtime-exec.js" memex-hook-sync-export',
      async: true,
    });
  });
});
