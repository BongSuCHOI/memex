/**
 * Issue #31 — `memex models` is the only surface a user has when model work has
 * stopped because of a bad model id or reasoning level.
 *
 * Everything here runs the REAL CLI in an isolated MEMEX_HOME and CODEX_HOME,
 * with a fake `codex` first on PATH, so the suite can exercise `test` end to end
 * without a network call and without touching the developer's real data root or
 * `~/.codex`. The regressions pinned here are the ones that make the command
 * worse than nothing:
 *
 *  - `--help` doing the work (#36) — the guard is membership-based, so a command
 *    missing from KNOWN_COMMANDS is simply unprotected;
 *  - a refused setting being saved anyway, which turns a typo into a hold an
 *    hour later that names a value the user never confirmed;
 *  - `reset` reaching past the settings file;
 *  - `test` exiting 0 on a rejection, which would tell a user their broken
 *    selection is fine;
 *  - `test` hanging on a prompt, which is how a settings screen wedges.
 */
import './model-cache-pin.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO, 'cli', 'memex.js');

/** A catalog shaped exactly like the measured `models_cache.json` (§3.2). */
const CATALOG = {
  fetched_at: '2026-09-10T08:12:29Z',
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
        { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
      ],
      visibility: 'list',
      priority: 1,
    },
    {
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
      visibility: 'list',
      priority: 2,
    },
    { slug: 'gpt-reserve', visibility: 'hide', priority: 9 },
  ],
};

/** Answers MEMEX_OK into the `-o` file the way codex 0.153 does. */
const FAKE_OK = `#!/bin/sh
cat >/dev/null
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf 'MEMEX_OK' > "$out"
echo '{"type":"item.completed","item":{"type":"agent_message","text":"MEMEX_OK"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":18249,"output_tokens":5}}'
`;

/**
 * Measured envelope rejection: exit 0, an EMPTY `-o` file, and a 400 inside the
 * JSONL stream. That combination is the whole reason `test` has to exist.
 */
const FAKE_REJECT = `#!/bin/sh
cat >/dev/null
echo '{"type":"error","message":"{\\"status\\": 400, \\"error\\": {\\"type\\": \\"invalid_request_error\\", \\"message\\": \\"The model is not supported when using Codex with a ChatGPT account.\\"}}"}'
echo '{"type":"turn.failed","error":{"message":"turn failed"}}'
`;

/** A usage limit: a 429 the CLI reports on stderr with a non-zero exit. */
const FAKE_USAGE_LIMIT = `#!/bin/sh
cat >/dev/null
echo 'You have hit your usage limit. Try again later.' >&2
exit 1
`;

function isolated(t, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-models-cli-'));
  const home = path.join(tmp, 'memex-home');
  const codexHome = path.join(tmp, 'codex-home');
  const binDir = path.join(tmp, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  if (options.catalog !== false) {
    fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify(CATALOG));
  }
  if (options.codex) {
    const bin = path.join(binDir, 'codex');
    fs.writeFileSync(bin, options.codex);
    fs.chmodSync(bin, 0o755);
  }
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return {
    tmp,
    home,
    codexHome,
    settings: path.join(home, 'models.json'),
    env: {
      ...process.env,
      MEMEX_HOME: home,
      CODEX_HOME: codexHome,
      MEMEX_EMBEDDING_STUB: '1',
      MEMEX_PLUGIN_ROOT: REPO,
      // `codex` resolves from PATH; an empty bin dir is how "not installed" is
      // spelled, so the fake (when present) must come first.
      PATH: `${binDir}:${process.env.PATH}`,
      MEMEX_CODEX_MODEL: undefined,
      MEMEX_CODEX_REASONING: undefined,
    },
  };
}

/** stdin is CLOSED on purpose: a verb that reads it would hang a settings screen. */
function run(env, args) {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined),
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    env: clean,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/** Record a hold the way a BACKGROUND call does — no per-call override, so the
 *  fingerprint is the one `show` compares against (§3.5.2 rule 1). */
