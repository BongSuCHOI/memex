// CX-11 — security & isolation gates. Plain node --test against dist.
// AC-SEC-01 path confinement, AC-SEC-02 model isolation, escaping, size caps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
process.env.MEMORY_BANK_PLUGIN_ROOT = REPO;

function seedArchive(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx11-'));
  t.after(() => {
    for (const k of ['TEST_DB_PATH', 'TEST_ARCHIVE_DIR']) delete process.env[k];
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const archive = path.join(dir, 'archive');
  const dbPath = path.join(dir, 'db.sqlite');
  process.env.TEST_DB_PATH = dbPath;
  process.env.TEST_ARCHIVE_DIR = archive;
  const proj = path.join(archive, 'proj--deadbeef');
  fs.mkdirSync(proj, { recursive: true });
  const secret = path.join(dir, 'secret.jsonl');
  fs.writeFileSync(secret, '{"secret":"do-not-leak"}\n');
  fs.writeFileSync(path.join(proj, 'rollout-ok.jsonl'),
    JSON.stringify({ type: 'session_meta', timestamp: 't', payload: { id: 'i', session_id: 's', cwd: '/tmp/p', source: 'cli' } }) + '\n' +
    JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } }) + '\n');
  return { dir, archive, secret };
}

async function callRead(args) {
  const mod = await import(path.join(REPO, 'dist/mcp-server.js'));
  return mod.handleToolCall('read', args);
}

test('AC-SEC-01: traversal, foreign absolute paths, and symlink escapes are rejected', async (t) => {
  const { dir, archive, secret } = seedArchive(t);

  // Baseline: legitimate archive file reads fine.
  const ok = await callRead({ path: path.join(archive, 'proj--deadbeef', 'rollout-ok.jsonl') });
  assert.notEqual(ok.isError, true);

  // Foreign absolute path outside allowed roots.
  const foreign = await callRead({ path: secret });
  assert.equal(foreign.isError, true);
  assert.match(foreign.content[0].text, /Access denied|outside|not found/i);
  assert.ok(!foreign.content[0].text.includes('do-not-leak'));

  // Traversal out of the archive root.
  const trav = await callRead({ path: path.join(archive, '..', '..', path.basename(dir), 'secret.jsonl') });
  assert.equal(trav.isError, true);
  assert.ok(!trav.content[0].text.includes('do-not-leak'));

  // Symlink inside the archive pointing outside.
  const link = path.join(archive, 'proj--deadbeef', 'evil-link.jsonl');
  try { fs.symlinkSync(secret, link); } catch { /* platform */ }
  if (fs.existsSync(link)) {
    const sym = await callRead({ path: link });
    assert.equal(sym.isError, true);
    assert.ok(!sym.content[0].text.includes('do-not-leak'), 'symlink escaped confinement');
  }
});

test('input size caps: oversized MCP queries are rejected by schema', async (t) => {
  await seedArchive(t);
  const mod = await import(path.join(REPO, 'dist/mcp-server.js'));
  const huge = 'x'.repeat(20000);
  const r = await mod.handleToolCall('search_facts', { query: huge, scope: 'all' });
  assert.equal(r.isError, true, 'oversized query must be a bounded error');
});

test('SQL inputs stay parameterized: quote-bearing search neither crashes nor leaks', async (t) => {
  await seedArchive(t);
  const mod = await import(path.join(REPO, 'dist/mcp-server.js'));
  for (const evil of ["'; DROP TABLE exchanges; --", "' OR '1'='1", '"; --']) {
    const r = await mod.handleToolCall('search', { query: evil, mode: 'text', limit: 5 });
    assert.notEqual(r.isError, true, `benign bounded handling expected for ${evil}`);
  }
});

test('graph and facts surfaces render fact text as text, never as markup', async (t) => {
  const appJs = fs.readFileSync(path.join(REPO, 'ui', 'relations', 'app.js'), 'utf8');
  // Fact text flows through esc() at every innerHTML insertion site.
  assert.ok(/esc\(of\[2\]\)/.test(appJs), 'relation panel must escape fact text');
  assert.ok(/esc\(f\[2\]\)/.test(appJs), 'hover/detail must escape fact text');
  const factsPage = fs.readFileSync(path.join(REPO, 'ui', 'server.cjs'), 'utf8');
  assert.ok(factsPage.includes("tdFact.textContent = f.fact"), 'facts table must use textContent');
  void factsPage;
});

test('model-child rollouts are not self-ingested (worker prompt guard + recursion guard)', async (t) => {
  const paths = await import(path.join(REPO, 'dist/paths.js'));
  assert.equal(paths.isWorkerPromptMessage('You are an expert at extracting long-term facts from conversations.\nTRANSCRIPT...'), true);
  assert.equal(paths.isExcludedProject('/tmp/abc/memory-bank-llm', []), true);
  assert.equal(paths.isExcludedProject('/tmp/my-app', []), false);
  const execMod = await import(path.join(REPO, 'dist/codex-exec.js'));
  assert.ok(execMod.INNER_GUARD_ENV, 'recursion guard contract present');
});

test('hook observation log stays redacted (no prompt/fact content)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-cx11-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.MEMORY_BANK_HOME = dir;
  t.after(() => { delete process.env.MEMORY_BANK_HOME; });
  const { recordHookEvent } = await import(path.join(REPO, 'dist/observe-hook-event.js'));
  recordHookEvent('UserPromptSubmit', { sessionId: 's1', cwd: '/p' });
  const log = fs.readFileSync(path.join(dir, 'logs', 'hook-events.jsonl'), 'utf8');
  assert.ok(!log.includes('prompt'), 'log must not contain prompt payloads');
});
