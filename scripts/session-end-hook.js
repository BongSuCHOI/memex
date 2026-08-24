#!/usr/bin/env node
// SessionEnd hook: stabilize the transcript, run fact extraction to
// completion, then export.
//
// Contract (head gates):
//  - transcript stabilization: wait until size+mtime are quiet before parsing,
//    bounded wait via waitForFileStable.
//  - empty/subagent guard: sessions with zero exchanges, and subagent threads,
//    never reach the extractor — so no completion marker can exist for them.
//  - synchronous extraction: the worker runs in FOREGROUND and we require
//    exit-0 + non-empty stdout as completion evidence BEFORE the export step;
//    anything else logs loudly, writes NO marker, and skips export.
//  - stdin keys are read defensively (see hook-stdin.js).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHookStdin, waitForFileStable } from './hook-stdin.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MEMORY_BANK_PLUGIN_ROOT
  ? path.resolve(process.env.MEMORY_BANK_PLUGIN_ROOT)
  : path.resolve(HERE, '..');

function runNode(script, { input = '', env = {}, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Load the rollout parser from the built bundle, falling back to TS sources. */
async function loadRolloutModule() {
  const candidates = [
    path.join(ROOT, 'dist', 'codex-rollout.js'),
    path.join(ROOT, 'src', 'codex-rollout.ts'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      return await import(p);
    } catch (e) {
      console.error(`[session-end-hook] failed to load ${p}: ${e && e.message}`);
    }
  }
  return null;
}

async function main() {
  const hook = await readHookStdin();
  const tp = hook.transcriptPath ? String(hook.transcriptPath) : '';

  if (!tp) {
    // No transcript pointer in stdin — nothing to extract. Not a completion.
    console.error('[session-end-hook] no transcript_path in hook stdin; skipping extraction');
    return;
  }

  const stability = await waitForFileStable(tp, {
    pollMs: Number(process.env.MEMORY_BANK_STABILIZE_POLL_MS || 250),
    quietMs: Number(process.env.MEMORY_BANK_STABILIZE_QUIET_MS || 1500),
    maxWaitMs: Number(process.env.MEMORY_BANK_STABILIZE_MAX_WAIT_MS || 30000),
  });
  if (stability !== 'stable') {
    console.error(`[session-end-hook] transcript not stable (${stability}); refusing to mark completion`);
    return;
  }

  // Empty / subagent guard: parse before spawning any LLM work.
  const rolloutMod = await loadRolloutModule();
  let projectCwd = hook.cwd ? String(hook.cwd) : '';
  if (rolloutMod && rolloutMod.parseRolloutStream) {
    try {
      const stream = fs.createReadStream(tp);
      const parsed = await rolloutMod.parseRolloutStream(stream, { archivePath: tp });
      stream.close?.();
      if (parsed.isSubagent) {
        console.error('[session-end-hook] subagent thread — skipping extraction (no marker)');
        return;
      }
      const count = parsed.exchanges.length;
      if (count === 0) {
        console.error('[session-end-hook] empty rollout (0 exchanges) — skipping worker; no completion marker');
        return;
      }
      const cwd = parsed.meta && typeof parsed.meta.cwd === 'string' ? parsed.meta.cwd : '';
      if (cwd) projectCwd = cwd;
    } catch (e) {
      // Unreadable/partial transcript: treat as not-ready rather than done.
      console.error(`[session-end-hook] transcript parse failed (${e && e.message}); no marker written`);
      return;
    }
  } else {
    console.error('[session-end-hook] rollout parser unavailable — cannot prove non-empty session; skipping worker');
    return;
  }
  // Extraction — SYNCHRONOUS foreground run of the real worker so completion
  // is observable here (the old hook only queued a detached pid).
  const extract = await runNode(path.join(ROOT, 'scripts', 'fact-extract-worker.js'), {
    env: { SESSION_ID: hook.sessionId || '', CWD: projectCwd, MB_TRANSCRIPT_PATH: tp },
    timeoutMs: Number(process.env.MEMORY_BANK_EXTRACT_TIMEOUT_MS || 600000),
  });
  // The real worker exits 0 even for ERROR/FATAL/SKIPPED outcomes, so exit
  // code alone is not evidence. Require the canonical success line AND the
  // absence of blocking tokens.
  const out = extract.stdout;
  const successLine = /worker: session=\S+ extracted=\d+ saved=\d+/.test(out);
  const blockedToken = /\b(ERROR|FATAL|SKIPPED)\b/.test(out);
  const evidence = extract.code === 0 && successLine && !blockedToken;
  if (!evidence) {
    console.error(
      `[session-end-hook] extraction produced no completion evidence (code=${extract.code}, stdout=${extract.stdout.trim().length}B) — no completion marker written`,
    );
    if (extract.stderr.trim()) process.stderr.write(extract.stderr);
    return;
  }

  // Export/sync-out strictly AFTER successful extraction.
  await runNode(path.join(ROOT, 'scripts', 'sync-export-hook.js'), {
    env: { SESSION_ID: hook.sessionId || '', CWD: projectCwd },
    timeoutMs: 120000,
  });
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('[session-end-hook] fatal:', err && err.stack ? err.stack : err);
    process.exit(0); // never wedge the session lifecycle on our account
  },
);
