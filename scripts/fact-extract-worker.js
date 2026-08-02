#!/usr/bin/env node

/**
 * Detached worker spawned by fact-extract-hook.js.
 *
 * Environment:
 *   SESSION_ID - session to extract facts from (required)
 *   CWD        - project path used for fact scoping (canonical: absolute path)
 *
 * Logs to <index-dir>/fact-extract.log so extraction is observable
 * (the parent hook runs with stdio ignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { initDatabase } from '../dist/db.js';
import { runFactExtraction, classifyExtractionFailure, FAILURE_REPORT } from '../dist/fact-extractor.js';
import { getIndexDir } from '../dist/paths.js';

function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}`;
  try {
    fs.appendFileSync(path.join(getIndexDir(), 'fact-extract.log'), msg + '\n');
  } catch {
    // best-effort logging
  }
  console.log(msg);
}

async function main() {
  const sessionId = process.env.SESSION_ID;
  const project = process.env.CWD || process.cwd();

  if (!sessionId) {
    log('worker: SESSION_ID not set, exiting');
    process.exit(0);
  }

  log(`worker: extracting session=${sessionId} project=${project}`);

  let db;
  try {
    db = initDatabase();
    const result = await runFactExtraction(db, sessionId, project);
    log(`worker: session=${sessionId} extracted=${result.extracted} saved=${result.saved}`);
  } catch (error) {
    // 이양(handoff)은 실패가 아니다 — 다른 러너가 같은 세션을 인수한 정상 경로다.
    const cls = classifyExtractionFailure(error);
    const rep = FAILURE_REPORT[cls];
    log(
      `worker: ${rep.label} (${cls}) session=${sessionId}: `
      + `${error instanceof Error ? error.message : error} — ${rep.note}`,
    );
    process.exitCode = 0; // extraction failure must never surface as hook failure
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

main();
