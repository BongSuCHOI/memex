import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LLM_WORKDIR_BASENAME } from './paths.js';
import { classifyLlmError, EmptyLlmResponseError } from './llm-error-class.js';
import { runCodex } from './codex-exec.js';
// Stable containment directory for LLM-side artifacts. CodexExec gives every
// call its own mkdtemp workdir and runs codex exec with --ephemeral +
// --ignore-user-config, so the child persists no session rollout and nothing
// accumulates here to prune.
const LLM_WORKDIR = path.join(os.tmpdir(), LLM_WORKDIR_BASENAME);
export function llmWorkdir() {
    try {
        fs.mkdirSync(LLM_WORKDIR, { recursive: true });
    }
    catch {
        /* fall through — caller cwd is an acceptable anchor */
    }
    return LLM_WORKDIR;
}
/** 재시도 횟수(= 총 시도 - 1). 0 이면 재시도 없음. 상한 5 — 무한 폭주 방지. */
function retryBudget() {
    const raw = process.env.MEMORY_BANK_LLM_RETRIES;
    if (raw != null && /^\d+$/.test(raw.trim()))
        return Math.min(5, parseInt(raw.trim(), 10));
    return 2; // 기본 총 3회 시도
}
/**
 * 지수 백오프(500ms → 1500ms …). 테스트는 MEMORY_BANK_LLM_RETRY_BASE_MS=0 으로 즉시.
 * base 와 결과 모두 상한을 둔다 — 오타 하나(예: 500000)로 워커가 사실상 정지하는
 * 것을 막기 위해서다 (Codex 리뷰 MEDIUM 2026-07-17).
 */
const MAX_BACKOFF_BASE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
function backoffMs(attempt) {
    const raw = process.env.MEMORY_BANK_LLM_RETRY_BASE_MS;
    const parsed = raw != null && /^\d+$/.test(raw.trim()) ? parseInt(raw.trim(), 10) : 500;
    const base = Math.min(parsed, MAX_BACKOFF_BASE_MS);
    return Math.min(base * Math.pow(3, attempt), MAX_BACKOFF_MS);
}
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
/**
 * One-shot LLM call through the local Codex CLI (CodexExec provider).
 * maxTokens kept for signature compatibility; the CLI manages its own budget.
 * Model resolution (extraction path only): MEMORY_BANK_CODEX_MODEL, else
 * legacy MEMORY_BANK_FACT_MODEL — then codex-exec's central default
 * (DEFAULT_CODEX_MODEL = gpt-5.6-luna) applies when neither is set.
 * The resolved id is always forwarded via -m.
 */
async function callOnce(systemPrompt, userMessage, _maxTokens) {
    const model = process.env.MEMORY_BANK_CODEX_MODEL || process.env.MEMORY_BANK_FACT_MODEL || null;
    const timeoutRaw = process.env.MEMORY_BANK_CODEX_EXEC_TIMEOUT_MS;
    const timeoutMs = timeoutRaw != null && /^\d+$/.test(timeoutRaw.trim()) ? parseInt(timeoutRaw.trim(), 10) : 180_000;
    return runCodex({ systemPrompt, userMessage, model, timeoutMs });
}
/**
 * One LLM call through the local Codex CLI (CodexExec) — authenticated by the
 * user's local Codex login; no API key involved.
 *
 * 복구 계약 (2026-07-17 — 사용자 피드백 "에러나거나 0바이트인데 재시도·복구가 없다"):
 *  - **빈 응답('')도 실패**다. 모든 호출자가 JSON 을 요구하므로 빈 본문은 유효한 답이
 *    될 수 없는데, 예전엔 '' 를 반환해 호출자가 "정상적으로 아무것도 없음"으로 소비했다
 *    (consolidator 는 verdict 'none' 으로 확정+예산 소모, fact-extractor 는 배치를 조용히
 *    버리고 세션을 extraction_log 에 완료 기록 → 그 대화의 fact 영구 손실).
 *  - transient(빈 응답·429/5xx/네트워크/타임아웃)와 unknown 은 **유한 재시도**(기본 2회,
 *    지수 백오프)로 일회성 flake 를 흡수한다. 같은 파일 계열의 임베딩 경로는 이미
 *    probe+재시도로 flake 를 흡수하고 있었고(ontology-classifier), LLM 경로만 없었다.
 *  - deterministic(400/413/max_tokens 등 이 요청 자체가 잘못됨)은 **재시도하지 않는다** —
 *    같은 입력은 같은 결과이고 재시도는 예산 낭비다.
 *  - 재시도를 소진하면 '' 가 아니라 **throw** 한다. 그래야 호출자의 3분류(transient 는
 *    보류·재시도, deterministic 은 attempt 소모)가 비로소 작동한다 (fail-loud).
 * 호출자 계약: 성공 반환값은 **비어있지 않음이 보장**된다.
 */
export async function callMemoryModel(systemPrompt, userMessage, maxTokens = 2048) {
    const retries = retryBudget();
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const text = await callOnce(systemPrompt, userMessage, maxTokens);
            if (text && text.trim() !== '')
                return text;
            lastError = new EmptyLlmResponseError(`LLM returned an empty response (attempt ${attempt + 1}/${retries + 1})`);
        }
        catch (error) {
            lastError = error;
            // 이 요청 자체가 잘못된 경우는 재시도해도 동일 — 즉시 표면화.
            if (classifyLlmError(error) === 'deterministic')
                throw error;
        }
        if (attempt < retries) {
            console.error(`callMemoryModel: attempt ${attempt + 1}/${retries + 1} failed (${lastError instanceof Error ? lastError.message : lastError}) — retrying`);
            await sleep(backoffMs(attempt));
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
export function parseJsonResponse(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/)
        || text.match(/(\[[\s\S]*\])/)
        || text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
        console.error('parseJsonResponse: no JSON found in LLM response:', text.substring(0, 200));
        return null;
    }
    try {
        return JSON.parse(jsonMatch[1]);
    }
    catch (e) {
        console.error('parseJsonResponse: invalid JSON:', e.message, jsonMatch[1].substring(0, 200));
        return null;
    }
}
