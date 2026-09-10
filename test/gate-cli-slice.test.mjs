/**
 * `memex gate` — the CLI slice (issue #29, §7.2).
 *
 * Everything here runs the REAL launcher (`cli/memex.js`) against a throwaway
 * MEMEX_HOME, because the properties worth testing are the ones a unit test
 * cannot see: the exit code, what the overlay directory looks like afterwards,
 * and that a read-only verb leaves the data root byte-identical.
 *
 * The quarantine case is the centrepiece. The reviewer's counterexample
 * (`^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$`, 15 quantifiers) cannot reach the matcher
 * through this surface at all — the grammar parser runs on the LOAD path too, so
 * the file would be refused before a worker ever started. What does reach it is
 * the same family INSIDE the quantifier budget: `^.*a.*a.*a.*a.*a$` parses
 * cleanly, is planted by hand because the write-time probe would reject it, and
 * needs ~330 ms on `'a'×80 + '!'` — so the 50 ms execution box quarantines it
 * and the gate keeps running on the built-ins (fail-safe, §2.3.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('.', import.meta.url).pathname, '..');
const CLI = path.join(REPO, 'cli', 'memex.js');

/** Grammar-legal, probe-rejected, and catastrophic on a failing suffix. */
const SLOW_PATTERN = '^.*a.*a.*a.*a.*a$';
const EVIL_INPUT = `${'a'.repeat(80)}!`;

