import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('published plugin receipt closes the version-bound substitute contract without NOT_PROVEN', () => {
  const receipt = JSON.parse(fs.readFileSync('docs/verification/plugin-validation.json', 'utf8'));
  assert.equal(receipt.verdict, 'PASS-WITH-NOTES (version-bound)');
  assert.equal(receipt.validator.available, false);
  assert.match(receipt.validator.observed, /(unknown|unrecognized) subcommand/i);
  assert.ok(Array.isArray(receipt.checks) && receipt.checks.length >= 8);
  assert.equal(receipt.checks.every((check) => check.status === 'PASS'), true);
  assert.equal(JSON.stringify(receipt).includes('NOT_PROVEN'), false);
  assert.equal(receipt.cleanup.plugin_absent, true);
  assert.equal(receipt.cleanup.marketplace_absent, true);
  assert.equal(receipt.cleanup.temp_root_absent, true);
});
