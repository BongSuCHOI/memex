#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

function runCodex(args) {
  return spawnSync('codex', args, { encoding: 'utf8' });
}

function memoryEnabled() {
  const result = runCodex(['features', 'list']);
  if (result.error) throw new Error(`Could not run Codex CLI: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Could not inspect Codex features: ${(result.stderr || result.stdout).trim()}`);
  const line = result.stdout.split(/\r?\n/).find((entry) => /^memories\s/.test(entry));
  if (!line) throw new Error('This Codex version does not expose the memories feature; no setting was changed.');
  return /\btrue\s*$/.test(line.trim());
}

async function approvedByUser() {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('Disable Codex built-in Memory now? [y/N] ');
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: memex setup [--dry-run] [--disable-codex-memory]

Detect the effective Codex built-in memories feature. No setting changes unless
you approve interactively or pass --disable-codex-memory explicitly.`);
    return;
  }
  const explicitApproval = args.includes('--disable-codex-memory');
  const dryRun = args.includes('--dry-run');
  const unknown = args.filter((arg) => !['--disable-codex-memory', '--dry-run'].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown setup option: ${unknown[0]}`);

  if (!memoryEnabled()) {
    console.log('Codex built-in Memory is already disabled. No memory setting changed.');
    return;
  }

  console.log('Codex built-in Memory is enabled. Running it with Memex can create duplicate or conflicting recall.');
  console.log('Recommendation: disable Codex built-in Memory while Memex is active.');
  if (dryRun) {
    console.log('[dry-run] Would run: codex features disable memories');
    console.log('No setting changed.');
    return;
  }

  const approved = explicitApproval || await approvedByUser();
  if (!approved) {
    console.log('Codex built-in Memory was left enabled. To approve the change explicitly, run:');
    console.log('  memex setup --disable-codex-memory');
    return;
  }

  const result = runCodex(['features', 'disable', 'memories']);
  if (result.error || result.status !== 0) {
    throw new Error(`Codex could not disable memories: ${(result.stderr || result.stdout || result.error?.message).trim()}`);
  }
  if (memoryEnabled()) throw new Error('Codex reported success but the memories feature is still enabled.');
  console.log('Codex built-in Memory disabled and verified. Restart Codex before first Memex sync/backfill.');
}

main().catch((error) => {
  console.error(`memex setup: ${error.message}`);
  process.exit(1);
});
