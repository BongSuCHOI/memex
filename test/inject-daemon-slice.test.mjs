import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

test('inject daemon creates its index directory on a fresh data root', async () => {
  // macOS sockaddr_un paths are short; use /tmp so this test exercises the
  // directory contract rather than exceeding the platform socket-path limit.
  const root = fs.mkdtempSync('/tmp/mb-daemon-test-');
  const code = `
    import fs from 'node:fs';
    import net from 'node:net';
    import path from 'node:path';
    import { startInjectDaemon } from './dist/inject-daemon.js';
    const socketPath = path.join(process.env.MEMEX_HOME, 'conversation-index', 'inject-daemon.sock');
    const timer = setTimeout(() => { console.error('socket timeout'); process.exit(2); }, 3000);
    const connect = () => {
      const socket = net.connect(socketPath);
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); server.close(); process.exit(0); });
      socket.once('error', (error) => { console.error('connect error', error.message); socket.destroy(); });
    };
    const server = startInjectDaemon();
    const indexDir = path.dirname(socketPath);
    if (!fs.existsSync(indexDir)) { console.error('index directory missing'); process.exit(3); }
    server.on('error', (error) => console.error('server error', error.message));
    if (server.listening) connect(); else server.once('listening', connect);
  `;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: path.resolve('.'),
        env: { ...process.env, MEMEX_HOME: root, TEST_DB_PATH: path.join(root, 'conversation-index', 'db.sqlite') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve({ exitCode, stderr }));
    });
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
