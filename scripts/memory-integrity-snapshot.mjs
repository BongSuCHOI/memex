#!/usr/bin/env node
// Read-only source capture + offline restore drill. Never restores over live data.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function snapshotAndRestore({ memexHome, sessionsRoot, output }) {
  const home = fs.realpathSync(memexHome);
  const sessions = fs.realpathSync(sessionsRoot);
  const out = path.resolve(output);
  // Resolve an existing parent so an output symlink cannot alias a source.
  const parent = fs.realpathSync(path.dirname(out));
  const canonicalOut = path.join(parent, path.basename(out));
  if (contains(home, canonicalOut) || contains(sessions, canonicalOut) || fs.existsSync(out)) {
    throw new Error('snapshot output must be a new directory outside both source roots');
  }
  fs.mkdirSync(out, { mode: 0o700 });
  const snapshot = path.join(out, 'snapshot');
  const restored = path.join(out, 'restored');
  const manifest = { version: 1, startedAt: new Date().toISOString(), roots: { memexHome: home, sessionsRoot: sessions }, files: [], unstable: [], omitted: [], database: {}, restore: {} };
  const dbRelative = 'conversation-index/db.sqlite';
  fs.mkdirSync(path.join(snapshot, 'memex', 'conversation-index'), { recursive: true });
  const db = new Database(path.join(home, dbRelative), { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(db);
    await db.backup(path.join(snapshot, 'memex', dbRelative));
  } finally { db.close(); }
  manifest.database.snapshotAt = new Date().toISOString();
  const walk = async (source, destination, prefix) => {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}/${entry.name}`;
      const input = path.join(source, entry.name);
      const target = path.join(destination, entry.name);
      if (relative === `memex/${dbRelative}` || relative.startsWith(`memex/${dbRelative}-`) ||
          relative === 'memex/run-locks' || entry.isSocket() || entry.name.endsWith('.log')) {
        manifest.omitted.push(relative);
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`source symlink requires explicit capture mapping: ${relative}`);
      if (entry.isDirectory()) { await walk(input, target, relative); continue; }
      if (!entry.isFile()) throw new Error(`unsupported source entry: ${relative}`);
      const before = fs.statSync(input);
      fs.copyFileSync(input, target, fs.constants.COPYFILE_EXCL);
      const after = fs.statSync(input);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) manifest.unstable.push(relative);
    }
  };
  await walk(home, path.join(snapshot, 'memex'), 'memex');
  await walk(sessions, path.join(snapshot, 'sessions'), 'sessions');
  const inventory = async (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await inventory(path.join(directory, entry.name), relative);
      else manifest.files.push({ path: relative, bytes: fs.statSync(path.join(directory, entry.name)).size, sha256: await hashFile(path.join(directory, entry.name)) });
    }
  };
  await inventory(snapshot);
  fs.cpSync(snapshot, restored, { recursive: true, errorOnExist: true, force: false });
  for (const file of manifest.files) {
    if (await hashFile(path.join(restored, file.path)) !== file.sha256) throw new Error(`restore hash mismatch: ${file.path}`);
  }
  const check = new Database(path.join(restored, 'memex', dbRelative), { readonly: true, fileMustExist: true });
  try {
    sqliteVec.load(check);
    manifest.restore.integrity = check.pragma('integrity_check');
    manifest.restore.foreignKeys = check.pragma('foreign_key_check');
    if (manifest.restore.integrity.some(row => row.integrity_check !== 'ok') || manifest.restore.foreignKeys.length) {
      throw new Error('restored database integrity check failed');
    }
  } finally { check.close(); }
  manifest.restore.hashesVerified = manifest.files.length;
  manifest.restore.status = 'PASS';
  manifest.capture = { fileStability: manifest.unstable.length ? 'FAIL' : 'PASS', crossRootAtomicity: 'NOT_PROVEN' };
  manifest.status = manifest.unstable.length ? 'FAIL' : 'RESTORE_VERIFIED';
  manifest.completedAt = new Date().toISOString();
  manifest.consistency = 'SQLite online backup is transaction-consistent. Cross-file/source capture is NOT_PROVEN atomic while writers run. Offline drill verifies bytes and DB integrity; original absolute path mappings must be retained for an actual restore. Never replace live tombstones with an older snapshot.';
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [memexHome, sessionsRoot, output] = process.argv.slice(2);
  if (!memexHome || !sessionsRoot || !output) throw new Error('usage: node scripts/memory-integrity-snapshot.mjs MEMEX_HOME SESSIONS_ROOT NEW_OUTPUT_DIR');
  const result = await snapshotAndRestore({ memexHome, sessionsRoot, output });
  console.log(JSON.stringify({ status: result.status, capture: result.capture, files: result.files.length, unstableFiles: result.unstable.length, restore: result.restore, consistency: result.consistency }, null, 2));
  if (result.unstable.length) process.exitCode = 1;
}
