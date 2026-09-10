/**
 * `memex models show|set|reset|test` — the operator surface for the LLM
 * selection (#31, 0.7.0).
 *
 * Four verbs, and the split between them is the whole design:
 *
 *  - `show` is read-only and never opens a writable database. It answers the
 *    question a user actually has when model work has stopped: *what* is
 *    selected, *where* that came from (env > `models.json` > the built-in
 *    default), what this Codex installation says the model accepts, and whether
 *    a durable config hold is currently fencing the calls.
 *  - `set` writes `models.json` and refuses bad input instead of normalizing it.
 *    A settings write is the one place where silence is worse than an error: a
 *    typo that is quietly dropped becomes a mystery hold an hour later.
 *  - `reset` deletes the file. It deletes a PROPOSAL — never an effective value,
 *    and never a vector: the embedding identity lives in the database.
 *  - `test` is the only thing that can prove a model id at all. A bogus id and a
 *    bogus reasoning level both come back from Codex as exit 0 with an empty
 *    body and a 400 inside the JSONL stream, so the catalog can only report what
 *    it last knew. One real call is the proof, and a successful one is also the
 *    repair: it closes the hold and releases the jobs waiting on it.
 *
 * The hold surfaces this command exposes are READ paths into lane B's API
 * (`listModelConfigHolds`, `heldJobSummary`); the transitions stay there.
 */
import fs from 'node:fs';
import { codexHome, findCatalogModel, listableModels, readCodexCatalog, reasoningEffortsForModel, } from './codex-catalog.js';
import { ALLOWED_REASONING_EFFORTS, DEFAULT_LLM_MODEL, LLM_MODEL_ENV, LLM_REASONING_ENV, isValidModelId, modelSettingsPath, normalizeReasoningEffort, readModelSettings, resetModelSettings, resolveLlmSelection, writeModelSettings, } from './model-settings.js';
import { EMBEDDING_MODEL, embeddingCacheStatus, formatCacheBytes, } from './model-cache.js';
import { getDbPath } from './paths.js';
const MODELS_USAGE = `Usage:
  memex models show [--json]
  memex models set --model <id> [--reasoning <level>] [--json]
  memex models set --reasoning <level> [--json]
  memex models reset [--json]
  memex models test [--model <id>] [--reasoning <level>] [--timeout-ms <n>] [--json]

Choose the model and reasoning effort Memex uses for its own model work. The
selection is LOCAL to this machine: '<data root>/models.json' is never synced,
because the set of usable models differs per device.

Resolution order (highest wins):
  an explicit per-call option  >  ${LLM_MODEL_ENV} / ${LLM_REASONING_ENV}
  >  models.json  >  the built-in default (${DEFAULT_LLM_MODEL}, no reasoning flag)

show    Read-only. Current selection and its source, the reasoning levels this
        Codex installation says the model accepts, the last test call, and any
        active configuration hold.
set     Write models.json. --reasoning must be one of
        ${ALLOWED_REASONING_EFFORTS.join('|')}.
        A level the catalog does not list is a warning, not a refusal: the
        catalog can be stale. A model id is checked for shape only.
reset   Delete models.json. Every LLM value returns to the built-in default.
        The effective EMBEDDING model is not affected — the database owns it.
test    Make exactly one real model call ("reply with MEMEX_OK") and report what
        the provider said. Recorded in the model-work ledger as stage
        'model_probe'. A success clears the configuration hold for that
        selection and releases the jobs waiting on it. Exits non-zero when the
        call does not succeed.

Options:
  --model <id>        Model id (1-256 chars matching [\\w./:@+-])
  --reasoning <level> ${ALLOWED_REASONING_EFFORTS.join(' | ')}
  --timeout-ms <n>    'test' only: provider timeout (default 60000)
  --json              Machine-readable output
  --help, -h          Show this help`;
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
    console.log(MODELS_USAGE);
    process.exit(0);
}
const MODELS_SUBCOMMANDS = new Set(['show', 'set', 'reset', 'test']);
const subcommand = args[0] && !args[0].startsWith('-') ? args[0] : 'show';
if (!MODELS_SUBCOMMANDS.has(subcommand)) {
    console.error(`Unknown 'memex models' subcommand: ${subcommand}\n` +
        `Expected one of: ${[...MODELS_SUBCOMMANDS].join(', ')}\n\n${MODELS_USAGE}`);
    process.exit(1);
}
const json = args.includes('--json');
/** Value after a flag, when the flag was given with one. A bare flag is an error
 *  rather than a silent default — `--model` with no id must not save nothing. */
