// CodexExec provider: fact-extraction/summary/consolidation LLM backend that
// shells out to the locally installed `codex` CLI (codex-cli >= 0.149 flags).
//
// Safety contract (no plugin/hook recursion, no workspace pollution):
//   --ephemeral            no session rollout written for the child
//   --ignore-user-config   user config.toml/plugins/hooks are not loaded
//                          (auth still resolves through CODEX_HOME)
//   --disable memories    disable built-in memory injection explicitly
//   --disable hooks       disable hook execution even if project config enables it
//   --disable plugins     disable plugin loading for the isolated child
//   --ignore-rules         no execpolicy rules loaded
//   --sandbox read-only    child cannot mutate the filesystem
//   --skip-git-repo-check  allows running inside the throwaway workdir
//   -C <mktemp workdir>    never touches the caller's repository
//   -o <file>              capture final agent message deterministically
// Model selection precedence: explicit option > MEMEX_CODEX_MODEL env >
// DEFAULT_CODEX_MODEL (gpt-5.6-luna). Never hardcode other ids here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** Set to '1' inside any codex exec child we spawn. Nested calls refuse. */
export const INNER_GUARD_ENV = 'MEMEX_CODEX_EXEC_INNER';
/** Official default memory-model id used when no override is provided. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
// A Codex JSONL stream includes tool events in addition to the final answer.
// Keep a bounded diagnostic/event buffer so a noisy or hostile child cannot
// turn one background model call into unbounded parent memory growth. The
// authoritative final answer is captured separately by -o.
const MAX_EVENT_CAPTURE_CHARS = 4 * 1024 * 1024;
const MAX_STDERR_CAPTURE_CHARS = 64 * 1024;
function appendBounded(current, chunk, limit) {
    if (current.length >= limit)
        return current;
    return current + chunk.toString().slice(0, Math.max(0, limit - current.length));
}
export function buildCodexPrompt(systemPrompt, userMessage) {
    return systemPrompt
        ? `${systemPrompt}\n\n---\n\n${userMessage}`
        : userMessage;
}
/** Pure arg builder — unit-tested without spawning anything. */
export function buildCodexExecArgs(opts) {
    const args = [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        '--disable', 'memories',
        '--disable', 'hooks',
        '--disable', 'plugins',
        '--ignore-rules',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '-C', opts.workdir,
    ];
    const model = opts.model != null
        ? opts.model
        : process.env.MEMEX_CODEX_MODEL || DEFAULT_CODEX_MODEL;
    const trimmed = model ? String(model).trim() : '';
    if (trimmed)
        args.push('-m', trimmed);
    if (opts.outputLast)
        args.push('-o', opts.outputLast);
    if (opts.outputSchemaPath)
        args.push('--output-schema', opts.outputSchemaPath);
    args.push('--json', '-'); // prompt via stdin
    return args;
}
/** Pull the last agent answer out of --json JSONL events (fallback path). */
export function lastAgentMessageFromEvents(stdout) {
    let last = '';
    for (const line of stdout.split('\n')) {
        if (!line.trim())
            continue;
        let j;
        try {
            j = JSON.parse(line);
        }
        catch {
            continue;
        }
        const p = j.payload || {};
        if (j.type === 'event_msg' && p.type === 'agent_message' && typeof p.message === 'string') {
            last = p.message;
        }
        else if (j.type === 'response_item' &&
            p.type === 'message' &&
            p.role === 'assistant') {
            const text = textFromContent(p.content);
            if (text)
                last = text;
        }
        else if (j.type === 'item.completed') {
            // Actual codex-cli 0.149 --json shape observed by AGY repro:
            // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
            const it = j.item;
            if (it && it.type === 'agent_message' && typeof it.text === 'string' && it.text.trim()) {
                last = it.text;
            }
        }
    }
    return last.trim();
}
/** Read the final Codex `turn.completed` token counters from a JSONL stream. */
export function tokenUsageFromEvents(stdout) {
    let usage = null;
    for (const line of stdout.split('\n')) {
        if (!line.trim())
            continue;
        let event;
        try {
            event = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (typeof event !== 'object' || event === null || Array.isArray(event))
            continue;
        const candidate = event;
        if (candidate.type !== 'turn.completed' ||
            typeof candidate.usage !== 'object' ||
            candidate.usage === null ||
            Array.isArray(candidate.usage)) {
            continue;
        }
        const raw = candidate.usage;
        if (typeof raw.input_tokens !== 'number' ||
            !Number.isFinite(raw.input_tokens) ||
            typeof raw.output_tokens !== 'number' ||
            !Number.isFinite(raw.output_tokens)) {
            continue;
        }
        usage = {
            input_tokens: raw.input_tokens,
            output_tokens: raw.output_tokens,
            ...(typeof raw.cached_input_tokens === 'number' &&
                Number.isFinite(raw.cached_input_tokens)
                ? { cached_input_tokens: raw.cached_input_tokens }
                : {}),
        };
    }
    return usage;
}
function textFromContent(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((c) => c && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n');
}
function runChild(bin, args, cwd, prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        const child = spawn(bin, args, {
            cwd,
            env: { ...process.env, [INNER_GUARD_ENV]: '1' },
            stdio: ['pipe', 'pipe', 'pipe'],
            // Own process group so an orphaned grandchild (e.g. `sleep`) cannot keep
            // our stdio pipes open and stall the close event past the timeout.
            detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            timedOut = true;
            if (child.pid != null && process.platform !== 'win32') {
                try {
                    process.kill(-child.pid, 'SIGKILL'); // whole group
                }
                catch {
                    child.kill('SIGKILL');
                }
            }
            else {
                child.kill('SIGKILL');
            }
        }, timeoutMs);
        child.on('error', (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.stdout?.on('data', (d) => {
            stdout = appendBounded(stdout, d, MAX_EVENT_CAPTURE_CHARS);
        });
        child.stderr?.on('data', (d) => {
            stderr = appendBounded(stderr, d, MAX_STDERR_CAPTURE_CHARS);
        });
        child.on('close', (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ code, signal, stdout, stderr, timedOut });
        });
        child.stdin.on('error', () => { });
        child.stdin.end(prompt);
    });
}
function assertLimit(value, name) {
    if (value === undefined)
        return undefined;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }
    return value;
}
function remainingDeadlineMs(deadlineAt) {
    if (deadlineAt == null)
        return null;
    const parsed = Date.parse(deadlineAt);
    if (!Number.isFinite(parsed))
        throw new Error('deadlineAt must be a valid ISO timestamp');
    return Math.max(0, parsed - Date.now());
}
/**
 * Keep this provider module usable by the plain-Node Codex slice. Node's
 * built-in type stripping can execute this `.ts` file directly, but it cannot
 * resolve a source-side `./model-budget.js` import before the TypeScript build
 * has emitted `dist/model-budget.js`. Budget limit errors are only needed on
 * bounded calls, so load the production module at that branch and preserve
 * the shared error class identity for compiled callers and tests.
 */
