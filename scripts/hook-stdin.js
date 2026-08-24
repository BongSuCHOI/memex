// Defensive hook-stdin parsing + transcript stabilization helpers.
//
// Codex hook stdin carries snake_case keys (grounded in the codex-cli 0.149
// binary: hook_event_name, session_id, transcript_path, agent_transcript_path,
// cwd, prompt, turn_id). Accept camelCase and legacy aliases too — a missing
// or renamed key must degrade to "skip", never crash the session lifecycle.
import fs from 'node:fs';

function firstKey(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** Read all of stdin and defensively extract the keys we care about. */
export async function readHookStdin({ timeoutMs = 5_000 } = {}) {
  const chunks = [];
  let raw = '';
  try {
    const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs));
    const read = (async () => {
      for await (const c of process.stdin) chunks.push(c);
    })();
    await Promise.race([read, timer]);
    raw = Buffer.concat(chunks).toString('utf8').trim();
  } catch {
    raw = '';
  }
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null; // non-JSON stdin tolerated
    }
  }
  const obj = json && typeof json === 'object' ? json : {};
  return {
    raw,
    json,
    event: String(firstKey(obj, ['hook_event_name', 'event_name', 'event', 'hook_type']) ?? ''),
    sessionId: firstKey(obj, ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id']),
    transcriptPath: firstKey(obj, [
      'transcript_path',
      'transcriptPath',
      'agent_transcript_path',
      'agentTranscriptPath',
      'rollout_path',
      'rolloutPath',
    ]),
    prompt: firstKey(obj, ['prompt', 'user_prompt', 'userPrompt', 'message']),
    cwd: firstKey(obj, ['cwd', 'working_directory', 'workingDirectory']),
  };
}

/**
 * Wait until `filePath` exists and its size+mtime stay unchanged for
 * `quietMs`. Transient stat errors are retried. Resolves:
 *   'stable'  — file present and quiet
 *   'missing' — never appeared before maxWaitMs
 *   'timeout' — appeared but never went quiet before maxWaitMs
 */
export function waitForFileStable(filePath, { pollMs = 250, quietMs = 1500, maxWaitMs = 30000 } = {}) {
  return new Promise((resolve) => {
  const start = Date.now();
  let lastSize = -1;
  let lastMtimeMs = -1;
  let lastChange = Date.now();
  let seen = false;
  const tick = () => {
    let st = null;
    try {
      st = fs.statSync(filePath);
    } catch (err) {
      // ENOENT pre-appearance is normal; anything else may be transient
      // (EBUSY/EPERM during flush) — retry either way until budget ends.
      if (!(err && err.code === 'ENOENT')) {
        /* transient — fall through to scheduling logic */
      }
    }
    const now = Date.now();
    if (st && st.isFile()) {
      seen = true;
      if (st.size !== lastSize || st.mtimeMs !== lastMtimeMs) {
        lastSize = st.size;
        lastMtimeMs = st.mtimeMs;
        lastChange = now;
      } else if (now - lastChange >= quietMs) {
        resolve('stable');
        return;
      }
    }
    if (now - start >= maxWaitMs) {
      resolve(seen ? 'timeout' : 'missing');
      return;
    }
    setTimeout(tick, pollMs);
  };
  tick();
  });
}
