#!/usr/bin/env node
/**
 * Issue #26 (item 5) — prove a gate run did not touch the REAL Memex data root.
 *
 * Observed in 0.5.0 QA: `test/web-ui-db-factory.test.mjs` isolated only
 * `MEMEX_DB_PATH`, so the suite appended 21 audit lines to the real
 * `~/.config/memex/logs/ui-audit.jsonl`. Every script and test is supposed to
 * put `MEMEX_HOME` (and `XDG_CONFIG_HOME`) on a temporary path; nothing checked
 * that they actually did.
 *
 * This is a READ-ONLY probe. It walks the real data root, records size, mtime
 * and content hash per file, and compares two snapshots. It never writes inside
 * the data root — the snapshot file goes wherever `--out` says (a temp path by
 * default).
 *
 * Usage:
 *   node scripts/check-real-root-untouched.mjs snapshot [--out <file>] [--root <dir>]
 *   node scripts/check-real-root-untouched.mjs compare --baseline <file> [--json]
 *
 * `compare` exits 1 when anything under the root was added, removed or
 * modified, and prints each path with what changed.
 *
 * Run it with Codex closed. A live session legitimately writes journals and
 * logs; the point of the check is a gate run, not a busy machine. Volatile
 * runtime artifacts (`run-locks/`, unix sockets) are ignored by default because
 * they exist only while something is running — `--strict` compares them too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const command = args[0];
const option = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const JSON_OUT = args.includes('--json');
const STRICT = args.includes('--strict');
/** Files above this size record metadata only; hashing a whole archive per gate is not worth it. */
const HASH_LIMIT_BYTES = Number(option('--hash-limit', String(8 * 1024 * 1024)));