function valueAfter(flag) {
    const index = args.indexOf(flag);
    if (index < 0)
        return undefined;
    const next = args[index + 1];
    if (!next || next.startsWith('-'))
        throw new Error(`${flag} needs a value`);
    return next;
}
function emit(payload, text) {
    if (json)
        console.log(JSON.stringify(payload, null, 2));
    else
        console.log(text);
}
function sourceLabel(source) {
    switch (source) {
        case 'env':
            return 'environment';
        case 'file':
            return 'models.json';
        case 'explicit':
            return 'command line';
        default:
            return 'built-in default';
    }
}
function envValue(name) {
    const raw = process.env[name];
    return typeof raw === 'string' && raw.trim() ? raw : null;
}
function envReport() {
    return {
        [LLM_MODEL_ENV]: envValue(LLM_MODEL_ENV),
        [LLM_REASONING_ENV]: envValue(LLM_REASONING_ENV),
        MEMEX_EMBEDDING_MODEL: envValue('MEMEX_EMBEDDING_MODEL'),
        MEMEX_EMBEDDING_DIMS: envValue('MEMEX_EMBEDDING_DIMS'),
    };
}
function catalogReport(catalog) {
    return {
        source: catalog.source,
        path: catalog.path,
        fetchedAt: catalog.fetchedAt,
        codexHome: codexHome(),
        models: catalog.models.map((model) => ({
            slug: model.slug,
            visible: model.visible,
            reasoningEfforts: model.reasoningEfforts,
        })),
    };
}
/**
 * Embedding section — deliberately READ-ONLY in 0.7.0.
 *
 * 0.7.1 makes the database the authority (`embedding_identity`) and adds dims,
 * version, generation and protocol here. Until then the honest answer is the
 * resolved model name plus whether its weights are on this machine; claiming a
 * dimension we have not measured would be the one thing this section must not
 * do.
 */
function embeddingReport() {
    const cache = embeddingCacheStatus();
    return {
        readOnly: true,
        model: EMBEDDING_MODEL,
        source: envValue('MEMEX_EMBEDDING_MODEL') ? 'env' : 'default',
        cache: {
            present: cache.present,
            files: cache.files,
            bytes: cache.bytes,
            modelDir: cache.modelDir,
            stub: cache.stub,
        },
    };
}
/**
 * Everything `show` needs from the database, read-only, in one open/close.
 *
 * A missing database is a normal state (a fresh install), not an error — the
 * selection is still answerable from the file and the environment.
 */
