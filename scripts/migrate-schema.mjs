#!/usr/bin/env node
// Issue #166 — apply the data root's schema migration once, deliberately.
//
// The migration pass is idempotent and every entry point runs it, so this script
// exists for TIMING, not for correctness: the first session after an update used
// to open the database with five hooks at once, and whichever connection won ran
// the new-table migration under the write lock while the continuity hook waited
// on it (930 ms, then `busy`, then a skipped capture). `memex update` runs this
// after materializing the dependencies, when nothing is waiting on the lock.
//
// `--root <path>` selects WHICH build to migrate with (the freshly installed
// plugin root, whose dist is the one the next session will load).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

const root = path.resolve(option('--root') ?? path.join(HERE, '..'));
const dbModule = path.join(root, 'dist', 'db.js');
if (!fs.existsSync(dbModule)) {
  console.error(`Schema migration skipped: no build at ${dbModule}`);
  process.exit(1);
}

try {
  const { applySchemaMigrations } = await import(pathToFileURL(dbModule).href);
  const result = applySchemaMigrations();
  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? '';
    } catch {
      return '';
    }
  })();
  console.log(
    result.migrated
      ? `Schema migrated for ${version || `schema v${result.version}`} (schema v${result.version})`
      : `Schema already current (schema v${result.version})`,
  );
} catch (error) {
  console.error(
    `Schema migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