async function modelBudgetLimitError(kind, observed, limit) {
    const budget = await import('./model-budget.js');
    return kind === 'input'
        ? new budget.ModelBudgetInputLimitError(observed, limit)
        : new budget.ModelBudgetOutputLimitError(observed, limit);
}
/** Read only enough bytes to decide whether the final answer exceeds its
 * character bound. UTF-8 uses at most four bytes per code point, so this cap
 * avoids a large synchronous allocation while preserving the exact character
 * check for valid output under the configured limit. */
function readOutputFile(filePath, maxOutputChars) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    }
    catch {
        return { text: '', exceeded: false };
    }
    const charCap = maxOutputChars ?? MAX_EVENT_CAPTURE_CHARS;
    const byteCap = Math.min(MAX_EVENT_CAPTURE_CHARS * 4, Math.max(1, charCap * 4 + 4));
    const bytesToRead = Math.min(stat.size, byteCap + 1);
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(bytesToRead);
        const read = fs.readSync(fd, buffer, 0, bytesToRead, 0);
        const text = buffer.subarray(0, read).toString('utf8').trim();
        return {
            text,
            exceeded: stat.size > byteCap || text.length > charCap,
        };
    }
    finally {
        fs.closeSync(fd);
    }
}
/**
 * One-shot LLM call through the local codex CLI.
 * Returns the final agent message (non-empty guaranteed by callers' retry
 * policy in llm.ts callMemoryModel). Throws on spawn failure, timeout, or non-zero
 * exit with no recoverable answer.
 */
