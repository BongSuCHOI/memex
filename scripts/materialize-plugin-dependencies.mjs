import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_RUNTIME_FILES = [
  '@modelcontextprotocol/sdk/package.json',
  '@xenova/transformers/package.json',
  'better-sqlite3/package.json',
  'marked/package.json',
  'sqlite-vec/package.json',
  'zod/package.json',
];

export function runtimeDependenciesReady(installedRoot) {
  return REQUIRED_RUNTIME_FILES.every((relative) => fs.existsSync(path.join(installedRoot, 'node_modules', relative)));
}

/**
 * Copy the already-installed production dependency closure into Codex's cache.
 * This is packaging, not dependency installation: no registry/network access,
 * package-manager mutation, lifecycle script, or version resolution occurs.
 */
export function materializePluginDependencies(sourceRoot, installedRoot) {
  if (runtimeDependenciesReady(installedRoot)) return { changed: false, packages: 0 };
  const destination = path.join(installedRoot, 'node_modules');
  if (fs.existsSync(destination)) {
    throw new Error(`installed cache contains an incomplete node_modules tree: ${destination}`);
  }
  const sourceModules = fs.realpathSync(path.join(sourceRoot, 'node_modules'));
  const listed = spawnSync('npm', ['ls', '--omit=dev', '--parseable', '--all'], {
    cwd: sourceRoot,
    encoding: 'utf8',
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(`cannot inventory production dependencies: ${(listed.stderr || listed.stdout || listed.error?.message || '').trim()}`);
  }
  const packagePaths = listed.stdout.split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => fs.realpathSync(entry))
    .filter((entry) => entry.startsWith(sourceModules + path.sep))
    .sort((a, b) => a.length - b.length);
  if (!packagePaths.length) throw new Error('production dependency inventory is empty');

  const stage = path.join(installedRoot, `.memex-node_modules-stage-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  try {
    for (const packagePath of packagePaths) {
      const relative = path.relative(sourceModules, packagePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`dependency escaped source node_modules: ${packagePath}`);
      }
      const target = path.join(stage, relative);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(packagePath, target, {
        recursive: true,
        dereference: false,
        mode: fs.constants.COPYFILE_FICLONE,
      });
    }
    fs.renameSync(stage, destination);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  if (!runtimeDependenciesReady(installedRoot)) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw new Error('materialized runtime dependency tree is incomplete');
  }
  return { changed: true, packages: packagePaths.length };
}