async function seedHoldForCurrentSelection(env, overrides = {}) {
  const prior = { home: process.env.MEMEX_HOME, codex: process.env.CODEX_HOME };
  process.env.MEMEX_HOME = env.MEMEX_HOME;
  process.env.CODEX_HOME = env.CODEX_HOME;
  try {
    const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
    const { recordModelConfigHold } = await import(path.join(REPO, 'dist/model-budget.js'));
    const { llmSelectionFingerprint, resolveLlmSelection, invalidateModelSettingsCache } =
      await import(path.join(REPO, 'dist/model-settings.js'));
    invalidateModelSettingsCache();
    const selection = resolveLlmSelection();
    const db = initDatabase();
    try {
      recordModelConfigHold(db, {
        fingerprint: llmSelectionFingerprint(),
        model: selection.model,
        reasoningEffort: selection.reasoning,
        status: 400,
        providerType: 'invalid_request_error',
        providerMessage: "The 'bogus' model is not supported when using Codex with a ChatGPT account.",
        stage: 'fact_extract',
        ...overrides,
      });
      return selection;
    } finally {
      db.close();
    }
  } finally {
    if (prior.home === undefined) delete process.env.MEMEX_HOME;
    else process.env.MEMEX_HOME = prior.home;
    if (prior.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior.codex;
  }
}

async function activeHolds(env) {
  const prior = process.env.MEMEX_HOME;
  process.env.MEMEX_HOME = env.MEMEX_HOME;
  try {
    const { openReadDb } = await import(path.join(REPO, 'dist/db.js'));
    const { getDbPath } = await import(path.join(REPO, 'dist/paths.js'));
    const db = openReadDb(getDbPath());
    try {
      return db.prepare(
        'SELECT selection_fingerprint, cleared_at, cleared_by FROM model_config_holds',
      ).all();
    } finally {
      db.close();
    }
  } finally {
    if (prior === undefined) delete process.env.MEMEX_HOME;
    else process.env.MEMEX_HOME = prior;
  }
}

/* ------------------------------------------------------------------ --help -- */

test('memex models --help prints usage, exits 0, and writes nothing', (t) => {
  const fixture = isolated(t);
  const before = fs.readdirSync(fixture.home);

  const result = run(fixture.env, ['models', '--help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /memex models show \[--json\]/);
  assert.match(result.stdout, /memex models set --model <id>/);
  assert.match(result.stdout, /memex models reset/);
  assert.match(result.stdout, /memex models test/);
  // #36: the guard must not let the verb run. `show` would print this header.
  assert.doesNotMatch(result.stdout, /^LLM$/m);
  assert.deepEqual(fs.readdirSync(fixture.home), before);
  assert.ok(!fs.existsSync(fixture.settings), 'help must not write models.json');
});

test('memex models set --help does not write models.json', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(fixture.settings), 'a help run must save nothing');
});

test('memex models rejects an unknown verb without writing', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'explode']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown 'memex models' subcommand: explode/);
  assert.match(result.stderr, /show, set, reset, test/);
  assert.ok(!fs.existsSync(fixture.settings));
});

/* -------------------------------------------------------------------- show -- */

test('memex models show reports the built-in default and its source', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'show']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model\s+gpt-5\.6-luna\s+\(built-in default\)/);
  assert.match(result.stdout, /reasoning\s+\(no flag\)\s+\(built-in default\)/);
  assert.match(result.stdout, /hold\s+none/);
  assert.match(result.stdout, /EMBEDDING\s+\(read-only in 0\.7\.0/);
  assert.ok(!fs.existsSync(fixture.settings), 'show is read-only');
  assert.ok(
    !fs.existsSync(path.join(fixture.home, 'conversation-index', 'db.sqlite')),
    'show must not create a database',
  );
});

