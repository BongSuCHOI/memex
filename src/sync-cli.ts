import { syncConversations } from './sync.js';
import { getArchiveDir } from './paths.js';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import fs from 'fs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Usage: memory-bank sync [--background]

Sync conversations from ~/.claude/projects to archive and index them.

This command:
1. Copies new or updated .jsonl files to conversation archive
2. Generates embeddings for semantic search
3. Updates the search index

Only processes files that are new or have been modified since last sync.
Safe to run multiple times - subsequent runs are fast no-ops.

OPTIONS:
  --background    Run sync in background (for hooks, returns immediately)

EXAMPLES:
  # Sync all new conversations
  memory-bank sync

  # Sync in background (for hooks)
  memory-bank sync --background

  # Use in Claude Code hook
  # In .claude/hooks/session-end:
  memory-bank sync --background
`);
  process.exit(0);
}

// Check if running in background mode
const isBackground = args.includes('--background');

// If background mode, fork the process and exit immediately
if (isBackground) {
  const filteredArgs = args.filter(arg => arg !== '--background');

  // Spawn a detached process
  const child = spawn(process.execPath, [
    process.argv[1], // This script
    ...filteredArgs
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });

  child.unref(); // Allow parent to exit
  console.log('Sync started in background...');
  process.exit(0);
}

// ---- singleton lock (2026-07-02): SessionStart hook fires sync --background on EVERY
// session start; with many concurrent sessions (auto-issue workers, QA cron, interactive)
// detached syncs pile up unbounded (measured: 76 concurrent -> load avg 164).
// Sync is idempotent - if one is already running, later ones can safely skip.
const __lockDir = path.join(os.homedir(), '.claude', 'run-locks', 'memory-bank-sync.lock');
const __pidFile = path.join(__lockDir, 'pid');

function __pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

function __acquireLock(): boolean {
  try {
    fs.mkdirSync(__lockDir, { recursive: false });
  } catch {
    let holder = NaN;
    try { holder = parseInt(fs.readFileSync(__pidFile, 'utf8').trim(), 10); } catch {}
    if (Number.isFinite(holder) && __pidAlive(holder)) return false;
    try { fs.rmSync(__lockDir, { recursive: true, force: true }); fs.mkdirSync(__lockDir, { recursive: false }); }
    catch { return false; }
  }
  try { fs.writeFileSync(__pidFile, String(process.pid)); } catch {}
  return true;
}

if (!__acquireLock()) {
  console.log('Sync already running - skip (singleton lock)');
  process.exit(0);
}
process.on('exit', () => { try { fs.rmSync(__lockDir, { recursive: true, force: true }); } catch {} });

const sourceDir = path.join(os.homedir(), '.claude', 'projects');
const destDir = getArchiveDir();

console.log('Syncing conversations...');
console.log(`Source: ${sourceDir}`);
console.log(`Destination: ${destDir}\n`);

syncConversations(sourceDir, destDir)
  .then(result => {
    console.log(`\n✅ Sync complete!`);
    console.log(`  Copied: ${result.copied}`);
    console.log(`  Skipped: ${result.skipped}`);
    console.log(`  Indexed: ${result.indexed}`);
    console.log(`  Summarized: ${result.summarized}`);

    if (result.errors.length > 0) {
      console.log(`\n⚠️  Errors: ${result.errors.length}`);
      result.errors.forEach(err => console.log(`  ${err.file}: ${err.error}`));
    }
  })
  .catch(error => {
    console.error('Error syncing:', error);
    process.exit(1);
  });
