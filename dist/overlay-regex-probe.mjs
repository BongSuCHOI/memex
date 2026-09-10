/**
 * Measuring probe — DEFENCE IN DEPTH on the WRITE path only (§2.3.2).
 *
 * Passing a finite probe corpus is NOT a safety proof and this file makes no
 * such claim: the guarantee lives in src/overlay-matcher.ts's 50 ms execution
 * box. What the probe buys is fast feedback at `memex gate patterns add` time —
 * an obviously pathological pattern is refused before it is ever saved, instead
 * of being saved and then quarantined on the first real prompt.
 *
 * It runs in a terminable worker for the same reason the matcher does: the probe
 * itself executes the candidate regex, so the thing being measured can hang, and
 * only a worker can be killed.
 *
 * in  (workerData): { cases: [{ label, source, flags }], probes: [string] }
 * out (message)   : { results: [{ label, maxMs, total }] }  — or terminated.
 */

import { parentPort, workerData } from 'node:worker_threads';

const cases = Array.isArray(workerData?.cases) ? workerData.cases : [];
const probes = Array.isArray(workerData?.probes) ? workerData.probes : [];

const results = [];
for (const probeCase of cases) {
  let regex;
  try {
    regex = new RegExp(probeCase.source, probeCase.flags ?? '');
  } catch {
    results.push({ label: probeCase.label, maxMs: 0, total: 0, uncompilable: true });
    continue;
  }
  let maxMs = 0;
  let total = 0;
  for (const probe of probes) {
    const started = performance.now();
    try {
      regex.test(probe);
    } catch {
      /* a throwing match is the validator's problem, not the probe's */
    }
    const elapsed = performance.now() - started;
    if (elapsed > maxMs) maxMs = elapsed;
    total += elapsed;
  }
  results.push({ label: probeCase.label, maxMs, total, uncompilable: false });
}

parentPort.postMessage({ results });
