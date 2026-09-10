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
//   -c model_reasoning_effort=<effort>   Memex's own reasoning level (#31)
// Selection precedence (model AND reasoning effort): explicit option >
// MEMEX_CODEX_MODEL / MEMEX_CODEX_REASONING env > <data root>/models.json >
// core default (DEFAULT_CODEX_MODEL / no flag). This module is the SINGLE
// interpretation point, so the callers that bypass llm.ts (summarizer.ts,
// scripts/translate-facts.mjs) follow automatically. Never hardcode other ids.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** Set to '1' inside any codex exec child we spawn. Nested calls refuse. */
export const INNER_GUARD_ENV = 'MEMEX_CODEX_EXEC_INNER';
/**
 * Official default memory-model id used when no override is provided.
 *
 * The constant itself lives in `./model-settings.ts` so the resolver chain has
 * exactly one bottom; this name is kept for existing callers and tests.
 * Duplicated as a literal rather than imported for the reason explained at
 * `loadSelectionResolvers` below: this module must stay loadable from source.
 */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
/**
 * A provider rejection of the request ENVELOPE — the model id or the reasoning
 * level, not the content. Measured 2026-09-11: codex-cli answers such a request
 * with exit 0, an EMPTY `-o` file, and a 400 inside the `--json` stream, which
 * is indistinguishable from "the model said nothing" unless the stream is read.
 *
 * This is its own error class because no consumer should treat it like a bad
 * request: the conversation did nothing wrong, so its extraction must not be
 * split, failed, parked, or dead-lettered. See llm-error-class's `'config'`.
 */
export class CodexRequestRejectedError extends Error {
    name = 'CodexRequestRejectedError';
    code = 'MEMEX_MODEL_CONFIG';
    detail;
    constructor(detail) {
        super(`codex exec rejected the request envelope for model "${detail.model}"` +
            (detail.reasoningEffort ? ` at reasoning effort "${detail.reasoningEffort}"` : '') +
            ` (${detail.status ?? '?'} ${detail.providerType ?? 'provider error'}): ${detail.providerMessage}`);
        this.detail = detail;
    }
}
/** Design-document name for the class above; both refer to one identity. */
export { CodexRequestRejectedError as MemexModelConfigError };
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
let selectionResolvers = null;
let selectionResolversUnavailable = false;
export async function loadSelectionResolvers() {
    if (selectionResolvers || selectionResolversUnavailable)
        return;
    try {
        const mod = await import('./model-settings.js');
        selectionResolvers = {
            resolveLlmModel: () => mod.resolveLlmModel(),
            resolveReasoningEffort: () => mod.resolveReasoningEffort(),
        };
    }
    catch {
        selectionResolversUnavailable = true;
    }
}
/** Resolved selection this process would use right now, for the arg builder and
 *  for the attempt ledger's "what did we actually send" record. */
export async function resolveCodexSelection(opts = {}) {
    await loadSelectionResolvers();
    return currentSelection(opts);
}
function currentSelection(opts) {
    const model = opts.model != null && String(opts.model).trim()
        ? String(opts.model).trim()
        : selectionResolvers
            ? selectionResolvers.resolveLlmModel().value
            : process.env.MEMEX_CODEX_MODEL?.trim() || DEFAULT_CODEX_MODEL;
    const reasoningEffort = opts.reasoningEffort !== undefined
        ? (opts.reasoningEffort == null ? null : String(opts.reasoningEffort).trim() || null)
        : selectionResolvers
            ? selectionResolvers.resolveReasoningEffort().value
            : process.env.MEMEX_CODEX_REASONING?.trim() || null;
    return { model, reasoningEffort };
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
    const selection = currentSelection(opts);
    if (selection.model)
        args.push('-m', selection.model);
    // `--ignore-user-config` and `-c` coexist (measured): `-c` is the CLI override
    // layer, not the user's config.toml. So the user's own
    // `model_reasoning_effort` still cannot reach Memex — that isolation is
    // intentional — and this gives Memex its own setting instead.
    //
    // The value is parsed as TOML by the CLI. Anything outside `[a-z]+` would be
    // a syntax hazard rather than a level, so the flag is omitted and the call
    // proceeds: a malformed setting must not kill the model call.
    if (selection.reasoningEffort) {
        if (/^[a-z]+$/.test(selection.reasoningEffort)) {
            args.push('-c', `model_reasoning_effort=${selection.reasoningEffort}`);
        }
        else {
            console.error(`[memex] ignoring reasoning effort ${JSON.stringify(selection.reasoningEffort)} — ` +
                'expected lowercase letters only');
        }
    }
    if (opts.outputLast)
        args.push('-o', opts.outputLast);
    if (opts.outputSchemaPath)
        args.push('--output-schema', opts.outputSchemaPath);
    args.push('--json', '-'); // prompt via stdin
    return args;
}
/**
 * Pull the provider's turn-level failure out of a `--json` stream.
 *
 * Measured shapes: `{"type":"error","message":"<provider body>"}` followed by
 * `{"type":"turn.failed","error":{...}}`. The status and the error type live
 * INSIDE the message text (the CLI passes the provider body through), so they
 * are sniffed rather than read from a field. Last failure wins.
 */
