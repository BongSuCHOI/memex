import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * 재감사 P2-6 — SessionEnd sync-export 실패가 무음이 아닌 계약.
 *
 * sync-export-hook은 실패해도 session lifecycle을 wedge하지 않지만(exit 0),
 * 실패는 durable status(sync/export-status.json)로 기록되고 stderr로 보고되며,
 * SessionEnd는 export를 호출하지 않는다. export 상태는 이 독립 helper만 소유한다.
 * 다음 성공 export가 status를 덮어쓰는 것이 자연 retry다.
 */

const REPO = process.cwd();
const STATUS_REL = path.join('conversation-index', 'sync', 'export-status.json');

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mx-export-status-'));
}

function readStatus(home: string): { ok: boolean; at?: string; error?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, STATUS_REL), 'utf8'));
  } catch {
    return null;
  }
}

/** Sandbox tree mimicking the plugin layout: scripts/ + dist/ with a
 * sabotaged sync-export module that throws, plus a real status recorder. */
function buildSandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-export-sandbox-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  // Real hooks, resolved relative to their own location — they will pick up
  // the sandbox dist/ instead of the repo one.
  fs.copyFileSync(
    path.join(REPO, 'scripts', 'sync-export-hook.js'),
    path.join(root, 'scripts', 'sync-export-hook.js'),
  );
  fs.writeFileSync(
    path.join(root, 'dist', 'sync-export.js'),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'import { randomUUID } from "node:crypto";',
      'export function exportForSync() {',
      '  throw new Error("boom-reinject");',
      '}',
      'function statusPath() {',
      '  return path.join(process.env.MEMEX_HOME, "conversation-index", "sync", "export-status.json");',
      '}',
      'export function readExportStatus() {',
      '  try { return JSON.parse(fs.readFileSync(statusPath(), "utf8")); } catch { return null; }',
      '}',
      'export function recordExportStatus(status) {',
      '  const p = statusPath();',
      '  fs.mkdirSync(path.dirname(p), { recursive: true });',
      '  const t = `${p}.${process.pid}.${randomUUID()}.tmp`;',
      '  fs.writeFileSync(t, JSON.stringify(status, null, 2));',
      '  fs.renameSync(t, p);',
      '}',
    ].join('\n') + '\n',
  );
  return root;
}

describe('sync export failure status (P2-6)', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it('records a successful export durably', () => {
    const home = tmpHome();
    homes.push(home);
    const run = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'sync-export-hook.js')], {
      cwd: REPO,
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
      },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    const status = readStatus(home);
    expect(status?.ok).toBe(true);
  });

  it('records a failed export durably without wedging (exit 0)', () => {
    const home = tmpHome();
    homes.push(home);
    const sandbox = buildSandbox();
    homes.push(sandbox);
    const run = spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'sync-export-hook.js')], {
      cwd: REPO,
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
      },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0); // lifecycle must not wedge
    expect(run.stderr).toContain('sync-export: Error');
    expect(run.stderr).toContain('boom-reinject');
    const status = readStatus(home);
    expect(status?.ok).toBe(false);
    expect(status?.error).toContain('boom-reinject');
  });

  it('the next successful export overwrites a failure status (retry)', () => {
    const home = tmpHome();
    homes.push(home);
    const sandbox = buildSandbox();
    homes.push(sandbox);
    spawnSync(process.execPath, [path.join(sandbox, 'scripts', 'sync-export-hook.js')], {
      cwd: REPO,
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
      },
      encoding: 'utf8',
    });
    expect(readStatus(home)?.ok).toBe(false);

    // Next lifecycle: the real hook runs against the real dist.
    spawnSync(process.execPath, [path.join(REPO, 'scripts', 'sync-export-hook.js')], {
      cwd: REPO,
      env: {
        ...process.env,
        MEMEX_HOME: home,
        MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
      },
      encoding: 'utf8',
    });
    expect(readStatus(home)?.ok).toBe(true);
  });

  it('SessionEnd writes only a final fence and never invokes foreground export', () => {
    const home = tmpHome();
    homes.push(home);
    const rolloutDir = path.join(home, 'rollouts');
    fs.mkdirSync(rolloutDir, { recursive: true });
    const transcript = path.join(rolloutDir, 'rollout-qa.jsonl');
    fs.writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'sess-export-qa', cwd: '/tmp/export-status-project' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } }),
      ].join('\n') + '\n',
    );

    const run = spawnSync(
      process.execPath,
      [path.join(REPO, 'scripts', 'session-end-hook.js')],
      {
        cwd: REPO,
        env: {
          ...process.env,
          MEMEX_HOME: home,
          MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
          MEMEX_ALLOWED_TRANSCRIPT_ROOTS: rolloutDir,
          MEMEX_CONTINUITY_NO_WAKE: '1',
        },
        input: JSON.stringify({
          hook_event_name: 'SessionEnd',
          session_id: 'sess-export-qa',
          transcript_path: transcript,
          cwd: '/tmp/export-status-project',
        }),
        encoding: 'utf8',
        timeout: 60000,
      },
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(readStatus(home)).toBeNull();
    const check = new Database(path.join(home, 'conversation-index', 'db.sqlite'), { readonly: true });
    try {
      expect(check.prepare(`
        SELECT kind, closure_state, state FROM checkpoints WHERE session_id = ?
      `).get('sess-export-qa')).toEqual({ kind: 'final', closure_state: 'final', state: 'pending' });
      expect(check.prepare(`
        SELECT kind, state FROM memory_jobs WHERE checkpoint_id IN
          (SELECT checkpoint_id FROM checkpoints WHERE session_id = ?)
        ORDER BY priority DESC
      `).all('sess-export-qa')).toEqual([
        { kind: 'capture_index', state: 'pending' },
        { kind: 'capsule_update', state: 'pending' },
      ]);
    } finally {
      check.close();
    }
  });
});
