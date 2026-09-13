/**
 * Issue #114 — a failed `memex backfill` stage says WHY it failed.
 *
 * Before this, `backfill all` printed only "embeddings backfill failed; remaining
 * stages were not started", so a cold model download, a disk error and a
 * dimension mismatch were indistinguishable — in a gate receipt and on a user's
 * machine alike.
 *
 * The stage loop lives in `cli/backfill-stages.mjs` precisely so it can be driven
 * here with a stubbed stage: no worker, no database, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeStageCause,
  formatStageFailure,
  runBackfillStages,
  tailLines,
} from '../cli/backfill-stages.mjs';

/** `backfill all`'s order, as `cli/memex.js` builds it. */
const ALL = ['extract', 'ontology', 'embeddings', 'receipts'];

function collect() {
  const info = [];
  const errors = [];
  return {
    info,
    errors,
    log: (line) => info.push(line),
    logError: (line) => errors.push(line),
  };
}

test('a failing embeddings stage surfaces the underlying message and code', async () => {
  const sink = collect();
  const ran = [];
  const outcome = await runBackfillStages({
    stages: ALL.slice(2),
    allStages: true,
    runStage: async (stage) => {
      ran.push(stage);
      if (stage !== 'embeddings') return;
      throw Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), {
        code: 'EAI_AGAIN',
      });
    },
    log: sink.log,
    logError: sink.logError,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStage, 'embeddings');
  // Fail fast: the stage after the failure never started.
  assert.deepEqual(ran, ['embeddings']);
  assert.equal(sink.errors.length, 1);
  const message = sink.errors[0];
  assert.equal(message, outcome.message);
  assert.match(message, /^embeddings backfill failed: /);
  assert.match(message, /getaddrinfo ENOTFOUND huggingface\.co/);
  assert.match(message, /code=EAI_AGAIN/);
  assert.match(message, /remaining stages were not started/);
  assert.match(message, /stages are idempotent/);
  // The embedding-cache check is what separates the two cold-cache shapes.
  assert.match(message, /memex doctor/);
  assert.match(message, /memex deps warm/);
});

test('a single-stage run keeps its own wording and still names the cause', async () => {
  const sink = collect();
  const outcome = await runBackfillStages({
    stages: ['ontology'],
    allStages: false,
    runStage: () => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    },
    log: sink.log,
    logError: sink.logError,
  });

  assert.equal(outcome.ok, false);
  assert.equal(
    sink.errors[0],
    'ontology backfill failed: SQLITE_CORRUPT: database disk image is malformed.',
  );
  assert.doesNotMatch(sink.errors[0], /remaining stages/);
});

test('a worker exit code and its last output both reach the message', () => {
  const cause = Object.assign(new Error('Command failed with exit code 1'), {
    code: 1,
    tail: ['reembed: ERROR vector dimension mismatch (384 != 768)'],
  });
  const message = formatStageFailure('embeddings', { allStages: true, cause });
  assert.match(message, /Command failed with exit code 1/);
  assert.match(message, /last output: reembed: ERROR vector dimension mismatch/);
  // The exit code is already in the message — do not say it twice.
  assert.doesNotMatch(message, /code=1/);
});

test('a stage killed by a signal reports the signal', () => {
  const cause = Object.assign(new Error('Command killed by signal SIGKILL'), {
    signal: 'SIGKILL',
  });
  assert.match(
    formatStageFailure('extract', { allStages: true, cause }),
    /signal=SIGKILL/,
  );
});

test('every stage succeeding leaves no error and reports each start', async () => {
  const sink = collect();
  const outcome = await runBackfillStages({
    stages: ALL,
    allStages: true,
    runStage: async () => {},
    log: sink.log,
    logError: sink.logError,
  });
  assert.deepEqual(outcome, { ok: true, failedStage: null, cause: null, message: '' });
  assert.equal(sink.errors.length, 0);
  assert.deepEqual(
    sink.info,
    ALL.map((stage) => `Running ${stage} backfill in foreground...`),
  );
});

test('a causeless failure degrades to the pre-0.7.3 wording', () => {
  assert.equal(
    formatStageFailure('receipts', { allStages: false }),
    'receipts backfill failed.',
  );
  assert.equal(describeStageCause(undefined), '');
});

test('the captured tail keeps only the last non-empty lines', () => {
  const tail = tailLines('a\n\nb\nc\nd\ne\nf\n\n');
  assert.deepEqual(tail, ['b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(tailLines('only  \n', 2), ['only']);
});