function isolated(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-gate-cli-'));
  const memexHome = path.join(tmp, 'memex-home');
  const codexHome = path.join(tmp, 'codex-home');
  fs.mkdirSync(memexHome, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  return {
    tmp,
    memexHome,
    overlayDir: path.join(memexHome, 'overlays'),
    gateFile: path.join(memexHome, 'overlays', 'recall-gate.json'),
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
  return spawnSync(process.execPath, [CLI, 'gate', ...args], {
    env: fixture.env,
    encoding: 'utf8',
  });
}

function ok(fixture, args) {
  const result = run(fixture, args);
  assert.equal(result.status, 0, `memex gate ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
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

function readGate(fixture) {
  return JSON.parse(fs.readFileSync(fixture.gateFile, 'utf8'));
}

function plantGate(fixture, doc) {
  fs.mkdirSync(fixture.overlayDir, { recursive: true });
  fs.writeFileSync(
    fixture.gateFile,
    `${JSON.stringify(
      {
        schema: 'memex.recall-gate-overlay',
        version: 1,
        revision: 1,
        updated_at: new Date().toISOString(),
        updated_by: { surface: 'cli' },
        patterns: { add: [], disable: [] },
        words: { add: { ack: [], continue: [], filler: [] }, disable: { ack: [], continue: [], filler: [] } },
        ...doc,
      },
      null,
      2,
    )}\n`,
  );
}

const HELP_FORMS = [
  [],
  ['show'],
  ['patterns'],
  ['patterns', 'add'],
  ['patterns', 'disable'],
  ['words'],
  ['words', 'add'],
  ['test'],
  ['replay'],
  ['validate'],
  ['history'],
  ['quarantine'],
  ['quarantine', 'clear'],
  ['reset'],
  ['rollback'],
];

test('--help prints the verb list, exits 0 and writes nothing (#36)', (t) => {
  const fixture = isolated(t);
  for (const form of HELP_FORMS) {
    for (const flag of ['--help', '-h']) {
      const result = run(fixture, [...form, flag]);
      assert.equal(result.status, 0, `${form.join(' ')} ${flag}: ${result.stderr}`);
      assert.match(result.stdout, /Usage:\n {2}memex gate show/);
      // The side effect each write verb would have, named:
      assert.doesNotMatch(result.stdout, /revision \d+ → \d+/);
      assert.doesNotMatch(result.stdout, /action=gate\./);
    }
  }
  assert.ok(!fs.existsSync(fixture.overlayDir), 'no overlay directory may be created by --help');
});

test('show reports built-in defaults, the 50 ms budget and the sharing caveat', (t) => {
  const fixture = isolated(t);
  const result = ok(fixture, ['show']);
  assert.match(result.stdout, /상태 +없음 — 내장 기본값만 적용됩니다/);
  assert.match(result.stdout, /50ms 상한/);
  assert.match(result.stdout, /기기 간에 공유되지 않습니다 \(0\.7\.1 예정\)/);
  assert.ok(!fs.existsSync(fixture.overlayDir), 'a read must not create the overlay directory');

  const payload = asJson(ok(fixture, ['show', '--json']));
  assert.equal(payload.ok, true);
  assert.equal(payload.present, false);
  assert.equal(payload.shared, false);
  assert.equal(payload.matchWallMs, 50);
  assert.equal(payload.user.added, 0);
  assert.ok(payload.builtin.patterns.total > 50);
});

test('patterns add writes one revision, a snapshot, a history line and an audit line', (t) => {
  const fixture = isolated(t);
  const added = ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력', '--note', '배포 이력은 항상 회수']);
  assert.match(added.stdout, /추가 +user\.[0-9a-f]{8} {2}intent=memory/);
  assert.match(added.stdout, /revision 0 → 1/);
  assert.match(added.stdout, /action=gate\.pattern-add/);

  const doc = readGate(fixture);
  assert.equal(doc.revision, 1);
  assert.equal(doc.patterns.add.length, 1);
  assert.equal(doc.patterns.add[0].intent, 'memory');
  assert.equal(doc.patterns.add[0].note, '배포 이력은 항상 회수');
  assert.equal(doc.updated_by.surface, 'cli');

  assert.ok(fs.existsSync(path.join(fixture.overlayDir, 'history', 'recall-gate', '1.json')));
  const history = fs
    .readFileSync(path.join(fixture.overlayDir, 'history.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(history.length, 1);
  assert.equal(history[0].overlay, 'recall-gate');
  assert.equal(history[0].to_revision, 1);
  assert.equal(history[0].added.length, 1);

  const audit = fs.readFileSync(path.join(fixture.memexHome, 'logs', 'ui-audit.jsonl'), 'utf8');
  assert.match(audit, /"action":"gate\.pattern-add"/);
  // §1.4 — the three records carry ids, counts and hashes, never rule prose.
  assert.doesNotMatch(audit, /배포 이력은 항상 회수/);

  const shown = asJson(ok(fixture, ['show', '--json']));
  assert.equal(shown.revision, 1);
  assert.match(shown.hash, /^gate:[0-9a-f]{8}$/);
  assert.equal(shown.user.added, 1);
});

test('the reviewer counterexample is refused with exit 1 and no file at all', (t) => {
  const fixture = isolated(t);
  const result = run(fixture, ['patterns', 'add', 'memory', '^a+b?a+b?a+b?a+b?a+b?a+b?a+b?a+$']);
  assert.equal(result.status, 1);
  assert.match(both(result), /거부 — 아무것도 저장하지 않았습니다\./);
  assert.match(both(result), /error +REGEX_QUANTIFIER_BUDGET/);
  assert.match(both(result), /문법 검사만으로는 이런 패턴을 전부 걸러낼 수 없습니다/);
  assert.ok(!fs.existsSync(fixture.gateFile), 'a refused write may not create the overlay');

  const payload = asJson(run(fixture, ['patterns', 'add', 'memory', '(a+)+$', '--json']));
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'OVERLAY_INVALID');
  const issue = payload.error.issues.find((entry) => entry.severity === 'error');
  assert.match(issue.path, /^patterns\.add\[\d+\]\.source$/);
  assert.match(issue.key, /^overlays\.issue\./);
  assert.equal(typeof issue.message, 'string');
});

test('--expect-revision refuses a write that raced, and --dry-run writes nothing', (t) => {
  const fixture = isolated(t);
  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  const before = fs.readFileSync(fixture.gateFile);

  const stale = run(fixture, ['patterns', 'add', 'trace', '결정\\s*근거', '--expect-revision', '7']);
  assert.equal(stale.status, 1);
  assert.match(both(stale), /OVERLAY_STALE +현재 revision 1 \(기대 7\)/);
  assert.ok(fs.readFileSync(fixture.gateFile).equals(before), 'a stale write must change nothing');

  const staleJson = asJson(run(fixture, ['patterns', 'add', 'trace', '결정', '--expect-revision', '7', '--json']));
  assert.equal(staleJson.error.code, 'OVERLAY_STALE');
  assert.equal(staleJson.error.currentRevision, 1);
  assert.equal(staleJson.error.expectedRevision, 7);

  const dry = ok(fixture, ['patterns', 'add', 'trace', '결정\\s*근거', '--dry-run']);
  assert.match(dry.stdout, /시험 실행 — 아무것도 저장하지 않았습니다\./);
  assert.match(dry.stdout, /다음 +memex gate patterns add trace .*--expect-revision 1/);
  assert.ok(fs.readFileSync(fixture.gateFile).equals(before), '--dry-run must change nothing');

  // The command the dry run printed is the one that applies.
  const applied = ok(fixture, ['patterns', 'add', 'trace', '결정\\s*근거', '--expect-revision', '1']);
  assert.match(applied.stdout, /revision 1 → 2/);
});

test('a built-in is disabled by id, listed, and switched back on', (t) => {
  const fixture = isolated(t);
  const disabled = ok(fixture, ['patterns', 'disable', 'ack.en.1']);
  assert.match(disabled.stdout, /비활성 +ack\.en\.1/);
  assert.deepEqual(readGate(fixture).patterns.disable, ['ack.en.1']);

  const list = asJson(ok(fixture, ['patterns', 'list', '--source', 'disabled', '--json']));
  assert.equal(list.count, 1);
  assert.equal(list.patterns[0].id, 'ack.en.1');
  assert.equal(list.patterns[0].origin, 'builtin');
  assert.equal(list.patterns[0].state, 'disabled');

  // `remove` is the design document's alias for the same operation.
  const aliased = ok(fixture, ['patterns', 'remove', 'ack.kr.1']);
  assert.match(aliased.stdout, /비활성 +ack\.kr\.1/);

  const back = ok(fixture, ['patterns', 'enable', 'ack.en.1']);
  assert.match(back.stdout, /재활성 +ack\.en\.1/);
  assert.deepEqual(readGate(fixture).patterns.disable, ['ack.kr.1']);

  const notDisabled = run(fixture, ['patterns', 'enable', 'ack.en.1']);
  assert.equal(notDisabled.status, 1);
  assert.match(both(notDisabled), /PATTERN_NOT_DISABLED/);

  const unknown = run(fixture, ['patterns', 'disable', 'nope.not.real']);
  assert.equal(unknown.status, 1);
  assert.match(both(unknown), /PATTERN_UNKNOWN/);
});

test('a user pattern is deleted by id, not disabled', (t) => {
  const fixture = isolated(t);
  const added = ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  const id = added.stdout.match(/user\.[0-9a-f]{8}/)[0];
  ok(fixture, ['patterns', 'disable', id]);
  const doc = readGate(fixture);
  assert.deepEqual(doc.patterns.add, []);
  assert.deepEqual(doc.patterns.disable, []);
});

test('words add/remove move the side of the document that matches the intent', (t) => {
  const fixture = isolated(t);
  ok(fixture, ['words', 'add', 'ack', 'ㅇㅈ']);
  assert.deepEqual(readGate(fixture).words.add.ack, ['ㅇㅈ']);

  const listed = asJson(ok(fixture, ['words', 'list', '--json']));
  assert.deepEqual(listed.user.add.ack, ['ㅇㅈ']);
  assert.ok(listed.builtin.ack.length > 10);

  // Removing an added word deletes it; removing a BUILT-IN word disables it.
  ok(fixture, ['words', 'remove', 'ack', 'ㅇㅈ']);
  assert.deepEqual(readGate(fixture).words.add.ack, []);

  const builtinWord = listed.builtin.ack[0];
  ok(fixture, ['words', 'remove', 'ack', builtinWord]);
  assert.deepEqual(readGate(fixture).words.disable.ack, [builtinWord]);
  ok(fixture, ['words', 'add', 'ack', builtinWord]);
  assert.deepEqual(readGate(fixture).words.disable.ack, []);

  const missing = run(fixture, ['words', 'remove', 'ack', 'definitely-not-a-word']);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /WORD_UNKNOWN/);
  const lexicon = run(fixture, ['words', 'add', 'nope', 'x']);
  assert.equal(lexicon.status, 1);
  assert.match(both(lexicon), /unknown lexicon/);
});

test('test explains which rules fired, from where, and records nothing', (t) => {
  const fixture = isolated(t);
  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  ok(fixture, ['patterns', 'disable', 'ack.en.1']);
  const before = fs.readFileSync(fixture.gateFile);

  const result = ok(fixture, ['test', '배포 이력 좀 보여줘']);
  assert.match(result.stdout, /memory +● 발화 +user\.[0-9a-f]{8} \(사용자\)/);
  assert.match(result.stdout, /판정 +retrieve/);
  assert.match(result.stdout, /triggers +explicit_memory_intent/);
  assert.match(result.stdout, /비활성 +ack\.en\.1/);
  assert.match(result.stdout, /상태 가정 +--session 없음 → 중립 상태/);
  assert.match(result.stdout, /임베딩 +0회/);
  assert.match(result.stdout, /이 명령은 아무것도 기록하지 않습니다/);

  assert.ok(fs.readFileSync(fixture.gateFile).equals(before), 'test must not touch the overlay');
  assert.ok(!fs.existsSync(path.join(fixture.memexHome, 'logs', 'inject-context.jsonl')));
  assert.ok(!fs.existsSync(path.join(fixture.memexHome, 'conversation-index')));

  const builtinFired = ok(fixture, ['test', '왜 auth를 supabase로 바꿨지?', '--json']);
  const payload = asJson(builtinFired);
  assert.equal(payload.intents.memory.fired, true);
  assert.ok(payload.intents.memory.matched.every((entry) => entry.origin === 'builtin'));
  assert.equal(payload.stateSource, 'neutral');
  assert.equal(payload.matcher.timedOut, false);

  const compared = asJson(ok(fixture, ['test', '배포 이력 좀 보여줘', '--compare-builtin', '--json']));
  assert.equal(compared.decision.action, 'retrieve');
  assert.notEqual(compared.builtinOnly.action, 'retrieve');
  assert.equal(compared.diffCause.length, 1);
  assert.match(compared.diffCause[0].id, /^user\./);
  assert.equal(compared.diffCause[0].intent, 'memory');
});

test('an unknown --session is refused instead of silently judged neutral', (t) => {
  const fixture = isolated(t);
  const result = run(fixture, ['test', '배포 이력', '--session', 'no-such-session']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /SESSION_UNKNOWN|게이트 상태가 없습니다/);
});

test('a slow planted pattern is quarantined by the 50 ms box, listed, and cleared', (t) => {
  const fixture = isolated(t);
  // Planted by hand: the write path's 300 ms probe refuses this shape, and that
  // refusal is exactly what makes the runtime box the only real guarantee.
  const rejected = run(fixture, ['patterns', 'add', 'memory', SLOW_PATTERN]);
  assert.equal(rejected.status, 1);
  assert.match(both(rejected), /PATTERN_TOO_SLOW/);

  plantGate(fixture, {
    patterns: { add: [{ id: 'user.slowcase', intent: 'memory', source: SLOW_PATTERN, flags: '' }], disable: [] },
  });

  const tested = asJson(ok(fixture, ['test', EVIL_INPUT, '--json']));
  assert.equal(tested.matcher.timedOut, true);
  assert.deepEqual(tested.matcher.quarantined, ['user.slowcase']);
  // Fail-safe: the prompt was still judged, on the built-ins alone.
  assert.ok(['retrieve', 'skip', 'ambiguous'].includes(tested.decision.action));

  const listed = ok(fixture, ['quarantine', 'list']);
  assert.match(listed.stdout, /격리된 패턴 1개/);
  assert.match(listed.stdout, /user\.slowcase/);
  assert.match(listed.stdout, /ms 초과/);

  const shown = asJson(ok(fixture, ['show', '--json']));
  assert.equal(shown.user.quarantined, 1);
  assert.ok(shown.issues.some((issue) => issue.code === 'PATTERN_QUARANTINED' && issue.severity === 'error'));

  const quarantinedRows = asJson(ok(fixture, ['patterns', 'list', '--source', 'quarantined', '--json']));
  assert.equal(quarantinedRows.count, 1);
  assert.equal(quarantinedRows.patterns[0].state, 'quarantined');

  // `validate` is what doctor points at, so the quarantine has to fail there.
  const validated = run(fixture, ['validate']);
  assert.equal(validated.status, 1);
  assert.match(both(validated), /PATTERN_QUARANTINED/);

  const cleared = asJson(ok(fixture, ['quarantine', 'clear', 'user.slowcase', '--json']));
  assert.equal(cleared.cleared, 1);
  assert.deepEqual(cleared.ids, ['user.slowcase']);
  assert.equal(asJson(ok(fixture, ['quarantine', 'list', '--json'])).count, 0);
  assert.equal(asJson(ok(fixture, ['show', '--json'])).user.quarantined, 0);

  const clearAgain = asJson(ok(fixture, ['quarantine', 'clear', '--all', '--json']));
  assert.equal(clearAgain.cleared, 0);
  const needsTarget = run(fixture, ['quarantine', 'clear']);
  assert.equal(needsTarget.status, 1);
  assert.match(both(needsTarget), /needs <pattern-id> or --all/);
});

test('editing a pattern clears its quarantine row without asking', (t) => {
  const fixture = isolated(t);
  plantGate(fixture, {
    patterns: { add: [{ id: 'user.slowcase', intent: 'memory', source: SLOW_PATTERN, flags: '' }], disable: [] },
  });
  ok(fixture, ['test', EVIL_INPUT]);
  assert.equal(asJson(ok(fixture, ['quarantine', 'list', '--json'])).count, 1);

  const removed = ok(fixture, ['patterns', 'disable', 'user.slowcase']);
  assert.match(removed.stdout, /격리 해제 +user\.slowcase/);
  assert.equal(asJson(ok(fixture, ['quarantine', 'list', '--json'])).count, 0);
});

test('validate prints issue rows with path and severity and exits 1 on errors', (t) => {
  const fixture = isolated(t);
  const absent = ok(fixture, ['validate']);
  assert.match(absent.stdout, /없음 — 내장 기본값만 적용됩니다/);

  const broken = path.join(fixture.tmp, 'broken.json');
  fs.writeFileSync(
    broken,
    JSON.stringify({
      schema: 'memex.recall-gate-overlay',
      version: 1,
      revision: 3,
      patterns: {
        add: [
          { id: 'user.bad', intent: 'nonsense', source: 'x', flags: 'i' },
          { id: 'user.back', intent: 'memory', source: '(a)\\1', flags: 'i' },
        ],
        disable: ['no.such.builtin'],
      },
      surprise: true,
    }),
  );
  const result = run(fixture, ['validate', '--file', broken]);
  assert.equal(result.status, 1);
  assert.match(both(result), /error +INTENT_UNKNOWN +patterns\.add\[0\]\.intent/);
  assert.match(both(result), /error +REGEX_BACKREFERENCE +patterns\.add\[1\]\.source/);
  assert.match(both(result), /warning +DISABLE_ID_UNKNOWN/);
  assert.match(both(result), /warning +OVERLAY_UNKNOWN_FIELD/);

  const payload = asJson(run(fixture, ['validate', '--file', broken, '--json']));
  assert.equal(payload.ok, false);
  assert.ok(payload.issues.some((issue) => issue.code === 'INTENT_UNKNOWN' && issue.severity === 'error'));
  assert.ok(payload.issues.every((issue) => typeof issue.key === 'string'));

  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  const valid = asJson(ok(fixture, ['validate', '--json']));
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.issues.filter((issue) => issue.severity === 'error'), []);
});

test('reset needs --yes, and rollback restores a kept snapshot', (t) => {
  const fixture = isolated(t);
  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  ok(fixture, ['patterns', 'add', 'trace', '결정\\s*근거']);
  const before = fs.readFileSync(fixture.gateFile);

  const refused = run(fixture, ['reset']);
  assert.equal(refused.status, 1);
  assert.match(both(refused), /CONFIRMATION_REQUIRED/);
  assert.ok(fs.readFileSync(fixture.gateFile).equals(before), 'an unconfirmed reset changes nothing');

  const scoped = ok(fixture, ['reset', '--intent', 'trace', '--yes']);
  assert.match(scoped.stdout, /revision 2 → 3/);
  assert.equal(readGate(fixture).patterns.add.length, 1);
  assert.equal(readGate(fixture).patterns.add[0].intent, 'memory');

  const all = ok(fixture, ['reset', '--yes']);
  assert.match(all.stdout, /revision 3 → 4/);
  assert.deepEqual(readGate(fixture).patterns.add, []);

  const rolled = ok(fixture, ['rollback', '--to', '2']);
  assert.match(rolled.stdout, /revision 4 → 5/);
  assert.equal(readGate(fixture).patterns.add.length, 2);

  const missing = run(fixture, ['rollback', '--to', '999']);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /no snapshot for recall-gate revision 999/);

  const history = asJson(ok(fixture, ['history', '--json']));
  assert.equal(history.count, 5);
  assert.deepEqual(
    history.history.map((entry) => entry.action),
    ['gate.rollback', 'gate.reset', 'gate.reset', 'gate.pattern-add', 'gate.pattern-add'],
  );
  assert.ok(history.history.every((entry) => entry.overlay === 'recall-gate'));
  assert.deepEqual(history.snapshots, [1, 2, 3, 4, 5]);
});

/**
 * `--dry-run` is the promise that NOTHING moved. The shared parser accepted the
 * flag for every verb, but `reset` and `rollback` had no dry-run branch at all and
 * performed the real write — the rules file, the revision, the snapshot and the
 * history line all changed while the operator was told it was a trial.
 */
test('reset and rollback honour --dry-run, changing nothing', (t) => {
  const fixture = isolated(t);
  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);
  ok(fixture, ['patterns', 'add', 'trace', '결정\\s*근거']);
  const before = fs.readFileSync(fixture.gateFile);
  const historyBefore = fs.readFileSync(path.join(fixture.overlayDir, 'history.jsonl'));
  const snapshotsBefore = fs.readdirSync(path.join(fixture.overlayDir, 'history', 'recall-gate')).sort();

  const unchanged = (label) => {
    assert.ok(fs.readFileSync(fixture.gateFile).equals(before), `${label}: the overlay changed`);
    assert.ok(
      fs.readFileSync(path.join(fixture.overlayDir, 'history.jsonl')).equals(historyBefore),
      `${label}: a history line was appended`,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(fixture.overlayDir, 'history', 'recall-gate')).sort(),
      snapshotsBefore,
      `${label}: a snapshot was written`,
    );
  };

  // A dry run does not need --yes: it writes nothing, so demanding the
  // confirmation would only teach the habit of typing it.
  const full = asJson(ok(fixture, ['reset', '--dry-run', '--json']));
  assert.equal(full.dryRun, true);
  assert.equal(full.revision, 2);
  assert.equal(full.nextRevision, 3);
  assert.match(full.rerun, /reset .*--yes/);
  assert.match(full.rerun, /--expect-revision 2/);
  unchanged('reset --dry-run');

  const scoped = asJson(ok(fixture, ['reset', '--intent', 'trace', '--dry-run', '--json']));
  assert.equal(scoped.dryRun, true);
  unchanged('reset --intent --dry-run');

  const text = ok(fixture, ['reset', '--yes', '--dry-run']);
  assert.match(text.stdout, /시험 실행 — 아무것도 저장하지 않았습니다\./);
  unchanged('reset --yes --dry-run');

  const rolled = asJson(ok(fixture, ['rollback', '--to', '1', '--dry-run', '--json']));
  assert.equal(rolled.dryRun, true);
  assert.equal(rolled.nextRevision, 3);
  unchanged('rollback --dry-run');

  const missing = run(fixture, ['rollback', '--to', '999', '--dry-run']);
  assert.equal(missing.status, 1);
  assert.match(both(missing), /SNAPSHOT_NOT_FOUND/);
  unchanged('rollback --to 999 --dry-run');

  // And the real thing still works right after, from the revision the dry run
  // reported.
  const applied = ok(fixture, ['reset', '--yes', '--expect-revision', '2']);
  assert.match(applied.stdout, /revision 2 → 3/);
});

test('replay compares built-in and overlay verdicts over recent prompts, writing nothing', async (t) => {
  const fixture = isolated(t);
  const quiet = ok(fixture, ['replay']);
  assert.match(quiet.stdout, /비교할 것이 없습니다/);

  ok(fixture, ['patterns', 'add', 'memory', '배포\\s*이력']);

  // A real database, because `replay` reads the prompts the gate actually saw.
  const previous = { home: process.env.MEMEX_HOME, db: process.env.MEMEX_DB_PATH };
  process.env.MEMEX_HOME = fixture.memexHome;
  delete process.env.MEMEX_DB_PATH;
  const { initDatabase } = await import(path.join(REPO, 'dist/db.js'));
  const db = initDatabase();
  const insert = db.prepare(`INSERT INTO exchanges
      (id, project, timestamp, user_message, assistant_message, archive_path,
       line_start, line_end, session_id, cwd, is_sidechain)
    VALUES (?, '/tmp/gate-replay', ?, ?, 'a', '/tmp/gate-replay/r.jsonl', 1, 2, 'session-1', '/tmp/gate-replay', 0)`);
  insert.run('gate-replay-1', '2026-09-01T00:00:00.000Z', '배포 이력 좀 보여줘');
  insert.run('gate-replay-2', '2026-09-02T00:00:00.000Z', 'ㅇㅋ');
  db.close();
  if (previous.home === undefined) delete process.env.MEMEX_HOME;
  else process.env.MEMEX_HOME = previous.home;
  if (previous.db !== undefined) process.env.MEMEX_DB_PATH = previous.db;

  const payload = asJson(ok(fixture, ['replay', '--limit', '5', '--json']));
  assert.equal(payload.considered, 2);
  assert.equal(payload.changed, 1);
  const changed = payload.rows.find((entry) => entry.builtinOnly !== entry.overlay);
  assert.equal(changed.prompt, '배포 이력 좀 보여줘');
  assert.equal(changed.overlay, 'retrieve');
  assert.match(changed.diffCause[0].id, /^user\./);

  const text = ok(fixture, ['replay', '--limit', '5']);
  assert.match(text.stdout, /변화 +1개 \/ 2개/);
  assert.match(text.stdout, /모델·임베딩 호출 0회/);
  assert.ok(!fs.existsSync(path.join(fixture.memexHome, 'logs', 'inject-context.jsonl')));

  const scoped = asJson(ok(fixture, ['replay', '--project', '/nowhere', '--json']));
  assert.equal(scoped.considered, 0);
});

test('an unknown subcommand is exit 1 and prints the verb list', (t) => {
  const fixture = isolated(t);
  for (const args of [['nope'], ['patterns', 'nope'], ['words', 'nope'], ['quarantine', 'nope']]) {
    const result = run(fixture, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(both(result), /Unknown 'memex gate/);
    assert.match(both(result), /Usage:\n {2}memex gate show/);
  }
  const badOption = run(fixture, ['show', '--nope']);
  assert.equal(badOption.status, 1);
  assert.match(both(badOption), /unknown option --nope/);
  assert.ok(!fs.existsSync(fixture.overlayDir));
});
