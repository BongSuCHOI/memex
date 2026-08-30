// 재감사 P2(본 회차): export lock 소유권 hardening — stale-break된 이전
// 보유자가 후계자의 lock을 지우면 세 번째 exporter가 끼어들 수 있다.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { acquireExportLock, releaseExportLock, ExportLockedError } from '../src/sync-export.js';

describe('export lock ownership (P2 v4)', () => {
  let syncDir: string;
  let lockPath: string;

  beforeEach(() => {
    syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-export-lock-'));
    lockPath = path.join(syncDir, 'export.lock');
  });

  afterEach(() => {
    fs.rmSync(syncDir, { recursive: true, force: true });
  });

  it('a stale-broken holder must not delete its successor\'s lock', () => {
    const a = acquireExportLock(syncDir);
    expect(fs.existsSync(lockPath)).toBe(true);

    // Holder A stalls past the stale window (mtime-only staleness, no sleeps).
    const old = new Date(Date.now() - 16 * 60 * 1000);
    fs.utimesSync(lockPath, old, old);

    // B stale-breaks and legitimately acquires.
    const b = acquireExportLock(syncDir);

    // A resumes and releases — its release must leave B's lock alone.
    releaseExportLock(syncDir, a);
    expect(fs.existsSync(lockPath)).toBe(true);

    // B releases its OWN lock — removed.
    releaseExportLock(syncDir, b);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('a fresh foreign lock is neither acquirable nor releasable by a non-owner', () => {
    const a = acquireExportLock(syncDir);

    expect(() => acquireExportLock(syncDir)).toThrow(ExportLockedError);

    // A stale-broken or fabricated owner object must not remove the lock.
    releaseExportLock(syncDir, { pid: 999999, nonce: 'not-the-owner', acquiredAt: '2026-08-30T00:00:00.000Z' });
    expect(fs.existsSync(lockPath)).toBe(true);

    releaseExportLock(syncDir, a);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releasing a missing or corrupt lock is a no-op, and the lock records its owner', () => {
    // Missing lock: release must not throw.
    releaseExportLock(syncDir, { pid: process.pid, nonce: 'n', acquiredAt: 'x' });

    const a = acquireExportLock(syncDir);
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number; nonce: string };
    expect(body.pid).toBe(process.pid);
    expect(body.nonce).toBe(a.nonce);

    // Corrupt content: release cannot verify ownership — leaves the file for
    // the mtime stale-break instead of deleting a successor's lock blindly.
    fs.writeFileSync(lockPath, 'not-json');
    releaseExportLock(syncDir, a);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('not-json');
  });
});
