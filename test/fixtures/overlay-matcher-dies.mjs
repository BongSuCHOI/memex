/**
 * Test double: a matcher worker that DIES on the first request.
 *
 * It announces readiness the way the real worker does, so the parent gets past
 * the startup budget, then throws out of the message handler — an unexpected
 * death, not a termination the parent asked for. That is the one branch the
 * production worker cannot be made to take on purpose.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => {
  throw new Error('overlay matcher test double: dying on purpose');
});
parentPort.postMessage({ ready: true });