test('memex models show --json reports values, sources, catalog and holds', async (t) => {
  const fixture = isolated(t);
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--reasoning', 'high']).status, 0);

  const result = run(fixture.env, ['models', 'show', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(payload.llm.model, { value: 'gpt-6-astra', source: 'file' });
  assert.deepEqual(payload.llm.reasoning, { value: 'high', source: 'file' });
  assert.deepEqual(payload.llm.defaults, { model: 'gpt-5.6-luna', reasoning: null });
  assert.equal(payload.llm.catalog.source, 'models_cache');
  assert.deepEqual(payload.llm.catalogReasoning, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.equal(payload.llm.hold, null);
  assert.deepEqual(payload.llm.holds, []);
  assert.equal(payload.llm.lastProbe, null);
  assert.equal(payload.embedding.readOnly, true);
  assert.equal(payload.env.MEMEX_CODEX_MODEL, null);
  assert.equal(payload.version, 1);
  assert.ok(payload.settingsPath.startsWith(fixture.home));
});

test('memex models show marks the hold that matches this process\'s selection', async (t) => {
  const fixture = isolated(t);
  await seedHoldForCurrentSelection(fixture.env);

  const text = run(fixture.env, ['models', 'show']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /HELD — the provider rejected the request envelope/);
  assert.match(text.stdout, /400 invalid_request_error/);
  assert.match(text.stdout, /Model work is paused\. No job was failed and no attempt was consumed\./);
  assert.match(text.stdout, /memex models test/);

  const payload = JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout);
  assert.equal(payload.llm.holds.length, 1);
  assert.equal(payload.llm.holds[0].current, true);
  assert.equal(payload.llm.hold.status, 400);
  assert.equal(payload.llm.hold.observedCount, 1);
});

test("memex models show lists another selection's hold as inert", async (t) => {
  const fixture = isolated(t);
  await seedHoldForCurrentSelection(fixture.env, { fingerprint: 'other-process-fingerprint' });

  const payload = JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout);
  assert.equal(payload.llm.holds.length, 1);
  assert.equal(payload.llm.holds[0].current, false);
  assert.equal(payload.llm.hold, null, 'another fingerprint must not read as blocking this process');
  assert.match(run(fixture.env, ['models', 'show']).stdout, /held \(another selection\)/);
});

test('memex models show says so when the installation publishes no catalog', (t) => {
  const fixture = isolated(t, { catalog: false });
  const result = run(fixture.env, ['models', 'show', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).llm.catalog.source, 'none');
  assert.match(
    run(fixture.env, ['models', 'show']).stdout,
    /not found in this Codex installation/,
  );
});

/* --------------------------------------------------------------------- set -- */

test('memex models set writes models.json with mode 0600', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--reasoning', 'max']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved model gpt-6-astra \/ reasoning max/);
  assert.match(result.stdout, /catalog check: gpt-6-astra supports low\/medium\/high\/xhigh\/max\/ultra/);

  const saved = JSON.parse(fs.readFileSync(fixture.settings, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.llm.model, 'gpt-6-astra');
  assert.equal(saved.llm.reasoning, 'max');
  assert.equal(fs.statSync(fixture.settings).mode & 0o777, 0o600);
});

test('memex models set --reasoning bogus refuses, saves nothing, exits 1', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'set', '--reasoning', 'bogus']);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--reasoning must be one of none\|minimal\|low\|medium\|high\|xhigh\|max\|ultra/,
  );
  assert.match(result.stderr, /\(got "bogus"\)/);
  assert.match(result.stderr, /Nothing was saved\./);
  assert.ok(!fs.existsSync(fixture.settings));
});

test('memex models set refuses a malformed model id and keeps the old value', (t) => {
  const fixture = isolated(t);
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra']).status, 0);

  const result = run(fixture.env, ['models', 'set', '--model', 'not a model id']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model must be 1-256 characters/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.settings, 'utf8')).llm.model, 'gpt-6-astra');
});

test('memex models set with no flags refuses instead of writing an empty file', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'set']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs --model <id> and\/or --reasoning <level>/);
  assert.ok(!fs.existsSync(fixture.settings));
});

test('memex models set warns but SAVES a level the catalog does not list', (t) => {
  const fixture = isolated(t);
  // The catalog can be stale, so a disagreement is a warning (§3.3 rule 2) —
  // refusing here would make a correct new level unreachable.
  const result = run(fixture.env, ['models', 'set', '--model', 'gpt-5.5', '--reasoning', 'ultra']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /warning: the catalog says gpt-5\.5 supports low\/medium\/high, not ultra/);
  assert.equal(JSON.parse(fs.readFileSync(fixture.settings, 'utf8')).llm.reasoning, 'ultra');
});