export function turnErrorFromEvents(stdout) {
    // An `error` event carries the provider's own body; the `turn.failed` that
    // follows it usually says only "the turn failed". Ranking them keeps the
    // specific diagnosis from being overwritten by the generic epitaph.
    let fromErrorEvent = null;
    let fromTurnFailed = null;
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
        if (!event || typeof event !== 'object')
            continue;
        let raw;
        if (event.type === 'error') {
            raw = event.message;
        }
        else if (event.type === 'turn.failed') {
            const inner = event.error;
            raw = inner && typeof inner === 'object' && !Array.isArray(inner)
                ? inner.message ?? JSON.stringify(inner)
                : inner;
        }
        else {
            continue;
        }
        const text = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
        if (!text.trim())
            continue;
        if (event.type === 'error')
            fromErrorEvent = text;
        else
            fromTurnFailed = text;
    }
    const message = fromErrorEvent ?? fromTurnFailed;
    if (message === null)
        return null;
    return { message, status: statusFromText(message), type: errorTypeFromText(message) };
}
/** Status numbers are read only where they are LABELLED. A bare number in a
 *  provider sentence ("retry after 400 ms") is never a status — the same rule
 *  llm-error-class.ts applies, for the same reason. */
function statusFromText(text) {
    const labelled = text.match(/(?:"?status(?:_code)?"?\s*[:=]\s*|status\s+|error\s+code:?\s*|\bhttp\s+)(\d{3})\b/i);
    if (labelled)
        return Number.parseInt(labelled[1], 10);
    return null;
}
function errorTypeFromText(text) {
    const match = text.match(/"type"\s*:\s*"([a-z_]+)"/i) ?? text.match(/\b(invalid_request_error)\b/i);
    return match ? match[1] : null;
}
/**
 * Narrow, deliberately conservative: is this turn error a rejection of the
 * request ENVELOPE rather than of the request's content?
 *
 * Risk R2 runs the other way. Widening this predicate would route a real
 * input-too-large 400 into the config lane, where the extraction window is
 * never split — so a long conversation would be held forever instead of
 * recovered. When in doubt, leave it `deterministic`.
 */
const ENVELOPE_REJECTION_RE = /\[reasoning\.effort\]|reasoning_effort|model is not supported|unknown model|model_not_found|model is not available/i;
export function isEnvelopeRejection(error) {
    if (!error)
        return false;
    if (error.status !== 400)
        return false;
    // `invalid_request_error` when the provider names a type; a measured model-id
    // rejection carries no type at all, so an absent one is allowed — the regex
    // below is what keeps the predicate narrow.
    if (error.type !== null && error.type !== 'invalid_request_error')
        return false;
    return ENVELOPE_REJECTION_RE.test(error.message);
}
/** Strip control characters and bound the provider's own sentence before it
 *  reaches a durable row or a terminal line. */
export function sanitizeProviderMessage(message, limit = 400) {
    return message
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
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
    // Resolve the selection ONCE per call, before anything can observe or fail:
    // the arg builder, the telemetry line and a possible envelope rejection must
    // all name the same model and effort.
    const selection = await resolveCodexSelection({
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
    });
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
                model: selection.model,
                reasoning_effort: selection.reasoningEffort,
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
        const args = buildCodexExecArgs({
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            workdir,
            outputLast: outPath,
            outputSchemaPath: schemaPath,
        });
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
        // #31: an envelope rejection arrives here as exit 0 + no body. Without this
        // branch it became an empty response — "transient" — and the same bad model
        // id was retried three times per call, forever.
        if (!text) {
            const turnError = turnErrorFromEvents(res.stdout);
            if (isEnvelopeRejection(turnError)) {
                throw new CodexRequestRejectedError({
                    status: turnError.status,
                    providerType: turnError.type,
                    providerMessage: sanitizeProviderMessage(turnError.message),
                    model: selection.model,
                    reasoningEffort: selection.reasoningEffort,
                });
            }
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