if (!command || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage:
  node scripts/check-real-root-untouched.mjs snapshot [--out <file>] [--root <dir>] [--strict]
  node scripts/check-real-root-untouched.mjs compare --baseline <file> [--json] [--strict]

Read-only isolation probe for the release gate: proves a gate run left the real
Memex data root byte-identical. Takes a snapshot before the gate and compares
after it. Exits 1 on any difference.

Options:
  --root <dir>     Data root to inspect (default: MEMEX_HOME > $XDG_CONFIG_HOME/memex > ~/.config/memex)
  --out <file>     Where to write the snapshot (default: a file in the OS temp dir)
  --baseline <f>   Snapshot to compare against
  --hash-limit <n> Bytes above which a file records size+mtime only (default 8388608)
  --strict         Also compare volatile runtime artifacts (run-locks/, sockets)
  --json           Machine-readable comparison result`);
  process.exit(0);
}

function realDataRoot() {
  const explicit = option('--root');
  if (explicit) return path.resolve(explicit);
  if (process.env.MEMEX_HOME) return path.resolve(process.env.MEMEX_HOME);
  if (process.env.XDG_CONFIG_HOME) return path.join(path.resolve(process.env.XDG_CONFIG_HOME), 'memex');
  return path.join(os.homedir(), '.config', 'memex');
}

/** Runtime artifacts that exist only while a process is running. */
function isVolatile(relative) {
  if (STRICT) return false;
  return (
    relative === 'run-locks' ||
    relative.startsWith(`run-locks${path.sep}`) ||
    relative.endsWith('.sock')
  );
}

function walk(root) {
  const entries = new Map();
  const visit = (absolute) => {
    let dirents;
    try {
      dirents = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      entries.set(path.relative(root, absolute) || '.', { unreadable: String(error.code ?? error) });
      return;
    }
    for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(absolute, dirent.name);
      const relative = path.relative(root, child);
      if (isVolatile(relative)) continue;
      if (dirent.isDirectory()) {
        visit(child);
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(child);
      } catch (error) {
        entries.set(relative, { unreadable: String(error.code ?? error) });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        let target = null;
        try { target = fs.readlinkSync(child); } catch { /* dangling */ }
        entries.set(relative, { symlink: target, mtimeMs: stat.mtimeMs });
        continue;
      }
      if (!dirent.isFile()) {
        entries.set(relative, { kind: 'special', mtimeMs: stat.mtimeMs });
        continue;
      }
      let sha256 = null;
      if (stat.size <= HASH_LIMIT_BYTES) {
        try {
          sha256 = createHash('sha256').update(fs.readFileSync(child)).digest('hex');
        } catch (error) {
          entries.set(relative, { unreadable: String(error.code ?? error) });
          continue;
        }
      }
      entries.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    }
  };
  if (fs.existsSync(root)) visit(root);
  return entries;
}

function snapshot() {
  const root = realDataRoot();
  const out = option('--out', path.join(os.tmpdir(), `memex-real-root-${Date.now()}.json`));
  const files = walk(root);
  const payload = {
    root,
    exists: fs.existsSync(root),
    takenAt: new Date().toISOString(),
    strict: STRICT,
    hashLimitBytes: HASH_LIMIT_BYTES,
    fileCount: files.size,
    files: Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), JSON.stringify(payload, null, 2) + '\n');
  console.log(`snapshot: ${payload.fileCount} file(s) under ${root}`);
  console.log(`baseline: ${path.resolve(out)}`);
  process.exit(0);
}

function describe(entry) {
  if (!entry) return 'absent';
  if (entry.unreadable) return `unreadable(${entry.unreadable})`;
  if (entry.symlink !== undefined) return `symlink -> ${entry.symlink}`;
  if (entry.kind) return entry.kind;
  return `${entry.size} bytes sha256=${entry.sha256 ? entry.sha256.slice(0, 12) : 'not-hashed'}`;
}

function sameEntry(before, after) {
  if (!before || !after) return false;
  if (before.sha256 !== undefined || after.sha256 !== undefined) {
    // Content is the verdict; mtime alone is reported but never decides, so a
    // read that touches atime/mtime without changing bytes is not a violation.
    return before.size === after.size && before.sha256 === after.sha256;
  }
  return JSON.stringify(before) === JSON.stringify(after);
}

function compare() {
  const baselinePath = option('--baseline');
  if (!baselinePath) {
    console.error('compare needs --baseline <file> (produced by the snapshot command)');
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
  const root = option('--root') ? path.resolve(option('--root')) : baseline.root;
  const after = walk(root);
  const beforeFiles = new Map(Object.entries(baseline.files ?? {}));

  const added = [];
  const removed = [];
  const modified = [];
  for (const [relative, entry] of after) {
    if (!beforeFiles.has(relative)) added.push({ path: relative, after: describe(entry) });
    else if (!sameEntry(beforeFiles.get(relative), entry)) {
      modified.push({ path: relative, before: describe(beforeFiles.get(relative)), after: describe(entry) });
    }
  }
  for (const [relative, entry] of beforeFiles) {
    if (!after.has(relative)) removed.push({ path: relative, before: describe(entry) });
  }

  const clean = added.length === 0 && removed.length === 0 && modified.length === 0;
  const result = {
    ok: clean,
    root,
    baseline: path.resolve(baselinePath),
    baselineTakenAt: baseline.takenAt,
    comparedAt: new Date().toISOString(),
    fileCountBefore: beforeFiles.size,
    fileCountAfter: after.size,
    added,
    removed,
    modified,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else if (clean) {
    console.log(`OK  real data root untouched: ${after.size} file(s) identical under ${root}`);
  } else {
    console.error(`FAIL real data root changed under ${root}`);
    for (const item of added) console.error(`  added    ${item.path} (${item.after})`);
    for (const item of removed) console.error(`  removed  ${item.path} (was ${item.before})`);
    for (const item of modified) console.error(`  modified ${item.path}: ${item.before} -> ${item.after}`);
    console.error('A gate run must isolate MEMEX_HOME *and* XDG_CONFIG_HOME onto a temporary path.');
  }
  process.exit(clean ? 0 : 1);
}

if (command === 'snapshot') snapshot();
else if (command === 'compare') compare();
else {
  console.error(`unknown command: ${command} (expected 'snapshot' or 'compare')`);
  process.exit(2);
}
