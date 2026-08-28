import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('MCP manifest allows the first isolated runtime install to finish', () => {
  const manifest = JSON.parse(fs.readFileSync('.mcp.json', 'utf8'));
  const server = manifest.mcpServers?.memex;

  assert.equal(server?.startup_timeout_sec, 300);
});
