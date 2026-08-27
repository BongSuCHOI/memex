#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
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
  try {
    const added = json(['plugin', 'add', selector, '--json']);
    console.log(`Updated: ${selector} ${added.version || 'latest'}`);
    if (added.installedPath) console.log(`Installed root: ${added.installedPath}`);
  } catch (error) {
    console.error(`Plugin reinstall failed after removal. Recover with: codex plugin add ${selector}`);
    throw error;
  }
  console.log('Memex data was preserved. Restart Codex to load updated MCP, skills, and hooks.');
} catch (error) {
  console.error(`memex update failed: ${error.message}`);
  process.exit(1);
}
