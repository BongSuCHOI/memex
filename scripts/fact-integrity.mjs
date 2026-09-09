#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { auditMemoryIntegrity, applyIntegrityRepairs } from '../dist/fact-integrity.js';

const [mode, dbPath, reportPath, selectionPath] = process.argv.slice(2);
if (!['audit', 'apply'].includes(mode) || !dbPath || !reportPath || (mode === 'apply' && !selectionPath)) {
  throw new Error('usage: fact-integrity.mjs audit DB NEW_REPORT | apply DB PREVIEW SELECTION_JSON');
}
const db = new Database(path.resolve(dbPath), { readonly: mode === 'audit', fileMustExist: true });
try {
  sqliteVec.load(db);
  db.pragma('foreign_keys = ON');
  if (mode === 'audit') {
    const report = db.transaction(() => auditMemoryIntegrity(db))();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const counts = {};
    for (const finding of report.findings) counts[finding.code] = (counts[finding.code] ?? 0) + 1;
    console.log(JSON.stringify({ planId: report.planId, factsExamined: report.factsExamined, counts,
      repairable: report.findings.filter(f => f.disposition === 'repairable').length }, null, 2));
  } else {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const selected = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
    if (!Array.isArray(selected) || !selected.every(id => typeof id === 'string')) throw new Error('selection must be an array of exact finding IDs');
    console.log(JSON.stringify(applyIntegrityRepairs(db, report, selected), null, 2));
  }
} finally { db.close(); }