async function readDbFacts(fingerprint) {
    const dbPath = getDbPath();
    const empty = { dbPath, exists: false, holds: [], heldJobs: [], lastProbe: null };
    if (!fs.existsSync(dbPath))
        return empty;
    const { openReadDb } = await import('./db.js');
    const { listModelConfigHolds, heldJobSummary } = await import('./model-budget.js');
    const { MODEL_PROBE_STAGE } = await import('./model-settings-probe.js');
    const db = openReadDb(dbPath);
    try {
        const holds = listModelConfigHolds(db, fingerprint);
        const heldJobs = heldJobSummary(db).map((row) => ({
            reason: row.reason,
            jobs: row.jobs,
            oldestHeldAt: row.oldestHeldAt,
        }));
        let lastProbe = null;
        const tableExists = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_work_attempts'")
            .get() !== undefined;
        if (tableExists) {
            const row = db.prepare(`
        SELECT state, started_at, finished_at, duration_ms, model, reasoning_effort, error_class
        FROM model_work_attempts
        WHERE stage = ?
        ORDER BY started_at DESC, attempt_id DESC
        LIMIT 1
      `).get(MODEL_PROBE_STAGE);
            if (row) {
                lastProbe = {
                    ok: row.state === 'completed',
                    at: row.finished_at ?? row.started_at,
                    latencyMs: row.duration_ms,
                    model: row.model,
                    reasoning: row.reasoning_effort,
                    errorClass: row.error_class,
                };
            }
        }
        return { dbPath, exists: true, holds, heldJobs, lastProbe };
    }
    finally {
        db.close();
    }
}
function formatHold(hold, indent) {
    const lines = [];
    lines.push(`${hold.current ? 'HELD' : 'held (another selection)'} — the provider rejected the request envelope`);
    const status = `${hold.status ?? '?'} ${hold.providerType ?? 'provider error'}`;
    lines.push(`${indent}${status}: "${hold.providerMessage}"`);
    lines.push(`${indent}model ${hold.model}${hold.reasoningEffort ? ` / ${hold.reasoningEffort}` : ''} · ` +
        `first seen ${hold.heldAt} · observed ${hold.observedCount}x`);
    if (hold.current) {
        lines.push(`${indent}Model work is paused. No job was failed and no attempt was consumed.`);
        lines.push(`${indent}Fix the selection and it resumes automatically:`);
        lines.push(`${indent}  memex models set --model <id>`);
        lines.push(`${indent}  memex models test`);
    }
    return lines;
}
function pad(label) {
    return label.padEnd(12, ' ');
}
async function runShow() {
    const settings = readModelSettings();
    const selection = resolveLlmSelection();
    const catalog = readCodexCatalog();
    const catalogLevels = reasoningEffortsForModel(selection.model, catalog);
    const facts = await readDbFacts(selection.fingerprint);
    const embedding = embeddingReport();
    const currentHold = facts.holds.find((hold) => hold.current) ?? null;
    const payload = {
        settingsPath: modelSettingsPath(),
        settingsFileExists: fs.existsSync(modelSettingsPath()),
        version: settings.version,
        updatedAt: settings.updatedAt,
        dbPath: facts.dbPath,
        llm: {
            model: { value: selection.model, source: selection.modelSource },
            reasoning: { value: selection.reasoning, source: selection.reasoningSource },
            defaults: { model: DEFAULT_LLM_MODEL, reasoning: null },
            fingerprint: selection.fingerprint,
            catalogReasoning: catalogLevels,
            catalog: catalogReport(catalog),
            lastProbe: facts.lastProbe,
            hold: currentHold,
            holds: facts.holds,
            heldJobs: facts.heldJobs,
        },
        embedding,
        env: envReport(),
    };
    const lines = [];
    lines.push('LLM');
    lines.push(`  ${pad('model')}${selection.model}   (${sourceLabel(selection.modelSource)})`);
    lines.push(`  ${pad('reasoning')}${selection.reasoning ?? '(no flag)'}   (${sourceLabel(selection.reasoningSource)})`);
    lines.push(`  ${pad('default')}${DEFAULT_LLM_MODEL} / (no reasoning flag)`);
    if (catalog.source === 'none') {
        lines.push(`  ${pad('catalog')}not found in this Codex installation (${codexHome()})`);
        lines.push(`  ${' '.repeat(12)}any id is accepted and verified by the first call: memex models test`);
    }
    else {
        const listable = listableModels(catalog);
        lines.push(`  ${pad('catalog')}${catalog.models.length} model(s) — ${catalog.path}` +
            (catalog.fetchedAt ? ` (fetched ${catalog.fetchedAt})` : ''));
        if (listable.length > 0) {
            lines.push(`  ${' '.repeat(12)}${listable.map((model) => model.slug).join(' · ')}`);
        }
    }
    lines.push(`  ${pad('levels')}${catalogLevels
        ? `${selection.model} accepts ${catalogLevels.join('/')}`
        : `this installation says nothing about ${selection.model}`}`);
    lines.push(`  ${pad('last test')}${facts.lastProbe
        ? `${facts.lastProbe.ok ? 'ok' : `failed (${facts.lastProbe.errorClass ?? 'unknown'})`}, ` +
            `${facts.lastProbe.latencyMs ?? '?'}ms, ${facts.lastProbe.at}`
        : 'never run — memex models test'}`);
    if (facts.holds.length === 0) {
        lines.push(`  ${pad('hold')}none`);
    }
    else {
        for (const [index, hold] of facts.holds.entries()) {
            const rendered = formatHold(hold, ' '.repeat(14));
            lines.push(`  ${pad(index === 0 ? 'hold' : '')}${rendered[0]}`);
            lines.push(...rendered.slice(1));
        }
    }
    if (facts.heldJobs.length > 0) {
        lines.push(`  ${pad('held jobs')}${facts.heldJobs
            .map((row) => `${row.reason}=${row.jobs}`)
            .join(', ')}`);
    }
    lines.push('');
    lines.push('EMBEDDING  (read-only in 0.7.0 — changing it lands in 0.7.1)');
    lines.push(`  ${pad('model')}${embedding.model}   (${embedding.source === 'env' ? 'environment' : 'built-in default'})`);
    lines.push(`  ${pad('cache')}${embedding.cache.stub
        ? 'stubbed (MEMEX_EMBEDDING_STUB=1) — no weights needed'
        : embedding.cache.present
            ? `present — ${formatCacheBytes(embedding.cache.bytes)} in ${embedding.cache.files} file(s) at ${embedding.cache.modelDir}`
            : `absent — run: memex deps warm (${embedding.cache.modelDir})`}`);
    lines.push('');
    lines.push(`Settings file  ${modelSettingsPath()}` +
        (payload.settingsFileExists
            ? ` (version ${settings.version}${settings.updatedAt ? `, updated ${settings.updatedAt}` : ''})`
            : ' (not written yet — built-in defaults apply)'));
    lines.push(`Environment    ${Object.entries(envReport())
        .map(([name, value]) => `${name}=${value ?? 'unset'}`)
        .join('  ')}`);
    emit(payload, lines.join('\n'));
}
/**
 * A selection change makes the OLD fingerprint's hold unreachable — nothing
 * will ever match it again (§3.5.2 rule 3), so it is closed here rather than
 * left to the 30-day TTL, and only ever THIS process's own row. Jobs parked on
 * the reason are unparked too: a claim clears its own marker, but `memex status`
 * and `memex jobs list` should stop saying "waiting on a configuration" the
 * moment the configuration changed.
 */
