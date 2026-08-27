import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBenchmarkReport } from '../scripts/benchmark-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('published conversion benchmark contains direct evidence for all performance gates', () => {
  const report = JSON.parse(fs.readFileSync(path.join(root, 'docs/verification/benchmark.json'), 'utf8'));
  assert.deepEqual(validateBenchmarkReport(report), []);
});
