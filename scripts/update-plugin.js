#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipMaterialize = args.includes('--no-materialize');
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function run(commandArgs) {
  const result = spawnSync('codex', commandArgs, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`codex ${commandArgs.join(' ')} failed (${result.status}): ${detail}`);
  }
  return result;
}

function json(commandArgs) {
  return JSON.parse(run(commandArgs).stdout);
}

try {
  const requestedMarketplace = option('--marketplace');
  const installed = (json(['plugin', 'list', '--json']).installed || [])
    .filter((plugin) => plugin.name === 'memex' && plugin.installed !== false);
  const candidates = requestedMarketplace
    ? installed.filter((plugin) => plugin.marketplaceName === requestedMarketplace)
    : installed;
  if (candidates.length === 0) {
    throw new Error(requestedMarketplace
      ? `Memex is not installed from marketplace ${requestedMarketplace}`
      : 'Memex is not installed');
  }
  if (candidates.length > 1) {
    throw new Error(`multiple Memex installs found (${candidates.map((item) => item.marketplaceName).join(', ')}); pass --marketplace <name>`);
  }

  const current = candidates[0];
  const marketplaceName = current.marketplaceName;
  const selector = `memex@${marketplaceName}`;
  const marketplace = (json(['plugin', 'marketplace', 'list', '--json']).marketplaces || [])
    .find((item) => item.name === marketplaceName);
  if (!marketplace) throw new Error(`marketplace is not registered: ${marketplaceName}`);
  const isGit = marketplace.marketplaceSource?.sourceType === 'git';

  console.log(`Current: ${selector} ${current.version || 'unknown'}`);
  console.log(`Marketplace: ${isGit ? 'Git snapshot will be refreshed' : 'local source will be re-read'}`);
  console.log(`Plan: ${isGit ? 'marketplace upgrade -> ' : ''}plugin remove -> plugin add`);
  if (dryRun) {
    console.log('Dry run complete. No registry, cache, hook, or data changes were made.');
    process.exit(0);
  }

  if (isGit) run(['plugin', 'marketplace', 'upgrade', marketplaceName, '--json']);
  run(['plugin', 'remove', selector, '--json']);
  let installedRoot = null;
  try {
    const added = json(['plugin', 'add', selector, '--json']);
    console.log(`Updated: ${selector} ${added.version || 'latest'}`);
    if (added.installedPath) {
      installedRoot = added.installedPath;
      console.log(`Installed root: ${added.installedPath}`);
    }
  } catch (error) {
    console.error(`Plugin reinstall failed after removal. Recover with: codex plugin add ${selector}`);
    throw error;
  }

  // Issue #53: `plugin add` unpacks the new version into a NEW cache directory
  // with no node_modules, so every hook silently reverts to the unpinned
  // `npx github:BongSuCHOI/memex#main` fallback right after an update — exactly
  // what was observed after moving to 0.6.0. Materialize the runtime closure
  // here, and when that is not possible print the one command that fixes it.
  //
  // Issue #92: materialize also warms the embedding model cache, because the
  // OTHER thing a fresh root used to start without was the 129 MB of model
  // weights — `--no-warm` travels with the rest of the flags.
  const materializeScript = path.join(HERE, 'materialize-deps.mjs');
  const rootArgs = [
    ...(installedRoot ? ['--root', installedRoot] : []),
    ...(args.includes('--no-warm') ? ['--no-warm'] : []),
  ];
  const suggestion = `memex deps materialize${installedRoot ? ` --root "${installedRoot}"` : ''}`;
  if (skipMaterialize) {
    console.log(`Runtime dependencies were NOT materialized (--no-materialize). Run: ${suggestion}`);
  } else if (installedRoot && !fs.existsSync(path.join(installedRoot, 'package.json'))) {
    console.log(`Installed root is not readable yet. After Codex finishes unpacking, run: ${suggestion}`);
  } else {
    const materialize = spawnSync(process.execPath, [materializeScript, ...rootArgs], {
      stdio: 'inherit',
    });
    if (materialize.error || materialize.status !== 0) {
      console.error(`Runtime dependencies are not materialized. Run: ${suggestion}`);
    }
  }

  // Issue #166: apply the schema migration HERE, with the new build and nothing
  // waiting on the write lock. Otherwise the first session after an update opens
  // the database with five hooks at once and the continuity hook waits on
  // whichever connection won and is running the new-table migration — 930 ms,
  // then `busy`, then a skipped capture. Best effort: the migration is idempotent
  // and every entry point still runs it, so a failure here only loses the timing.
  const migrateRoot = installedRoot && fs.existsSync(path.join(installedRoot, 'dist', 'db.js'))
    ? installedRoot
    : path.join(HERE, '..');
  const migrate = spawnSync(
    process.execPath,
    [path.join(HERE, 'migrate-schema.mjs'), '--root', migrateRoot],
    { stdio: 'inherit' },
  );
  // Exit 3 means it ran and skipped something: the database is still behind and
  // the next open retries it. The install itself succeeded either way, so this is
  // a warning at the end of a successful update, never an abort.
  if (migrate.status === 3) {
    console.error("The schema migration above did not complete. It is retried on the next session; `memex doctor`'s schema-version check reports where the file stands.");
  } else if (migrate.error || migrate.status !== 0) {
    console.error('Schema will be migrated by the first session instead (run: memex doctor to confirm).');
  }
  console.log('Memex data was preserved. Restart Codex to load updated MCP, skills, and hooks.');
} catch (error) {
  console.error(`memex update failed: ${error.message}`);
  process.exit(1);
}