async function settleAfterSelectionChange(previousFingerprint, nextFingerprint) {
    if (previousFingerprint === nextFingerprint)
        return null;
    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath))
        return null;
    const { openWriteDb } = await import('./db.js');
    const { clearModelConfigHold, releaseHeldJobs } = await import('./model-budget.js');
    const db = openWriteDb(dbPath);
    try {
        const clearedHolds = clearModelConfigHold(db, previousFingerprint, 'manual') ? 1 : 0;
        const releasedJobs = releaseHeldJobs(db, 'model_config_rejected');
        return { clearedHolds, releasedJobs };
    }
    finally {
        db.close();
    }
}
/**
 * One audit line per selection change, through the SHARED writer.
 *
 * The UI wrote `models.llm.set` / `models.reset` and the CLI wrote nothing, so a
 * change made from the terminal left no history at all — and the settings leaf
 * has no audit of its own, so there was no second place to look. Same action
 * names as the UI (design §10.1); only `source` differs.
 *
 * Dynamic import for the reason `settleAfterSelectionChange` uses one: `show`
 * must stay a light, read-only command. Best-effort by construction — a missing
 * or unwritable log must never turn a saved setting into a failed command.
 */
async function auditSelectionChange(action, detail) {
    try {
        const { appendUiAuditLine } = await import('./ontology-admin.js');
        appendUiAuditLine(action, { ...detail, source: 'cli' });
    }
    catch {
        /* models.json itself is the durable record of the selection */
    }
}
function refuse(message) {
    if (json)
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else
        console.error(`Refused: ${message}\nNothing was saved.`);
    process.exit(1);
}
async function runSet() {
    const modelArg = valueAfter('--model');
    const reasoningArg = valueAfter('--reasoning');
    if (modelArg === undefined && reasoningArg === undefined) {
        refuse('set needs --model <id> and/or --reasoning <level>');
    }
    if (modelArg !== undefined && !isValidModelId(modelArg)) {
        refuse(`--model must be 1-256 characters matching [\\w./:@+-]. (got ${JSON.stringify(modelArg)})`);
    }
    let reasoning;
    if (reasoningArg !== undefined) {
        // `none` is a real provider level, so it is accepted as a level; "remove the
        // setting" is spelled `--reasoning unset`, which is not a provider value and
        // therefore cannot be confused with one.
        if (reasoningArg === 'unset') {
            reasoning = null;
        }
        else {
            const normalized = normalizeReasoningEffort(reasoningArg);
            if (!normalized) {
                refuse(`--reasoning must be one of ${ALLOWED_REASONING_EFFORTS.join('|')}` +
                    ` (or 'unset' to remove it). (got ${JSON.stringify(reasoningArg)})`);
            }
            reasoning = normalized;
        }
    }
    const before = resolveLlmSelection();
    writeModelSettings({
        llm: {
            ...(modelArg !== undefined ? { model: modelArg.trim() } : {}),
            ...(reasoning !== undefined ? { reasoning } : {}),
        },
    });
    const settings = readModelSettings();
    const after = resolveLlmSelection();
    const settled = await settleAfterSelectionChange(before.fingerprint, after.fingerprint);
    await auditSelectionChange('models.llm.set', {
        from_model: before.model,
        to_model: after.model,
        from_reasoning: before.reasoning,
        to_reasoning: after.reasoning,
    });
    const catalog = readCodexCatalog();
    const catalogModel = modelArg !== undefined ? findCatalogModel(catalog, modelArg.trim()) : null;
    // The level is checked against the model this command SAVED, not the one the
    // environment happens to override it with: "saved gpt-6-astra" followed by a
    // warning about gpt-5.5's levels reads as a bug in the warning.
    const checkedModel = modelArg !== undefined ? modelArg.trim() : after.model;
    const effectiveLevels = reasoningEffortsForModel(checkedModel, catalog);
    const notes = [];
    if (modelArg !== undefined) {
        if (catalog.source === 'none') {
            notes.push('this Codex installation publishes no model catalog — the id is verified by the first call');
        }
        else if (!catalogModel) {
            notes.push(`${modelArg} is not in this installation's catalog (${catalog.path}) — saved anyway; ` +
                'the catalog can be stale and only a real call can prove an id');
        }
        else if (!catalogModel.visible) {
            notes.push(`${modelArg} is a hidden catalog entry — selectable, just not listed`);
        }
    }
    const savedReasoning = settings.llm.reasoning;
    if (savedReasoning && effectiveLevels) {
        if (effectiveLevels.includes(savedReasoning)) {
            notes.push(`catalog check: ${checkedModel} supports ${effectiveLevels.join('/')}. ok`);
        }
        else {
            notes.push(`warning: the catalog says ${checkedModel} supports ${effectiveLevels.join('/')}, ` +
                `not ${savedReasoning} — saved anyway (the catalog can be stale); run: memex models test`);
        }
    }
    if (settled && settled.clearedHolds > 0) {
        notes.push('released the configuration hold that was held against the previous selection');
    }
    if (settled && settled.releasedJobs > 0) {
        notes.push(`${settled.releasedJobs} job(s) are no longer waiting on a configuration`);
    }
    if (after.modelSource === 'env' && modelArg !== undefined) {
        notes.push(`${LLM_MODEL_ENV}=${process.env[LLM_MODEL_ENV]} is set and takes precedence — ` +
            `models.json now holds ${modelArg.trim()}, but this environment calls ${after.model}`);
    }
    if (after.reasoningSource === 'env' && reasoning !== undefined) {
        notes.push(`${LLM_REASONING_ENV}=${process.env[LLM_REASONING_ENV]} is set and takes precedence — ` +
            `this environment calls with reasoning ${after.reasoning ?? '(no flag)'}`);
    }
    notes.push('background workers apply this from their next Codex session; a running MCP server from its next model call');
    if (after.reasoning && ['high', 'xhigh', 'max', 'ultra'].includes(after.reasoning)) {
        notes.push(`reasoning ${after.reasoning} raises per-call latency — if extraction starts hitting the run ` +
            'deadline, raise MEMEX_MODEL_BUDGET_DEADLINE_MS');
    }
    const payload = {
        ok: true,
        settingsPath: modelSettingsPath(),
        updatedAt: settings.updatedAt,
        saved: {
            model: settings.llm.model,
            reasoning: settings.llm.reasoning,
        },
        effective: {
            model: { value: after.model, source: after.modelSource },
            reasoning: { value: after.reasoning, source: after.reasoningSource },
            fingerprint: after.fingerprint,
        },
        catalogReasoning: effectiveLevels,
        envOverride: after.modelSource === 'env' || after.reasoningSource === 'env',
        settled,
        notes,
    };
    const text = [
        `Saved model ${settings.llm.model ?? '(unset)'} / reasoning ${settings.llm.reasoning ?? '(no flag)'}` +
            `  (${modelSettingsPath()})`,
        '',
        ...notes.map((note) => `  · ${note}`),
        '',
        'Verify with one real call:  memex models test',
    ].join('\n');
    emit(payload, text);
}
async function runReset() {
    const existed = fs.existsSync(modelSettingsPath());
    const before = resolveLlmSelection();
    resetModelSettings();
    const after = resolveLlmSelection();
    const settled = await settleAfterSelectionChange(before.fingerprint, after.fingerprint);
    await auditSelectionChange('models.reset', { had_llm: existed });
    const embedding = embeddingReport();
    const payload = {
        ok: true,
        settingsPath: modelSettingsPath(),
        removed: existed,
        effective: {
            model: { value: after.model, source: after.modelSource },
            reasoning: { value: after.reasoning, source: after.reasoningSource },
        },
        settled,
        embedding,
    };
    const lines = [];
    lines.push(existed
        ? `Deleted ${modelSettingsPath()}. The LLM selection returns to the built-in default.`
        : `${modelSettingsPath()} did not exist — the LLM selection already was the built-in default.`);
    lines.push(`  LLM  ${after.model} / ${after.reasoning ?? '(no reasoning flag)'}   (${sourceLabel(after.modelSource)})`);
    if (after.modelSource === 'env' || after.reasoningSource === 'env') {
        lines.push(`  note: ${LLM_MODEL_ENV}/${LLM_REASONING_ENV} is still set in this environment and wins over the file.`);
    }
    if (settled && (settled.clearedHolds > 0 || settled.releasedJobs > 0)) {
        lines.push(`  released ${settled.clearedHolds} configuration hold(s) and ${settled.releasedJobs} waiting job(s).`);
    }
    lines.push(`The effective EMBEDDING model is unchanged (${embedding.model}) — the database owns it, ` +
        'and deleting a settings file can never delete a vector.');
    emit(payload, lines.join('\n'));
}
/**
 * Why the failure branches are this specific: every one of them was a real
 * "it just printed a stack trace" moment in an earlier shape of this command. A
 * missing `codex` binary, an exhausted usage limit and a rejected model id look
 * nothing alike to a user and need nothing alike from them, so each gets its own
 * sentence and its own next step.
 */
