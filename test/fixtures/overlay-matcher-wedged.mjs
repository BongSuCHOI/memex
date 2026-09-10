/**
 * Test double: a matcher worker that is READY and then never answers.
 *
 * `MEMEX_TEST_MATCHER_MODE` picks which progress slot it leaves behind — the
 * three cases the (generation, index) pair exists to tell apart (G3):
 *
 *   `attributable`      — our generation, a valid index: the execution timeout
 *                         MAY quarantine patterns[index].
 *   `no-index`          — our generation, index -1: the worker is still
 *                         compiling, or its reply is already in flight. `-1` is
 *                         never grounds for quarantine.
 *   `stale-generation`  — a valid index stamped with SOMEONE ELSE's generation.
 *                         Attributing this timeout would quarantine another
 *                         request's pattern and kill the shared worker.
 *
 * It then blocks its own thread the way a backtracking regex would, so the
 * parent's only way out really is `terminate()`.
 */
import { parentPort, workerData } from 'node:worker_threads';

const progress = new Int32Array(workerData.progress);
const mode = process.env.MEMEX_TEST_MATCHER_MODE ?? 'attributable';

parentPort.on('message', (request) => {
  const generation = Number(request?.generation ?? 0);
  if (mode === 'stale-generation') {
    Atomics.store(progress, 0, generation + 9999);
    Atomics.store(progress, 1, 0);
  } else if (mode === 'no-index') {
    Atomics.store(progress, 0, generation);
    Atomics.store(progress, 1, -1);
  } else {
    Atomics.store(progress, 0, generation);
    Atomics.store(progress, 1, request?.patterns?.length ? 0 : -1);
  }
  const until = Date.now() + 5_000;
  while (Date.now() < until) { /* spin, holding this worker's thread */ }
});
parentPort.postMessage({ ready: true });