test('memex models set warns that an env override outranks the file', (t) => {
  const fixture = isolated(t);
  const env = { ...fixture.env, MEMEX_CODEX_MODEL: 'gpt-5.5' };
  const result = run(env, ['models', 'set', '--model', 'gpt-6-astra']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /MEMEX_CODEX_MODEL=gpt-5\.5 is set and takes precedence/);
  assert.match(result.stdout, /this environment calls gpt-5\.5/);
  // The file still holds what the user asked for — env wins at CALL time only.
  assert.equal(JSON.parse(fs.readFileSync(fixture.settings, 'utf8')).llm.model, 'gpt-6-astra');
  assert.equal(JSON.parse(run(env, ['models', 'show', '--json']).stdout).llm.model.source, 'env');
});

test("memex models set closes the previous selection's hold and unparks its jobs", async (t) => {
  const fixture = isolated(t);
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astraX']).status, 0);
  const held = await seedHoldForCurrentSelection(fixture.env);
  assert.equal(held.model, 'gpt-6-astraX');

  const result = run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /released the configuration hold/);

  const rows = await activeHolds(fixture.env);
  assert.equal(rows.length, 1, 'the row is closed, never deleted (audit)');
  assert.equal(rows[0].cleared_by, 'manual');
  assert.ok(rows[0].cleared_at);
  assert.equal(JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout).llm.holds.length, 0);
});

/* ------------------------------------------------------------------- reset -- */

test('memex models reset deletes only models.json', (t) => {
  const fixture = isolated(t);
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--reasoning', 'high']).status, 0);
  assert.ok(fs.existsSync(fixture.settings));

  const result = run(fixture.env, ['models', 'reset']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(fixture.settings), 'the file is gone');
  assert.match(result.stdout, /LLM\s+gpt-5\.6-luna \/ \(no reasoning flag\)/);
  // Review 3: deleting a proposal can never change the effective embedding model.
  assert.match(result.stdout, /effective EMBEDDING model is unchanged \(Xenova\/multilingual-e5-small\)/);

  const payload = JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout);
  assert.deepEqual(payload.llm.model, { value: 'gpt-5.6-luna', source: 'default' });
  assert.equal(payload.embedding.model, 'Xenova/multilingual-e5-small');
});

test('memex models reset on a machine with no settings file is a clean no-op', (t) => {
  const fixture = isolated(t);
  const result = run(fixture.env, ['models', 'reset', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.removed, false);
  assert.equal(payload.effective.model.value, 'gpt-5.6-luna');
});

/* -------------------------------------------------------------------- test -- */

test('memex models test makes one call, reports ok, and records one probe attempt', async (t) => {
  const fixture = isolated(t, { codex: FAKE_OK });
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--reasoning', 'high']).status, 0);

  const result = run(fixture.env, ['models', 'test']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /gpt-6-astra \/ high … ok \(\d+ms\)/);
  assert.match(result.stdout, /answer: "MEMEX_OK"/);
  assert.match(result.stdout, /stage 'model_probe'/);

  const payload = JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout);
  assert.equal(payload.llm.lastProbe.ok, true);
  assert.equal(payload.llm.lastProbe.model, 'gpt-6-astra');
  assert.equal(payload.llm.lastProbe.reasoning, 'high');
});