function explainFailure(result) {
    const message = result.error ?? '';
    if (/\bENOENT\b|spawn codex/i.test(message)) {
        return {
            headline: 'the codex CLI was not found',
            advice: [
                'Install Codex (or point MEMEX_CODEX_BIN at the binary) and run this again.',
                'Nothing about the saved selection changed.',
            ],
        };
    }
    if (/usage limit|rate.?limit|too many requests|quota|429/i.test(message)) {
        return {
            headline: 'the provider refused for a usage limit',
            advice: [
                'This says nothing about the model id — the selection was not proven wrong.',
                'Wait for the limit to reset and run: memex models test',
            ],
        };
    }
    if (/timed out|timeout/i.test(message)) {
        return {
            headline: 'the call timed out',
            advice: [
                'Raise the budget with --timeout-ms <n>, or try a lower reasoning effort.',
                'A timeout proves nothing about the model id.',
            ],
        };
    }
    if (result.errorClass === 'transient') {
        return {
            headline: 'the provider is unavailable',
            advice: [
                'This is an outage or an auth problem, not a wrong model id.',
                'Run again once the provider answers: memex models test',
            ],
        };
    }
    return {
        headline: 'the call failed',
        advice: ['Run: memex doctor', 'Nothing about the saved selection changed.'],
    };
}
async function runTest() {
    const modelArg = valueAfter('--model');
    const reasoningArg = valueAfter('--reasoning');
    const timeoutArg = valueAfter('--timeout-ms');
    if (modelArg !== undefined && !isValidModelId(modelArg)) {
        refuse(`--model must be 1-256 characters matching [\\w./:@+-]. (got ${JSON.stringify(modelArg)})`);
    }
    if (reasoningArg !== undefined && reasoningArg !== 'unset' && !normalizeReasoningEffort(reasoningArg)) {
        refuse(`--reasoning must be one of ${ALLOWED_REASONING_EFFORTS.join('|')}. ` +
            `(got ${JSON.stringify(reasoningArg)})`);
    }
    let timeoutMs;
    if (timeoutArg !== undefined) {
        if (!/^\d+$/.test(timeoutArg))
            refuse('--timeout-ms must be a non-negative integer');
        timeoutMs = Number(timeoutArg);
    }
    const selection = resolveLlmSelection({
        ...(modelArg !== undefined ? { model: modelArg } : {}),
        ...(reasoningArg !== undefined
            ? { reasoningEffort: reasoningArg === 'unset' ? null : reasoningArg }
            : {}),
    });
    const { initDatabase } = await import('./db.js');
    const { probeModel } = await import('./model-settings-probe.js');
    const db = initDatabase();
    let result;
    try {
        result = await probeModel(db, {
            model: selection.model,
            reasoning: selection.reasoning,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
    }
    finally {
        db.close();
    }
    const label = `${result.model} / ${result.reasoning ?? '(no reasoning flag)'}`;
    if (result.ok) {
        const lines = [
            `${label} … ok (${result.latencyMs}ms)`,
            `answer: ${JSON.stringify(result.answer)}`,
            "recorded in the model-work ledger as one attempt with stage 'model_probe'.",
        ];
        if (result.clearedHold) {
            lines.push(`cleared ${result.clearedHold.clearedHolds} configuration hold(s) and released ` +
                `${result.clearedHold.releasedJobs} job(s) that were waiting on this setting.`);
        }
        emit(result, lines.join('\n'));
        return;
    }
    const lines = [];
    if (result.rejection) {
        lines.push(`${label} … rejected (${result.latencyMs}ms)`);
        lines.push(`  ${result.rejection.status ?? '?'} ${result.rejection.type ?? 'provider error'} — ${result.rejection.message}`);
        lines.push('The model-work hold stays in place. Fix the selection and run again:', '  memex models set --model <id> [--reasoning <level>]', '  memex models test');
    }
    else {
        const explained = explainFailure(result);
        lines.push(`${label} … ${explained.headline} (${result.latencyMs}ms)`);
        lines.push(`  ${result.error ?? 'no detail reported'}`);
        lines.push(...explained.advice);
    }
    if (json)
        console.log(JSON.stringify(result, null, 2));
    else
        console.error(lines.join('\n'));
    process.exitCode = 1;
}
try {
    if (subcommand === 'show')
        await runShow();
    else if (subcommand === 'set')
        await runSet();
    else if (subcommand === 'reset')
        await runReset();
    else
        await runTest();
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json)
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else
        console.error(`memex models ${subcommand}: ${message}`);
    process.exitCode = 1;
}
