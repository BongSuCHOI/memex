// CodexExec provider: fact-extraction/summary/consolidation LLM backend that
// shells out to the locally installed `codex` CLI (codex-cli >= 0.149 flags).
//
// Safety contract (no plugin/hook recursion, no workspace pollution):
//   --ephemeral            no session rollout written for the child
//   --ignore-user-config   user config.toml/plugins/hooks are not loaded
//                          (auth still resolves through CODEX_HOME)
//   --ignore-rules         no execpolicy rules loaded
//   --sandbox read-only    child cannot mutate the filesystem
//   --skip-git-repo-check  allows running inside the throwaway workdir
//   -C <mktemp workdir>    never touches the caller's repository
//   -o <file>              capture final agent message deterministically
// Model selection precedence: explicit option > MEMORY_BANK_CODEX_MODEL env
// > DEFAULT_CODEX_MODEL (gpt-5.6-luna). Never hardcode other ids here.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/** Set to '1' inside any codex exec child we spawn. Nested calls refuse. */
export const INNER_GUARD_ENV = 'MEMORY_BANK_CODEX_EXEC_INNER';
/** Official default memory-model id used when no override is provided. */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
function buildPrompt(systemPrompt, userMessage) {
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
        '--ignore-rules',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '-C', opts.workdir,
    ];
    const model = opts.model != null ? opts.model : process.env.MEMORY_BANK_CODEX_MODEL || DEFAULT_CODEX_MODEL;
    const trimmed = model ? String(model).trim() : '';
    if (trimmed)
        args.push('-m', trimmed);
    if (opts.outputLast)
        args.push('-o', opts.outputLast);
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
            stdout += d.toString();
        });
        child.stderr?.on('data', (d) => {
            stderr += d.toString();
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
    const bin = opts.codexBin || process.env.MEMORY_BANK_CODEX_BIN || 'codex';
    const timeoutMs = opts.timeoutMs ?? 180_000;
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-bank-llm-'));
    const outPath = path.join(workdir, 'last-message.txt');
    try {
        const prompt = buildPrompt(opts.systemPrompt || '', opts.userMessage || '');
        const args = buildCodexExecArgs({ model: opts.model, workdir, outputLast: outPath });
        const res = await runChild(bin, args, workdir, prompt, timeoutMs);
        let text = '';
        try {
            text = fs.readFileSync(outPath, 'utf8').trim();
        }
        catch {
            /* -o file absent (old CLI?) — fall through to event parsing */
        }
        if (!text)
            text = lastAgentMessageFromEvents(res.stdout);
        if (!text && res.timedOut)
            throw new Error(`codex exec timed out after ${timeoutMs}ms`);
        if (!text && res.code !== 0) {
            throw new Error(`codex exec failed (code=${res.code}${res.signal ? ` signal=${res.signal}` : ''}): ${res.stderr.slice(-400)}`);
        }
        return text;
    }
    finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
}
