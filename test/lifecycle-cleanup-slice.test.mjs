import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('offline lifecycle E2E proves every cleanup surface from live state', async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/lifecycle-e2e.mjs', '--tier', 'offline'], {
      cwd: path.resolve('.'),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`lifecycle E2E timed out\n${stderr}`)); }, 180_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout, stderr }); });
  });
  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('__CLEANUP_JSON__'));
  assert.ok(line, 'lifecycle E2E must emit a machine-verifiable cleanup receipt');
  const receipt = JSON.parse(line.slice('__CLEANUP_JSON__'.length));
  assert.deepEqual(receipt, {
    plugin_registration_absent: true,
    owned_hooks_absent: true,
    temp_data_absent: true,
    test_workers_zero: true,
    inject_sockets_zero: true,
    test_listeners_zero: true,
    user_environment_isolated: true,
  });
});
