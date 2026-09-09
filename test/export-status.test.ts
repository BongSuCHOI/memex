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
 * 실패는 durable status(sync/export-status.json)로 기록되고 stderr로 보고된다.
 * 다음 성공 export가 status를 덮어쓰는 것이 자연 retry다.
 *
 * 0.6.1(#35/#48): SessionEnd의 **동기 capture fence**는 여전히 export를 호출하지
 * 않는다. export는 별도의 async SessionEnd 항목이고, 동기화 스위치가 꺼져 있으면
 * (기본값) 아무 일도 하지 않는다. 그래서 아래 테스트는 스위치를 켠 상태를 만든다.
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

/** The on-disk state `memex sync enable` produces (#48 decision 5). */
function enableSync(home: string): void {
  const configPath = path.join(home, 'sync', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({ enabled: true, dir: null, updatedAt: '2026-08-30T00:00:00.000Z' }, null, 2),
  );
}

function runExportHook(home: string, syncDir: string) {
  return spawnSync(process.execPath, [path.join(REPO, 'scripts', 'sync-export-hook.js')], {
    cwd: REPO,
    env: {
      ...process.env,
      MEMEX_HOME: home,
      MEMEX_DB_PATH: path.join(home, 'conversation-index', 'db.sqlite'),
      MEMEX_SYNC_DIR: syncDir,
    },
    encoding: 'utf8',
  });
}

describe('sync export failure status (P2-6)', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  });

  it('does nothing and records nothing while cross-device sync is off', () => {
    const home = tmpHome();
    homes.push(home);
    const run = runExportHook(home, path.join(home, 'shared'));
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('sync-export: skipped (cross-device sync is off)');
    expect(readStatus(home)).toBeNull();
  });

  it('records a successful export durably', () => {
    const home = tmpHome();
    homes.push(home);
    enableSync(home);
    const run = runExportHook(home, path.join(home, 'shared'));
    expect(run.status).toBe(0);
    const status = readStatus(home);
    expect(status?.ok).toBe(true);
  });

  it('records a failed export durably without wedging (exit 0)', () => {
    const home = tmpHome();
    homes.push(home);
    enableSync(home);
    // A shared folder that cannot be a directory: the observed real-world shape
    // of an unusable cloud path, without stubbing the exporter.
    const blocked = path.join(home, 'not-a-directory');
    fs.writeFileSync(blocked, 'this is a file\n');
    const run = runExportHook(home, blocked);
    expect(run.status).toBe(0); // lifecycle must not wedge
    expect(run.stderr).toContain('sync-export: Error');
    const status = readStatus(home);
    expect(status?.ok).toBe(false);
    expect(status?.error).toContain(blocked);
  });

  it('the next successful export overwrites a failure status (retry)', () => {
    const home = tmpHome();
    homes.push(home);
    enableSync(home);
    const blocked = path.join(home, 'not-a-directory');
    fs.writeFileSync(blocked, 'this is a file\n');
    runExportHook(home, blocked);
    expect(readStatus(home)?.ok).toBe(false);

    // Next lifecycle: the shared folder is usable again.
    runExportHook(home, path.join(home, 'shared'));
    expect(readStatus(home)?.ok).toBe(true);
  });

  it('the SessionEnd capture fence writes only a final fence and never exports inline', () => {
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