export async function runCodex(opts = {}) {
    if (process.env[INNER_GUARD_ENV] === '1') {
        throw new Error(`memex: ${INNER_GUARD_ENV}=1 — refusing nested codex exec (hook/plugin recursion guard)`);
    }
    const bin = opts.codexBin
        || process.env.MEMEX_CODEX_BIN
        || 'codex';
    const timeoutMs = opts.timeoutMs ?? 180_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        throw new Error('timeoutMs must be a non-negative finite number');
    }
    const maxInputChars = assertLimit(opts.maxInputChars, 'maxInputChars');
    const maxOutputChars = assertLimit(opts.maxOutputChars, 'maxOutputChars');
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-llm-'));
    const outPath = path.join(workdir, 'last-message.txt');
    const started = performance.now();
    let observed = false;
    const observe = (token_usage) => {
        if (observed)
            return;
        observed = true;
        try {
            opts.onObservation?.({
                duration_ms: performance.now() - started,
                token_usage,
            });
        }
        catch {
            // Telemetry is optional and must never change model-call behavior.
        }
    };
    try {
        const prompt = buildCodexPrompt(opts.systemPrompt || '', opts.userMessage || '');
        if (maxInputChars !== undefined && prompt.length > maxInputChars) {
            observe(null);
            throw await modelBudgetLimitError('input', prompt.length, maxInputChars);
        }
        const remaining = remainingDeadlineMs(opts.deadlineAt);
        if (remaining !== null && remaining <= 0) {
            observe(null);
            throw new Error('codex exec deadline exhausted before provider spawn');
        }
        const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remaining === null ? timeoutMs : remaining));
        const schemaPath = opts.outputSchema ? path.join(workdir, 'output-schema.json') : undefined;
        if (schemaPath)
            fs.writeFileSync(schemaPath, JSON.stringify(opts.outputSchema), { mode: 0o600 });
        const args = buildCodexExecArgs({ model: opts.model, workdir, outputLast: outPath, outputSchemaPath: schemaPath });
        const res = await runChild(bin, args, workdir, prompt, effectiveTimeoutMs);
        const tokenUsage = tokenUsageFromEvents(res.stdout);
        observe(tokenUsage);
        // A timeout/non-zero exit is a failed provider attempt even when the CLI
        // happened to flush a partial -o file. Returning that text would let
        // extraction or consolidation commit incomplete work as successful.
        if (res.timedOut) {
            throw new Error(`codex exec timed out after ${effectiveTimeoutMs}ms`);
        }
        if (res.code !== 0 && !opts.allowOutputOnNonzero) {
            throw new Error(`codex exec failed (code=${res.code}${res.signal ? ` signal=${res.signal}` : ''}): ${res.stderr.slice(-400)}`);
        }
        const output = readOutputFile(outPath, maxOutputChars);
        if (output.exceeded) {
            const observedChars = maxOutputChars === undefined
                ? output.text.length
                : Math.max(output.text.length, maxOutputChars + 1);
            throw await modelBudgetLimitError('output', observedChars, maxOutputChars ?? MAX_EVENT_CAPTURE_CHARS);
        }
        let text = output.text;
        if (!text)
            text = lastAgentMessageFromEvents(res.stdout);
        if (maxOutputChars !== undefined && text.length > maxOutputChars) {
            throw await modelBudgetLimitError('output', text.length, maxOutputChars);
        }
        if (!text && res.code !== 0) {
            throw new Error(`codex exec failed (code=${res.code}${res.signal ? ` signal=${res.signal}` : ''}): ${res.stderr.slice(-400)}`);
        }
        return text;
    }
    catch (error) {
        observe(null);
        throw error;
    }
    finally {
        try {
            fs.rmSync(workdir, { recursive: true, force: true });
        }
        catch {
            // Best effort cleanup; never mask the provider result.
        }
    }
}
