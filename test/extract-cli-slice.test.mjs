/**
 * `memex extract` — the CLI slice (issue #30, §7.2).
 *
 * Everything here runs the REAL launcher (`cli/memex.js`) against a throwaway
 * MEMEX_HOME, because the properties worth testing are the ones a unit test
 * cannot see: the exit code, what the overlay directory and the database look
 * like afterwards, and that a read-only verb leaves both byte-identical.
 *
 * Two things this file is careful about:
 *  - the scheduling key. `reextract --apply` must re-queue the selected targets
 *    WITHOUT touching `extraction_targets.policy_version`, because that column is
 *    the key that decides what counts as processed — rewriting it would turn one
 *    edited rule into a full-corpus re-extraction. The assertion is explicit.
 *  - the refusals. `set` is the full-document path, so once a file exists it has
 *    to name the revision it believes it is replacing, and a stale one must
 *    change nothing at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO, 'cli', 'memex.js');

/** Matches the planted secret below and nothing else in the fixture. */
const SECRET_PATTERN = '\\bsk-[A-Za-z0-9_-]{16,}';
const SECRET = 'sk-ABCDEFGHIJKLMNOPQR';
const POLICY_VERSION = 'continuity-fact-v1';

function isolated(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-extract-cli-'));
  const memexHome = path.join(tmp, 'memex-home');
  const codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(memexHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return {
    tmp,
    memexHome,
    dbPath: path.join(memexHome, 'conversation-index', 'db.sqlite'),
    overlayDir: path.join(memexHome, 'overlays'),
    rulesFile: path.join(memexHome, 'overlays', 'extraction-rules.json'),
    env: {
      ...process.env,
      MEMEX_HOME: memexHome,
      CODEX_HOME: codexHome,
      MEMEX_PLUGIN_ROOT: REPO,
      MEMEX_EMBEDDING_STUB: '1',
      // The real config root must never be read or written by a test.
      MEMEX_OVERLAY_DIR: path.join(memexHome, 'overlays'),
      PATH: path.join(tmp, 'empty-bin'),
    },
  };
}

function run(fixture, args) {
  return spawnSync(process.execPath, [CLI, 'extract', ...args], {
    env: fixture.env,
    encoding: 'utf8',
  });
}

function ok(fixture, args) {
  const result = run(fixture, args);
  assert.equal(result.status, 0, `memex extract ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** Refusals go to stderr and `--json` payloads to stdout; assert over both. */
function both(result) {
  return `${result.stdout}${result.stderr}`;
}

function asJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`stdout was not JSON:\n${result.stdout}\n${result.stderr}\n${error.message}`);
  }
}

function readRules(fixture) {
  return JSON.parse(fs.readFileSync(fixture.rulesFile, 'utf8'));
}

/** A candidate document on disk — the only input `set` accepts. */
function candidate(fixture, name, doc) {
  const file = path.join(fixture.tmp, name);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schema: 'memex.extraction-rules-overlay',
        version: 1,
        revision: 0,
        ...doc,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const SECRET_RULES = {
  preferred_language: 'ko',
  exclude_topics: ['사내 인사 평가', '급여'],
  never_extract_patterns: [
    { id: 'user.secret', source: SECRET_PATTERN, flags: '', scope: 'both', note: 'API 키 형태' },
  ],
  always_treat_as_decision_patterns: [{ id: 'user.decision', source: '(확정|최종 결정)', flags: 'i' }],
};

/**
 * A fixture database with one secret-bearing fact, two exchanges, and one
 * COMPLETED extraction target stamped with an old rule hash.
 *
 * Written through `initDatabase` so the schema is the real one — including the
 * `rules_hash` column and the three tables `reextract` has to revert together.
 */
async function seedDb(fixture, { staleHash = 'rules:deadbeef' } = {}) {
  const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
  const db = initDatabase({ dbPath: fixture.dbPath });
  const now = '2026-09-01T00:00:00.000Z';
  try {
    const insertExchange = db.prepare(`INSERT INTO exchanges
        (id, project, timestamp, user_message, assistant_message, archive_path,
         line_start, line_end, session_id, cwd, is_sidechain, content_generation, content_hash)
      VALUES (?, '/tmp/extract-slice', ?, ?, 'ok', '/tmp/extract-slice/r.jsonl', 1, 2,
              'session-1', '/tmp/extract-slice', 0, 1, ?)`);
    insertExchange.run('ex-secret', now, `the key is ${SECRET}`, 'h-secret');
    insertExchange.run('ex-clean', '2026-09-02T00:00:00.000Z', '배포 이력 좀 보여줘', 'h-clean');

    const insertFact = db.prepare(`INSERT INTO facts
        (id, fact, fact_kr, category, scope_type, scope_project, created_at, updated_at, is_active)
      VALUES (?, ?, ?, ?, 'project', '/tmp/extract-slice', ?, ?, 1)`);
    insertFact.run('fact-secret-0001', `API key ${SECRET} is in use`, null, 'knowledge', now, now);
    insertFact.run('fact-clean-0001', 'auth moved to supabase', null, 'decision', now, now);

    db.prepare(`INSERT INTO checkpoints
        (checkpoint_id, session_id, ordinal, kind, state, idempotency_key, created_at)
      VALUES ('cp-1', 'session-1', 2, 'extraction', 'processed', 'checkpoint:target-1', ?)`).run(now);
    db.prepare(`INSERT INTO extraction_targets
        (target_id, session_id, project, from_rowid, through_rowid, item_count,
         policy_version, state, idempotency_key, created_at, updated_at, rules_hash)
      VALUES ('target-1', 'session-1', '/tmp/extract-slice', 0, 2, 2, ?, 'completed',
              'target-1', ?, ?, ?)`).run(POLICY_VERSION, now, now, staleHash);
    db.prepare(`INSERT INTO memory_jobs
        (job_id, kind, partition_key, checkpoint_id, target_id, policy_version, state,
         available_at, attempts, idempotency_key, created_at, updated_at)
      VALUES ('job-1', 'extraction', 'session-1', 'cp-1', 'target-1', ?, 'completed',
              ?, 3, 'job:target-1', ?, ?)`).run(POLICY_VERSION, now, now, now);

    const insertItem = db.prepare(`INSERT INTO extraction_target_items
        (target_id, ordinal, exchange_id, exchange_rowid, content_generation, content_hash, state)
      VALUES ('target-1', ?, ?, ?, 1, ?, 'processed')`);
    const insertState = db.prepare(`INSERT INTO exchange_extraction_state
        (exchange_id, content_generation, policy_version, state, target_id, processed_at)
      VALUES (?, 1, ?, 'processed', 'target-1', ?)`);
    for (const [index, row] of [['ex-secret', 'h-secret'], ['ex-clean', 'h-clean']].entries()) {
      const rowid = db.prepare('SELECT rowid FROM exchanges WHERE id = ?').get(row[0]).rowid;
      insertItem.run(index + 1, row[0], rowid, row[1]);
      insertState.run(row[0], POLICY_VERSION, now);
    }
  } finally {
    db.close();
  }
}

async function writeDb(fixture, sql, params = []) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(fixture.dbPath);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

async function readDb(fixture, sql, params = []) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(fixture.dbPath, { readonly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

const HELP_FORMS = [
  [],
  ['rules'],
  ['rules', 'show'],
  ['rules', 'validate'],
  ['rules', 'set'],
  ['rules', 'test'],
  ['rules', 'history'],
  ['rules', 'reset'],
  ['rules', 'rollback'],
  ['rules', 'reextract'],
  ['eval'],
];

test('--help prints the verb list, exits 0 and writes nothing (#36)', (t) => {
  const fixture = isolated(t);
  for (const form of HELP_FORMS) {
    for (const flag of ['--help', '-h']) {
      const result = run(fixture, [...form, flag]);
      assert.equal(result.status, 0, `${form.join(' ')} ${flag}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:\n {2}memex extract rules show/);
      // The usage line the design requires: this command does not extract.
      assert.match(result.stdout, /Extraction itself still runs via\n'memex backfill extract'/);
      // The side effect each write verb would have, named:
      assert.doesNotMatch(result.stdout, /revision \d+ → \d+/);
      assert.doesNotMatch(result.stdout, /action=rules\./);
    }
  }
  assert.ok(!fs.existsSync(fixture.overlayDir), 'no overlay directory may be created by --help');
  assert.ok(!fs.existsSync(fixture.dbPath), '--help must not create a database');
});