test('memex models test --json reports the probe result', (t) => {
  const fixture = isolated(t, { codex: FAKE_OK });
  const result = run(fixture.env, ['models', 'test', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.model, 'gpt-5.6-luna');
  assert.equal(payload.reasoning, null);
  assert.equal(payload.answer, 'MEMEX_OK');
  assert.equal(payload.rejection, null);
  assert.ok(Number.isInteger(payload.latencyMs));
});

test('memex models test clears the hold on success and releases the waiting jobs', async (t) => {
  const fixture = isolated(t, { codex: FAKE_OK });
  await seedHoldForCurrentSelection(fixture.env);
  assert.equal(
    JSON.parse(run(fixture.env, ['models', 'show', '--json']).stdout).llm.holds.length,
    1,
  );

  const result = run(fixture.env, ['models', 'test']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /cleared 1 configuration hold\(s\)/);

  const rows = await activeHolds(fixture.env);
  assert.equal(rows.length, 1, 'the row is closed, not deleted');
  assert.equal(rows[0].cleared_by, 'probe-ok');
});

test('memex models test exits 1 on an envelope rejection and keeps the hold', async (t) => {
  const fixture = isolated(t, { codex: FAKE_REJECT });
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astraX']).status, 0);

  const result = run(fixture.env, ['models', 'test']);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /gpt-6-astraX \/ \(no reasoning flag\) … rejected/);
  assert.match(result.stderr, /400 invalid_request_error/);
  assert.match(result.stderr, /The model-work hold stays in place/);
  assert.match(result.stderr, /memex models set --model <id>/);

  const rows = await activeHolds(fixture.env);
  assert.equal(rows.length, 1, 'the rejection recorded a durable hold');
  assert.equal(rows[0].cleared_at, null, 'a failed test must not clear the hold');
});

test('memex models test --json on a rejection still exits 1', (t) => {
  const fixture = isolated(t, { codex: FAKE_REJECT });
  const result = run(fixture.env, ['models', 'test', '--json']);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.errorClass, 'config');
  assert.equal(payload.rejection.status, 400);
  assert.equal(payload.clearedHold, null);
});

test('memex models test says the codex CLI is missing rather than printing a stack', (t) => {
  // No `codex` fixture: the bin directory is empty and first on PATH, but the
  // inherited PATH still has to be searched, so point the resolver at a path
  // that definitively does not exist.
  const fixture = isolated(t);
  const env = { ...fixture.env, MEMEX_CODEX_BIN: path.join(fixture.tmp, 'no-such-codex') };
  const result = run(env, ['models', 'test']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the codex CLI was not found/);
  assert.match(result.stderr, /MEMEX_CODEX_BIN/);
  assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/, 'no raw stack trace');
});

test('memex models test reports a usage limit as a usage limit', (t) => {
  const fixture = isolated(t, { codex: FAKE_USAGE_LIMIT });
  const result = run(fixture.env, ['models', 'test']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage limit/);
  assert.match(result.stderr, /says nothing about the model id/);
});

test('memex models test refuses a bogus --reasoning before spending a call', (t) => {
  const fixture = isolated(t, { codex: FAKE_OK });
  const result = run(fixture.env, ['models', 'test', '--reasoning', 'bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--reasoning must be one of/);
  assert.ok(
    !fs.existsSync(path.join(fixture.home, 'conversation-index', 'db.sqlite')),
    'a refused test must not even open the ledger',
  );
});

test('memex models set/reset leave the same audit lines the UI leaves', (t) => {
  // The CLI wrote nothing at all, and the settings leaf has no audit of its own,
  // so a selection changed from the terminal left no history anywhere (§10.1).
  const fixture = isolated(t);
  assert.equal(run(fixture.env, ['models', 'set', '--model', 'gpt-6-astra', '--reasoning', 'high']).status, 0);
  assert.equal(run(fixture.env, ['models', 'reset']).status, 0);
  const log = path.join(fixture.home, 'logs', 'ui-audit.jsonl');
  assert.ok(fs.existsSync(log), 'no audit log was written under this data root');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  const set = lines.filter(l => l.action === 'models.llm.set').pop();
  assert.ok(set, 'models.llm.set is missing');
  assert.equal(set.to_model, 'gpt-6-astra');
  assert.equal(set.to_reasoning, 'high');
  assert.equal(set.source, 'cli');
  const reset = lines.filter(l => l.action === 'models.reset').pop();
  assert.ok(reset, 'models.reset is missing');
  assert.equal(reset.had_llm, true);
  assert.equal(reset.source, 'cli');
});

test('memex models test does not read stdin', (t) => {
  // `run()` closes stdin. A verb that prompted would hang until the 60s timeout,
  // which `spawnSync` reports as a signal rather than an exit code.
  const fixture = isolated(t, { codex: FAKE_OK });
  const result = run(fixture.env, ['models', 'test']);
  assert.equal(result.signal, null, 'the command must finish on its own');
  assert.equal(result.status, 0, result.stderr);
});
