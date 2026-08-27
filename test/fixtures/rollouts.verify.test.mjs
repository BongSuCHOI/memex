// CX-00 fixture verification: every fixture must parse through the real
// codex-rollout module with the expected outcome. Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const FIXTURES = path.join(REPO, 'test/fixtures/rollouts');
const { parseRolloutStream, readRolloutMeta } = await import(path.join(REPO, 'src/codex-rollout.ts'));

const stream = (file) => Readable.from(fs.readFileSync(path.join(FIXTURES, file), 'utf8').split('\n').filter(Boolean).map((l) => l + '\n'));

test('fixture: main-thread ingests user/assistant/tool exchanges', async () => {
  const { exchanges, isSubagent } = await parseRolloutStream(stream('main-thread.jsonl'), { archivePath: 'x' });
  assert.equal(isSubagent, false);
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].userMessage, 'What pagination does list.ts use?');
  assert.equal(exchanges[0].toolCalls.length, 1);
  const all = JSON.stringify(exchanges);
  assert.ok(!all.includes('reasoning-summary-marker'));
  assert.ok(!all.includes('<environment_context>'));
});

test('fixture: subagent thread is flagged for whole-thread isolation', async () => {
  const hdr = await readRolloutMeta(path.join(FIXTURES, 'subagent-thread.jsonl'));
  assert.equal(hdr.isSubagent, true);
  // parseRolloutStream still assembles exchanges; the isolation contract is
  // enforced by sync/indexer/session-end-hook which drop isSubagent sessions
  // before any exchange reaches the archive or index (asserted here).
  const { isSubagent } = await parseRolloutStream(stream('subagent-thread.jsonl'), { archivePath: 'x' });
  assert.equal(isSubagent, true);
});

test('fixture: tool-only turn preserved', async () => {
  const { exchanges } = await parseRolloutStream(stream('tool-only-turn.jsonl'), { archivePath: 'x' });
  assert.equal(exchanges.length, 2);
  assert.equal(exchanges[0].assistantMessage, '');
  assert.equal(exchanges[0].toolCalls.length, 1);
  assert.equal(exchanges[1].userMessage, 'thanks, what failed?');
});

test('fixture: malformed line tolerated, rest parsed', async () => {
  const { exchanges } = await parseRolloutStream(stream('malformed-line.jsonl'), { archivePath: 'x' });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].userMessage, 'question after malformed lines');
});

test('fixture: empty rollout yields zero exchanges', async () => {
  const { exchanges, isSubagent } = await parseRolloutStream(stream('empty-rollout.jsonl'), { archivePath: 'x' });
  assert.equal(isSubagent, false);
  assert.equal(exchanges.length, 0);
});

test('fixture: same-basename A/B carry distinct cwds', async () => {
  for (const team of ['team-a', 'team-b']) {
    const { meta, isSubagent } = await readRolloutMeta(path.join(FIXTURES, `same-basename-${team}.jsonl`)).then((h) => ({ meta: h.meta, isSubagent: h.isSubagent }));
    assert.equal(isSubagent, false);
    assert.equal(meta.cwd, `/tmp/mb-fixture/${team}/shared`);
    assert.equal(path.basename(meta.cwd), 'shared');
  }
});

test('fixture: internal context prefixes excluded from user turns', async () => {
  const { exchanges } = await parseRolloutStream(stream('internal-context-prompt.jsonl'), { archivePath: 'x' });
  assert.equal(exchanges.length, 1);
  assert.equal(exchanges[0].userMessage, 'real question about retry policy');
});

test('fixture: resumed session contains pre- and post-boundary turns', async () => {
  const { exchanges } = await parseRolloutStream(stream('resumed-session.jsonl'), { archivePath: 'x' });
  assert.equal(exchanges.length, 2);
  assert.ok(exchanges[0].userMessage.includes('auth flow'));
  assert.ok(exchanges[1].userMessage.includes('token lifetime'));
});

test('fixture: worker prompt matches the real worker-guard prefixes', async () => {
  const paths = await import(path.join(REPO, 'dist/paths.js'));
  const text = fs.readFileSync(path.join(FIXTURES, 'worker-prompt.jsonl'), 'utf8');
  const firstUser = JSON.parse(text.split('\n')[1]).payload.content[0].text;
  assert.equal(paths.isWorkerPromptMessage(firstUser), true);
});