test('show reports the policy identifiers, the scheduling key and the caveats', (t) => {
  const fixture = isolated(t);
  const result = ok(fixture, ['rules', 'show']);
  assert.match(result.stdout, /Status +absent — extraction follows the built-in policy only/);
  assert.match(result.stdout, /Sched key +continuity-fact-v1 +\(the overlay does not change it/);
  assert.match(result.stdout, /Enforced +fact_insert · incident · remediation · chronicle/);
  assert.match(result.stdout, /Extraction itself still runs from memex backfill extract/);
  assert.match(result.stdout, /not shared between devices yet \(planned for 0\.7\.1\)/);
  assert.ok(!fs.existsSync(fixture.overlayDir), 'a read must not create the overlay directory');

  const payload = asJson(ok(fixture, ['rules', 'show', '--json']));
  assert.equal(payload.ok, true);
  assert.equal(payload.present, false);
  assert.equal(payload.shared, false);
  assert.equal(payload.hash, null);
  assert.equal(payload.schedulingPolicyVersion, POLICY_VERSION);
  // With no overlay the reporting identifier is the base policy, unsuffixed.
  assert.equal(payload.effectivePolicyVersion, payload.policyVersion);
  assert.deepEqual(payload.enforcementPoints, ['fact_insert', 'incident', 'remediation', 'chronicle']);
  assert.deepEqual(payload.heldJobs, []);
  assert.equal(payload.matchWallMs, 50);
  // `rules show` defaults when the verb is omitted, like `memex models`.
  assert.equal(asJson(ok(fixture, ['rules', '--json'])).present, false);
});

test('validate names the path and severity of every issue and exits 1 on errors', (t) => {
  const fixture = isolated(t);
  const absent = ok(fixture, ['rules', 'validate']);
  assert.match(absent.stdout, /absent — extraction follows the built-in policy only/);

  const broken = candidate(fixture, 'broken.json', {
    preferred_language: 'jp',
    exclude_topics: ['x'],
    never_extract_patterns: [
      { id: 'user.back', source: '(a)\\1', flags: 'i' },
      { id: 'user.scope', source: 'ok', flags: '', scope: 'nonsense' },
    ],
    surprise: true,
  });
  const result = run(fixture, ['rules', 'validate', broken]);
  assert.equal(result.status, 1);
  assert.match(both(result), /error +LANGUAGE_UNKNOWN +preferred_language/);
  assert.match(both(result), /error +TOPIC_INVALID +exclude_topics\[0\]/);
  assert.match(both(result), /error +REGEX_BACKREFERENCE +never_extract_patterns\[0\]\.source/);
  assert.match(both(result), /error +SCOPE_UNKNOWN +never_extract_patterns\[1\]\.scope/);
  assert.match(both(result), /warning +OVERLAY_UNKNOWN_FIELD/);

  const payload = asJson(run(fixture, ['rules', 'validate', broken, '--json']));
  assert.equal(payload.ok, false);
  const backref = payload.issues.find((issue) => issue.code === 'REGEX_BACKREFERENCE');
  assert.equal(backref.severity, 'error');
  assert.equal(backref.path, 'never_extract_patterns[0].source');
  assert.match(backref.key, /^overlays\.issue\./);
  assert.equal(typeof backref.message, 'string');
  assert.ok(payload.issues.every((issue) => typeof issue.key === 'string'));
  assert.ok(!fs.existsSync(fixture.rulesFile), 'validate may not create the overlay');

  // A schema this build does not know is never partially applied.
  const wrongVersion = candidate(fixture, 'v9.json', { version: 9 });
  const versioned = run(fixture, ['rules', 'validate', wrongVersion, '--json']);
  assert.equal(versioned.status, 1);
  assert.equal(asJson(versioned).issues[0].code, 'OVERLAY_VERSION_UNSUPPORTED');
});

/**
 * #121 — `custom_fact_kinds` through the real CLI.
 *
 * `show` has to print the ID, not just the label: the id is the value stored in
 * `facts.category`, so it is what an operator pastes into a search or a filter.
 * A listing that only showed "Runbook step" would leave them guessing.
 *
 * `validate` has to REFUSE a collision with a built-in rather than warn. The
 * overlay is fail-closed, and a kind called `decision` would silently reinterpret
 * every memory already stored under that value.
 */
test('show lists custom fact kinds, and set/validate accept and refuse them', (t) => {
  const fixture = isolated(t);
  const KINDS = [
    {
      id: 'runbook',
      label_en: 'Runbook step',
      label_ko: '운영 절차',
      description: 'A recovery step an operator must follow.',
      extraction_hint: 'the human describes a repeatable recovery action',
    },
    { id: 'postmortem', label_en: 'Postmortem finding', label_ko: '사후 분석 결과', description: 'A conclusion after an incident.' },
  ];

  const good = candidate(fixture, 'kinds.json', { custom_fact_kinds: KINDS });
  ok(fixture, ['rules', 'set', good, '--yes']);
  assert.deepEqual(readRules(fixture).custom_fact_kinds, KINDS);

  const shown = ok(fixture, ['rules', 'show']);
  assert.match(shown.stdout, /2 custom kind\(s\) on top of the five built-ins/);
  assert.match(shown.stdout, /\(decision, preference, pattern, knowledge, constraint\)/);
  // The id — the stored value — and both labels.
  assert.match(shown.stdout, /kind\s+runbook\s+Runbook step \/ 운영 절차/);
  assert.match(shown.stdout, /A recovery step an operator must follow\./);
  assert.match(shown.stdout, /hint: the human describes a repeatable recovery action/);
  assert.match(shown.stdout, /kind\s+postmortem\s+Postmortem finding \/ 사후 분석 결과/);

  const payload = asJson(ok(fixture, ['rules', 'show', '--json']));
  assert.deepEqual(payload.rules.customFactKinds, KINDS);
  assert.equal(payload.limits.counts.customFactKinds, 8);

  // A collision with a built-in is an ERROR with the row's path, not a warning.
  const collide = candidate(fixture, 'collide.json', {
    custom_fact_kinds: [KINDS[0], { ...KINDS[1], id: 'decision' }],
  });
  const refused = run(fixture, ['rules', 'validate', collide, '--json']);
  assert.equal(refused.status, 1);
  const issue = asJson(refused).issues.find((entry) => entry.code === 'KIND_ID_RESERVED');
  assert.equal(issue.severity, 'error');
  assert.equal(issue.path, 'custom_fact_kinds[1].id');
  assert.equal(issue.key, 'overlays.issue.kindIdReserved');

  // …and a refused `set` changes nothing that is already applied.
  const before = fs.readFileSync(fixture.rulesFile, 'utf8');
  const rejected = run(fixture, ['rules', 'set', collide, '--expect-revision', '1', '--yes']);
  assert.equal(rejected.status, 1);
  assert.equal(fs.readFileSync(fixture.rulesFile, 'utf8'), before, 'a refused set rewrote the overlay');
});

test('set refuses an invalid document and writes nothing', (t) => {
  const fixture = isolated(t);
  const bad = candidate(fixture, 'bad.json', {
    never_extract_patterns: [{ source: '^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$', flags: '' }],
  });
  const result = run(fixture, ['rules', 'set', bad]);
  assert.equal(result.status, 1);
  assert.match(both(result), /Refused — nothing was saved\./);
  assert.match(both(result), /error +REGEX_QUANTIFIER_BUDGET/);
  assert.match(both(result), /a syntax check alone cannot catch every pattern like this/);
  assert.ok(!fs.existsSync(fixture.rulesFile), 'a refused write may not create the overlay');

  const payload = asJson(run(fixture, ['rules', 'set', bad, '--json']));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'OVERLAY_INVALID');
  assert.match(
    payload.error.issues.find((issue) => issue.severity === 'error').path,
    /^never_extract_patterns\[0\]\.source$/,
  );

  const missing = run(fixture, ['rules', 'set', path.join(fixture.tmp, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /FILE_NOT_FOUND/);
});

test('set --dry-run previews the clause and the re-run command, writing nothing', (t) => {
  const fixture = isolated(t);
  const file = candidate(fixture, 'rules.json', SECRET_RULES);
  const dry = ok(fixture, ['rules', 'set', file, '--dry-run']);
  assert.match(dry.stdout, /Dry run — nothing was saved\./);
  assert.match(dry.stdout, /Hash +rules:[0-9a-f]{8} {3}\(current: none, revision 0\)/);
  assert.match(dry.stdout, /## User rule overlay \(local, operator-authored\)/);
  assert.match(dry.stdout, /- Never extract facts about: 사내 인사 평가; 급여/);
  assert.match(dry.stdout, /unchanged \(authoritative-entailment-v3, byte-identical\)/);
  assert.match(dry.stdout, /excluded topics \(model-only\)/);
  assert.match(dry.stdout, /preferred language \(model-only\) +ko/);
  assert.match(dry.stdout, /Apply +memex extract rules set .*--expect-revision 0/);
  assert.ok(!fs.existsSync(fixture.rulesFile), '--dry-run must not create the overlay');

  const payload = asJson(ok(fixture, ['rules', 'set', file, '--dry-run', '--json']));
  assert.equal(payload.dryRun, true);
  assert.equal(payload.revision, 0);
  assert.equal(payload.nextRevision, 1);
  assert.match(payload.hash, /^rules:[0-9a-f]{8}$/);
  assert.equal(payload.effectivePolicyVersion, `precision-durability-v4+${payload.hash}`);
  assert.deepEqual(payload.advisoryOnly.excludeTopics, ['사내 인사 평가', '급여']);
  assert.match(payload.rerun, /--expect-revision 0$/);

  // The command the dry run printed is the one that applies.
  const applied = ok(fixture, ['rules', 'set', file, '--expect-revision', '0']);
  assert.match(applied.stdout, /Applied +revision 0 → 1 · none → rules:[0-9a-f]{8}/);
  assert.match(applied.stdout, /Resumed +0 extraction job\(s\) on hold/);
  assert.match(applied.stdout, /action=rules\.set/);

  const doc = readRules(fixture);
  assert.equal(doc.revision, 1);
  assert.equal(doc.never_extract_patterns.length, 1);
  assert.equal(doc.updated_by.surface, 'cli');
  assert.ok(fs.existsSync(path.join(fixture.overlayDir, 'history', 'extraction-rules', '1.json')));

  const audit = fs.readFileSync(path.join(fixture.memexHome, 'logs', 'ui-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"rules\.set"/);
  // §1.4 — the records carry ids, counts and hashes, never rule prose.
  assert.doesNotMatch(audit, /사내 인사 평가/);
  assert.doesNotMatch(audit, new RegExp(SECRET_PATTERN.replace(/[\\[\]{}]/g, '\\$&')));
});

test('set needs --expect-revision once a file exists, and a stale one changes nothing', (t) => {
  const fixture = isolated(t);
  const file = candidate(fixture, 'rules.json', SECRET_RULES);
  ok(fixture, ['rules', 'set', file, '--expect-revision', '0']);
  const before = fs.readFileSync(fixture.rulesFile);

  const unnamed = run(fixture, ['rules', 'set', file]);
  assert.equal(unnamed.status, 1);
  assert.match(both(unnamed), /EXPECTED_REVISION_REQUIRED/);
  assert.match(both(unnamed), /--expect-revision 1/);
  assert.ok(fs.readFileSync(fixture.rulesFile).equals(before), 'an unnamed revision changes nothing');
  assert.equal(asJson(run(fixture, ['rules', 'set', file, '--json'])).error.code, 'EXPECTED_REVISION_REQUIRED');

  const stale = run(fixture, ['rules', 'set', file, '--expect-revision', '7']);
  assert.equal(stale.status, 1);
  assert.match(both(stale), /OVERLAY_STALE +current revision 1 \(expected 7\)/);
  assert.ok(fs.readFileSync(fixture.rulesFile).equals(before), 'a stale write must change nothing');

  const staleJson = asJson(run(fixture, ['rules', 'set', file, '--expect-revision', '7', '--json']));
  assert.equal(staleJson.error.code, 'OVERLAY_STALE');
  assert.equal(staleJson.error.currentRevision, 1);
  assert.equal(staleJson.error.expectedRevision, 7);
});

test('reset needs --yes, rollback restores a snapshot, and history lists both', (t) => {
  const fixture = isolated(t);
  const first = candidate(fixture, 'one.json', SECRET_RULES);
  const second = candidate(fixture, 'two.json', {
    ...SECRET_RULES,
    exclude_topics: ['급여'],
  });
  ok(fixture, ['rules', 'set', first, '--expect-revision', '0']);
  ok(fixture, ['rules', 'set', second, '--expect-revision', '1']);
  const before = fs.readFileSync(fixture.rulesFile);

  const refused = run(fixture, ['rules', 'reset']);
  assert.equal(refused.status, 1);
  assert.match(both(refused), /CONFIRMATION_REQUIRED/);
  assert.ok(fs.readFileSync(fixture.rulesFile).equals(before), 'an unconfirmed reset changes nothing');

  const reset = ok(fixture, ['rules', 'reset', '--yes']);
  assert.match(reset.stdout, /revision 2 → 3/);
  assert.deepEqual(readRules(fixture).never_extract_patterns, []);
  // A reset writes the EMPTY document rather than deleting the file, so the
  // overlay is still present (and still rollback-able) with nothing in it.
  const afterReset = asJson(ok(fixture, ['rules', 'show', '--json']));
  assert.equal(afterReset.present, true);
  assert.equal(afterReset.revision, 3);
  assert.deepEqual(afterReset.rules.neverExtract, []);
  assert.deepEqual(afterReset.rules.excludeTopics, []);
  assert.equal(afterReset.rules.preferredLanguage, null);

  const rolled = ok(fixture, ['rules', 'rollback', '1']);
  assert.match(rolled.stdout, /revision 3 → 4/);
  assert.deepEqual(readRules(fixture).exclude_topics, ['사내 인사 평가', '급여']);

  const missing = run(fixture, ['rules', 'rollback', '999']);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /no snapshot for extraction-rules revision 999/);

  const history = asJson(ok(fixture, ['rules', 'history', '--json']));
  assert.equal(history.count, 4);
  assert.deepEqual(
    history.history.map((entry) => entry.action),
    ['rules.rollback', 'rules.reset', 'rules.set', 'rules.set'],
  );
  assert.ok(history.history.every((entry) => entry.overlay === 'extraction-rules'));
  assert.deepEqual(history.snapshots, [1, 2, 3, 4]);
  assert.match(ok(fixture, ['rules', 'history']).stdout, /History +4 entries/);
});

/**
 * `--dry-run` is the promise that NOTHING moved. The shared parser accepted the
 * flag for every verb, but `reset` and `rollback` had no dry-run branch and did
 * the real write — the rules file, the revision, the snapshot, the history line,
 * and on this side the held jobs were released too.
 */
test('rules reset and rollback honour --dry-run, changing nothing', async (t) => {
  const fixture = isolated(t);
  await seedDb(fixture);
  ok(fixture, ['rules', 'set', candidate(fixture, 'rules.json', SECRET_RULES), '--expect-revision', '0']);
  // A job parked on this overlay: a dry run must not resume it either.
  await writeDb(
    fixture,
    "UPDATE memory_jobs SET hold_reason = 'extraction_rules_invalid' WHERE job_id = 'job-1'",
  );

  const before = fs.readFileSync(fixture.rulesFile);
  const historyBefore = fs.readFileSync(path.join(fixture.overlayDir, 'history.jsonl'));
  const snapshotsBefore = fs.readdirSync(path.join(fixture.overlayDir, 'history', 'extraction-rules')).sort();

  const unchanged = async (label) => {
    assert.ok(fs.readFileSync(fixture.rulesFile).equals(before), `${label}: the overlay changed`);
    assert.ok(
      fs.readFileSync(path.join(fixture.overlayDir, 'history.jsonl')).equals(historyBefore),
      `${label}: a history line was appended`,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.overlayDir, 'history', 'extraction-rules')).sort(),
      snapshotsBefore,
      `${label}: a snapshot was written`,
    );
    assert.equal(
      (await readDb(fixture, "SELECT hold_reason FROM memory_jobs WHERE job_id = 'job-1'")).hold_reason,
      'extraction_rules_invalid',
      `${label}: a held job was released`,
    );
  };

  const reset = asJson(ok(fixture, ['rules', 'reset', '--dry-run', '--json']));
  assert.equal(reset.dryRun, true);
  assert.equal(reset.action, 'rules.reset');
  assert.equal(reset.revision, 1);
  assert.equal(reset.nextRevision, 2);
  assert.match(reset.rerun ?? '', /--yes/);
  await unchanged('rules reset --dry-run');

  const text = ok(fixture, ['rules', 'reset', '--yes', '--dry-run']);
  assert.match(text.stdout, /Dry run — nothing was saved\./);
  await unchanged('rules reset --yes --dry-run');

  const rolled = asJson(ok(fixture, ['rules', 'rollback', '1', '--dry-run', '--json']));
  assert.equal(rolled.dryRun, true);
  assert.equal(rolled.action, 'rules.rollback');
  assert.equal(rolled.fromSnapshot, 1);
  await unchanged('rules rollback --dry-run');

  const missing = run(fixture, ['rules', 'rollback', '999', '--dry-run']);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /SNAPSHOT_NOT_FOUND/);
  await unchanged('rules rollback 999 --dry-run');

  // The real command still works right after, from the revision the dry run named.
  const applied = ok(fixture, ['rules', 'reset', '--yes', '--expect-revision', '1']);
  assert.match(applied.stdout, /revision 1 → 2/);
});

test('test previews the deterministic never_extract block and labels the rest model-only', async (t) => {
  const fixture = isolated(t);
  await seedDb(fixture);
  const file = candidate(fixture, 'rules.json', SECRET_RULES);
  ok(fixture, ['rules', 'set', file, '--expect-revision', '0']);
  const before = fs.readFileSync(fixture.rulesFile);

  const result = ok(fixture, ['rules', 'test', '--recent', '10']);
  assert.match(result.stdout, /Model +0 calls — this command calls no model and no embedding/);
  assert.match(result.stdout, /Active memories: 1 of 2 match never_extract_patterns/);
  assert.match(result.stdout, /fact-sec .*user\.secret/);
  assert.match(result.stdout, /Recent exchanges: 1 of 2 match never_extract_patterns/);
  assert.match(result.stdout, /cannot be checked locally/);
  assert.match(result.stdout, /This command records nothing/);
  assert.ok(fs.readFileSync(fixture.rulesFile).equals(before), 'test must not touch the overlay');

  const payload = asJson(ok(fixture, ['rules', 'test', '--recent', '10', '--json']));
  assert.equal(payload.available, true);
  assert.equal(payload.facts.scanned, 2);
  assert.equal(payload.facts.blocked.length, 1);
  assert.deepEqual(payload.facts.blocked[0].patternIds, ['user.secret']);
  assert.equal(payload.exchanges.blocked.length, 1);
  assert.equal(payload.matcher.failed, null);
  assert.deepEqual(payload.advisoryOnly.decisionHints, ['user.decision']);
  assert.equal(payload.advisoryOnly.preferredLanguage, 'ko');
  assert.match(payload.clause.text, /Never emit a fact or observation whose text matches/);

  // One exchange by id, and an unknown id refused rather than silently empty.
  const single = asJson(ok(fixture, ['rules', 'test', '--exchange', 'ex-clean', '--json']));
  assert.equal(single.exchanges.scanned, 1);
  assert.equal(single.exchanges.blocked.length, 0);
  const unknown = run(fixture, ['rules', 'test', '--exchange', 'no-such-exchange']);
  assert.equal(unknown.status, 1);
  assert.match(both(unknown), /EXCHANGE_UNKNOWN|no exchange /);

  // A candidate file that has NOT been applied can be previewed too.
  const candidateOnly = candidate(fixture, 'other.json', { never_extract_patterns: [] });
  const empty = asJson(ok(fixture, ['rules', 'test', '--file', candidateOnly, '--json']));
  assert.equal(empty.facts.scanned, 0);
  assert.equal(empty.clause.chars, 0);
});

test('reextract lists stale targets, then re-queues them without touching the scheduling key', async (t) => {
  const fixture = isolated(t);
  await seedDb(fixture);
  const file = candidate(fixture, 'rules.json', SECRET_RULES);
  ok(fixture, ['rules', 'set', file, '--expect-revision', '0']);

  // With a database present, `show` answers the two questions that matter when
  // extraction looks stuck: is anything held, and is anything stale?
  const shown = ok(fixture, ['rules', 'show']);
  assert.match(shown.stdout, /Held +none — no extraction job is stopped by the rules/);
  assert.match(shown.stdout, /Drift +1 session\(s\) extracted under different rules \(1 target\(s\)\)/);
  assert.deepEqual(asJson(ok(fixture, ['rules', 'show', '--json'])).drift, { targets: 1, sessions: 1 });

  const undecided = run(fixture, ['rules', 'reextract']);
  assert.equal(undecided.status, 1);
  assert.match(both(undecided), /CONFIRMATION_REQUIRED/);
  assert.match(both(undecided), /needs either --dry-run or --apply/);

  const dry = ok(fixture, ['rules', 'reextract', '--dry-run']);
  assert.match(dry.stdout, /Dry run — nothing was changed\./);
  assert.match(dry.stdout, /Targets +1 completed target\(s\) extracted under different rules · 1 session\(s\) · 2 exchange\(s\)/);
  assert.match(dry.stdout, /target-1 +rules:deadbeef/);
  assert.match(dry.stdout, /policy_version is untouched/);
  assert.equal(
    (await readDb(fixture, 'SELECT state FROM extraction_targets WHERE target_id = ?', ['target-1'])).state,
    'completed',
    '--dry-run must not change the target',
  );

  const dryJson = asJson(ok(fixture, ['rules', 'reextract', '--dry-run', '--json']));
  assert.equal(dryJson.dryRun, true);
  assert.equal(dryJson.targets, 1);
  assert.equal(dryJson.sessions, 1);
  assert.equal(dryJson.items, 2);
  assert.equal(dryJson.sample[0].targetId, 'target-1');
  assert.equal(dryJson.sample[0].rulesHash, 'rules:deadbeef');

  const unconfirmed = run(fixture, ['rules', 'reextract', '--apply']);
  assert.equal(unconfirmed.status, 1);
  assert.match(both(unconfirmed), /CONFIRMATION_REQUIRED/);
  assert.equal(
    (await readDb(fixture, 'SELECT state FROM extraction_targets WHERE target_id = ?', ['target-1'])).state,
    'completed',
    '--apply without --yes must change nothing',
  );

  const applied = asJson(ok(fixture, ['rules', 'reextract', '--apply', '--yes', '--json']));
  assert.equal(applied.requeued, 1);
  assert.equal(applied.changed.extraction_targets, 1);
  assert.equal(applied.changed.memory_jobs, 1);
  assert.equal(applied.changed.exchange_extraction_state, 2);

  const target = await readDb(
    fixture,
    'SELECT state, attempts, rules_hash, policy_version FROM extraction_targets WHERE target_id = ?',
    ['target-1'],
  );
  assert.equal(target.state, 'pending');
  assert.equal(target.attempts, 0);
  assert.equal(target.rules_hash, null);
  // THE regression guard of this design: the scheduling key is untouched, so one
  // edited rule cannot turn the whole corpus back into a backlog.
  assert.equal(target.policy_version, POLICY_VERSION);

  const job = await readDb(fixture, 'SELECT state, attempts, hold_reason FROM memory_jobs WHERE job_id = ?', ['job-1']);
  assert.equal(job.state, 'pending');
  assert.equal(job.attempts, 0);
  assert.equal(job.hold_reason, null);
  assert.equal(
    (await readDb(fixture, 'SELECT state FROM checkpoints WHERE checkpoint_id = ?', ['cp-1'])).state,
    'pending',
  );
  const state = await readDb(
    fixture,
    'SELECT state, processed_at, policy_version FROM exchange_extraction_state WHERE exchange_id = ?',
    ['ex-secret'],
  );
  assert.equal(state.state, 'pending');
  assert.equal(state.processed_at, null);
  assert.equal(state.policy_version, POLICY_VERSION);

  const audit = fs.readFileSync(path.join(fixture.memexHome, 'logs', 'ui-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"rules\.reextract"/);

  // Nothing is stale any more, so a second run has nothing to do.
  assert.equal(asJson(ok(fixture, ['rules', 'reextract', '--dry-run', '--json'])).targets, 0);
});

test('an unknown subcommand is exit 1 and prints the verb list', (t) => {
  const fixture = isolated(t);
  for (const args of [['nope'], ['rules', 'nope']]) {
    const result = run(fixture, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(both(result), /Unknown 'memex extract/);
    assert.match(both(result), /Usage:\n {2}memex extract rules show/);
  }
  const badOption = run(fixture, ['rules', 'show', '--nope']);
  assert.equal(badOption.status, 1);
  assert.match(both(badOption), /unknown option --nope/);
  const jsonRefusal = asJson(run(fixture, ['rules', 'nope', '--json']));
  assert.equal(jsonRefusal.ok, false);
  assert.equal(jsonRefusal.error.code, 'INVALID_USAGE');
  assert.ok(!fs.existsSync(fixture.overlayDir));
});
