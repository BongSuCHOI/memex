#!/usr/bin/env node
/**
 * Copy non-TypeScript runtime assets from `src/` into `dist/`.
 *
 * `tsc` only emits the `.ts` files it compiles, so the worker entry points added
 * in 0.7.0 (`overlay-matcher-worker.mjs`, `overlay-regex-probe.mjs`) would be
 * missing from `dist/` and from the published tarball — `.npmignore` excludes
 * `src/`, and `package.json files` ships `dist/`. They are resolved with
 * `new URL('./<name>.mjs', import.meta.url)` from their sibling module, so they
 * must sit BESIDE the compiled output, under the same basename.
 *
 * They stay `.mjs` rather than `.ts` deliberately: a worker entry is loaded by
 * URL at runtime, not imported, so compiling it would only add a build artefact
 * with no type-checking benefit — and the esbuild bundle for the MCP server must
 * not inline it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');

fs.mkdirSync(distDir, { recursive: true });

const assets = fs.readdirSync(srcDir).filter((name) => name.endsWith('.mjs'));
let copied = 0;
for (const name of assets) {
  fs.copyFileSync(path.join(srcDir, name), path.join(distDir, name));
  copied++;
}
process.stdout.write(`copy-dist-assets: ${copied} file(s) (${assets.join(', ') || 'none'})\n`);
