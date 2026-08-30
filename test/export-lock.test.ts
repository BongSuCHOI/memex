import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initDatabase } from '../src/db.js';
import { ExportLockedError, exportForSync, withExportTransaction } from '../src/sync-export.js';

describe('local export transaction serialization', () => {
  let tmpDir: string;
  let first: ReturnType<typeof initDatabase>;
  let second: ReturnType<typeof initDatabase>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-export-lock-'));
    process.env.MEMEX_HOME = tmpDir;
    first = initDatabase();
    second = initDatabase();
  });

  afterEach(() => {
    first.close();
    second.close();
    delete process.env.MEMEX_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('allows only one exporter for the local device database at a time', () => {
    withExportTransaction(first, () => {
      expect(() => withExportTransaction(second, () => undefined)).toThrow(ExportLockedError);
    });

    expect(() => withExportTransaction(second, () => undefined)).not.toThrow();
  });

  it('reports real export entrypoint contention as ExportLockedError', () => {
    withExportTransaction(first, () => {
      expect(() => exportForSync()).toThrow(ExportLockedError);
    });
  });

  it('rolls back and releases serialization when an export fails', () => {
    expect(() => withExportTransaction(first, () => {
      throw new Error('filesystem write failed');
    })).toThrow('filesystem write failed');

    expect(() => withExportTransaction(second, () => undefined)).not.toThrow();
  });
});
