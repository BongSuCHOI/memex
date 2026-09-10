# Changelog

All notable changes to Memex are documented here. Dates use Asia/Seoul.

## 0.6.6 - unreleased

Cross-device sync hotfixes found by re-auditing the 0.6.3 (#48) manual-file and
preview paths against their own contracts. The headline is a privacy-contract
break: with the switch OFF, one `memex sync export --archive` still published
memories into the shared folder.

### Cross-device sync

- `memex sync export --archive` (and the Web UI `archive-export` action) no
  longer touches the shared folder. It used to call the exporter with no
  destination, so the exporter resolved the configured iCloud/Dropbox/Syncthing
  folder and CREATED it: with sync disabled — and even after the user had
  deleted the folder — the folder came back and a full generation of plaintext
  memories went into it, while `memex sync status` still printed `Sync: OFF` and
  listed a device. The archive is now built in a private staging directory
  inside the data root, zipped, and the staging directory removed, so nothing
  reaches the shared folder, no peer gets an extra generation to import, and the
  deliberate absence of an `export-status.json` update is finally consistent.
  `exportForSync({ syncDir })` is the new seam. (#95)
- `memex sync import --archive --dry-run` no longer creates or migrates a
  database. Both the device-identity check and the preview itself opened the DB
  with `initDatabase()`, which created the file and ran every
  `CREATE TABLE`/`ALTER TABLE` migration plus a normalizing `UPDATE` *before*
  the rollback-only transaction opened, so none of it could be undone: a
  dry-run on a machine with no index left an empty 880 KB database behind, and a
  dry-run on an older schema migrated it irreversibly. The identity check is now
  read-only, and a preview with no local index is rejected with
  "no local index yet — run `memex sync` once before previewing an import"
  instead of building one. (#97)
- An import preview now reflects the incoming tombstones before it plans the
  facts, the order an apply uses. The two plans used to be computed
  independently against the untouched database, and the fact plan reads only the
  LOCAL `fact_tombstones` table, so a fact the apply would skip could be
  announced as `+1`/`~1` with a conflict the apply never records. Both run
  inside the same always-rolled-back transaction. A single export still never
  carries a fact row and a tombstone for the same id — that invariant is now
  pinned by a test. (#103)
- The archive output path is confined by REAL location, not by a path string. A
  `path.resolve()` prefix test does not resolve symlinks, so one link inside the
  data root carried a write outside it, and the default destination was not
  checked at all. The deepest existing ancestor is now resolved with `realpath`
  on both sides, a final component that is itself a symlink is refused rather
  than followed, and the default `<data root>/sync/exports/…` path is held to
  the same rule. Resolving the root too fixes the mirror image: a data root
  reached through a link (macOS `/var` → `/private/var`) no longer rejects
  legitimate absolute paths naming its own files. (#101)
- `memex sync alias <name>` is propagated by the next automatic export. The name
  travels in every generation's `meta.json` as `device_alias`, but the export
  gate's fingerprint only read the database, so renaming (or un-naming) this
  device reported `skipped: "unchanged"` forever and the other Mac kept showing
  the old name or a UUID until some unrelated durable change happened or the
  user passed `--force`. This device's own alias is now part of
  `durableStateFingerprint()`; a name this machine gives a PEER is a local
  override that never travels and still triggers nothing. (#98)

### Upgrade

Run `memex update` and restart Codex. No schema change. One behaviour change to
know about: on a machine that has never built an index, `memex sync import
--archive … --dry-run` now refuses with "no local index yet" instead of creating
one — run `memex sync` once first (the apply path is unchanged).

## 0.6.5 - 2026-09-10

Hotfix for the embedding-model cache location (#92), found while validating
0.6.4 on a live data root: the cache lived inside each plugin root's
`node_modules`, so every update re-downloaded the 129 MB model, the first
prompts after an update took about 68 seconds, and a fresh per-session daemon
exceeded its compute budget on its first request while the hook's fallback
downloaded the same model concurrently.

### Embedding model cache

- The model cache now lives in the data root (`<data root>/models`,
  `MEMEX_MODEL_CACHE_DIR` overrides) and survives plugin updates and execution
  roots. On first use a legacy per-root cache (the running root, other versions
  under the Codex plugin cache, or the launcher root) is copied once — never
  moved — and the copy is logged. `src/model-cache.ts` answers "is the model
  here?" without loading the runtime. (#92)
- A daemon that is still warming its model answers `{type:"warming"}` instead
  of spending the 10 s compute budget; the hook records `reason:"warming"` and
  falls back at once. Socket owners preload the model in the background right
  after binding. (#92)
- `memex deps warm` downloads and exercises the model once; `memex update` and
  `memex deps materialize` run it automatically when the cache is empty
  (`--no-warm` skips it, `MEMEX_WARM_TIMEOUT_MS` bounds it, failure is a
  warning). (#92)
- `memex doctor` gains `embedding-cache`: location, resolution source, model
  id, file count and size; a missing cache warns with `Run: memex deps warm`,
  and an interrupted download is told apart from a complete one. (#92)

### Tests

- Vitest and the `.mjs` suites pin the model cache to the checkout's
  transformers cache, so no test downloads a model or writes to a real data
  root; the rule is recorded in `docs/VERIFICATION.md` §2.

### Upgrade

Run `memex update` (it now warms the model cache once — expect a single
download of about 129 MB into `<data root>/models`, or a copy from a legacy
cache) and restart Codex. No schema change.

## 0.6.4 - 2026-09-10

Hotfix for the inject-daemon ownership gap found while validating 0.6.3 on a
live data root (#89): Codex runs several MCP servers, and when the one that
owned the fast-path socket exited, the others never reclaimed it, so every
prompt paid the cold in-process path and `memex doctor` reported `no daemon`.

### Injection fast path

- A server that could not bind the socket keeps re-probing it — every 20
  seconds (`MEMEX_INJECT_DAEMON_REACQUIRE_MS`, timer unref'd) and
  opportunistically on each of its own MCP requests — and reclaims an orphaned
  socket through the same dead-socket / retire rules the start-up path uses.
  An owner unlinks its socket and releases the bind lock on SIGTERM, SIGINT,
  stdin close and normal exit, then re-raises the signal. (#89)
- The hook classifies a refused fast path as `absent` (no socket), `refused`
  (stale file), `handshake timeout`, `compute timeout` or `identity mismatch`,
  falls back immediately on the first two, and applies the 3 s budget to
  connect + handshake only: the daemon answers the handshake with an `ack`
  carrying its identity before it computes, and the compute wait shares the
  daemon's own 10 s per-connection budget (`MEMEX_INJECT_COMPUTE_TIMEOUT_MS`
  for tests). (#89)
- A bundle whose requesting hook has already fallen back is rolled back inside
  the transaction (`status: "abandoned"`), so no `prepared` recall receipt is
  left behind. (#89)
- `memex doctor` reports `inject-daemon` as `absent`, `stale` (with the
  servers waiting to reclaim), `hung`, `ok` or `mismatch`; `stale` is a
  warning only when no candidate server exists. (#89)

### Upgrade

Run `memex update` and restart Codex. No schema change. A small
`conversation-index/inject-daemon.candidates/` directory records which MCP
servers are waiting to reclaim the socket.

## 0.6.3 - 2026-09-10

Closes the remaining findings of the external code review of 0.6.0–0.6.1
(#59–#80), completes the cross-device sync surface (#48), and fixes the
inject-daemon ownership defect found while validating 0.6.2 (#84).

### Injection fast path

- The warm inject daemon is verified in both directions before it computes
  or injects: the hook sends its version, build id, plugin root and DB path,
  the daemon answers with its own identity and computes only on a full match,
  and the hook accepts a result only when the echoed identity matches. Any
  other daemon — an older build, a development checkout, a different DB — is
  bypassed with an in-process fallback and logged as `daemon_mismatch`. A
  development checkout no longer opens the socket unless
  `MEMEX_INJECT_DAEMON=1`; socket ownership is serialized through
  `inject-daemon.lock`, dead sockets are reclaimed, live foreign owners are
  asked to retire cooperatively, and `memex doctor` reports the owner against
  the installed plugin root (`inject-daemon`). (#84)
- Injection-gate telemetry counts `passed` / `rejected` from the raw margin
  gaps; `dims.gaps` keeps the rounded display values. (#75)

### Memory tiers

- An automatic promotion survives only while its cited witnesses are active
  and still carry the same normalized text; a corrected witness demotes the
  fact in the same pass a deactivation would. (#62)
- Default-branch detection reads the user's global and system
  `init.defaultBranch` after the repository config, in git's precedence order,
  so a `trunk`-style default branch is not classified as a feature branch. (#65)

### Work Capsule

- List bounds truncate instead of failing the job: a list over eight items
  keeps the first eight and records `itemCaps` `{kept, dropped}` in the
  truncation ledger; evidence-bearing lists re-check their declared sources
  after truncation. (#85)
- Truncation guarantees `finalChars <= maxChars` with a last-resort scalar
  loop and reports `overBudget` when it still cannot. (#74)

### Ontology

- `memex ontology merge` and `rename` bump the taxonomy epoch inside their
  transaction, so an in-flight classification built on the old candidate set
  is discarded instead of re-creating the merged category. (#73)

### Cross-device sync

- A generation can be handed over as a file: `memex sync export --archive
  [path.zip]` and `memex sync import --archive <path> [--dry-run]`, and in
  관리 › 동기화 export → validate → preview `+N / ~N / -N` (computed by the real
  import planner inside a rolled-back transaction) → confirm → import. The zip
  reader/writer is dependency-free and rejects zip-slip paths. (#48)
- Devices can be named (`sync/devices.json`, `memex sync alias`); the alias
  travels in `meta.json` so peers show it. (#48)
- Every import decision where a peer overrode local memory, or local won, is
  recorded as a local-only Chronicle `SYNC_IMPORTED` event and shown in
  지식 변경 and the fact's 변경 이력 as "기기 <alias>에서 가져옴". (#48)

### Installed-root resolution

- A probing resolution asks `codex plugin list --json` before scanning the
  Codex plugin cache, caches the answer per process, and `memex doctor` says
  when a cache pick was a guess. (#69)

### Web UI

- Every core mutation the UI performs runs with `MEMEX_HOME` / `MEMEX_DB_PATH`
  pinned, so the core's audit line lands under the UI's own data root. (#78)
- A dead or retrying job is classified by its state before its error text, the
  pre-0.6.0 Capsule bound failure is its own non-ignorable class, short
  failure enums match on word boundaries, and `LLM call failed` maps to a new
  `model-call-failed` class instead of `model-invalid-json`. (#79, #80)

### Tests

- Test suites that call the ontology admin commands now pin `MEMEX_HOME` and
  `XDG_CONFIG_HOME` to their temp root and assert where the audit line landed;
  Vitest runs with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`.

### Upgrade

Run `memex update` and restart Codex — restarting is required this time so the
installed 0.6.3 MCP server takes over the inject socket from any older daemon;
until then hooks fall back to in-process injection and log the mismatch. Schema
version stays 7; `work_capsules.truncated_fields_json` may now hold an object
(older array values are still read). A new transient file
`conversation-index/inject-daemon.lock` appears during daemon start-up.

## 0.6.2 - 2026-09-10

Hotfix release for the defects an external code review of 0.6.0–0.6.1 found
(#59–#80). Every fix carries a regression test that reproduces the reported
state; the remaining review items ship in 0.6.3.

### Memory tiers

- A model-emitted `scope_directive` no longer carries user authority. It is
  applied only when the candidate is `explicit` and has at least one
  human-evidence exchange; otherwise it is dropped into `classifier_notes`.
  Before, a tool-only candidate could be promoted two steps to global as a
  `user-directive` with `human-decision` authority. (#59)
- Evidence-based auto promotion requires the same normalized fact text across
  the confirming branches. A slot that holds conflicting branch truths is
  skipped with `slot has conflicting branch truths` instead of promoting
  whichever fact was created first. (#60)
- The demotion pass acts only when the fact's latest tier event is the auto
  promotion it is reversing, and demotes explicitly to the recorded
  `from_tier`. A later user placement is never undone. (#61)
- A session with a real branch signal binds to its deterministic
  `(project, branch)` stream and is never attached to another stream by topic
  similarity, so a new branch's first memories are not born project-common. (#63)
- A scope directive given while re-confirming an existing fact is applied on
  the merge, historical and contradicted paths, not only on insert. (#64)

### Cross-device sync

- The importer judges subject-slot conflicts on active remote rows only,
  matching the local partial UNIQUE index. A generation carrying an inactive
  predecessor and its active successor in one slot imports cleanly and its
  tombstones propagate; it used to be rejected whole. (#66)
- The export fingerprint counts the recall-receipt status axis (`emitted`
  count and latest `emitted_at`), so a `prepared → emitted` transition publishes
  a generation. (#67)
- Skipping an export is a statement about the destination: the previous
  export must have gone to the same folder and that folder must hold this
  device's `CURRENT`; `memex sync enable --dir <new>` clears the stored
  fingerprint. `export-status.json` records `dir`. (#68)

### Continuity and recovery

- Wave-id normalization no longer collapses `<root>#<n>` and
  `<root>#<n>:run:<uuid>` into the same `(root, run_seq)`; an occupied pair gets
  the next free sequence, and creating the lineage UNIQUE index can no longer
  make opening the database fail. (#72)
- A dead Capsule job skips its head fragment only when the page is already at
  the minimum size and the failure is not a transient model or network error;
  the skip records `skipped_seq` / `frontier_before_skip`, and `memex recover`
  restores the frontier so the fragment is distilled again. (#71)
- `memex recover` resolves units inside the transaction, aborts a unit whose
  job CAS updated no row instead of resetting its child tables, and refuses a
  target whose owning job holds a live lease. (#70)

### Web UI

- Promote/demote takes the per-fact lock before the first `await`, passes the
  explicit target tier and expected version to the core, and rejects the
  losing duplicate with 409 `STALE_FACT`; a repeated request can no longer move
  a fact two steps. (#77)
- The sync lock is taken before the module load, so `MEMEX_HOME` /
  `MEMEX_DB_PATH` are always restored. (#76)

### Upgrade

Run `memex update` and restart Codex. Schema version stays 7; two nullable
columns are added to `capsule_checkpoint_state`. If a 0.6.1 data root already
holds both `maintenance#N` and `maintenance#N:run:<uuid>` budget rows, the
migration now assigns them distinct run numbers instead of failing to open the
database. The first automatic export after the upgrade runs once regardless of
the fingerprint because the stored export status has no `dir` yet.

## 0.6.1 - 2026-09-10

### Cross-device sync

- Give cross-device sync a switch, and leave it **off**. Nothing leaves the
  machine until `memex sync enable --dir <shared folder>` writes
  `<data root>/sync/config.json`; enabling creates the folder and proves it is
  writable before storing anything. `MEMEX_SYNC_DIR` overrides the stored
  folder, `memex sync disable` turns every path back into a one-line no-op, and
  the switch itself is device-local state that never travels. A generation is
  published atomically — payloads first, `meta.json` last, then a directory
  rename, then `CURRENT` — so a cloud folder mid-upload is never mistaken for a
  committed snapshot. (#35, #48)
- Trigger the export from the lifecycle instead of nowhere. Until now no hook
  ever invoked the exporter. SessionEnd gains a second, asynchronous entry and
  the automatic maintenance wake gains the same call, both gated on "the durable
  state changed since the last successful export" so an unchanged database never
  publishes an empty generation; `memex sync export --force` overrides the gate.
  SessionStart imports the peers' generations. `memex doctor`'s `sync-export`
  check reports `skipped(off)` as ok, warns when the switch is on but nothing is
  wired or nothing has been exported, and fails on a recorded export failure.
  (#35, #48)
- Replicate the whole tier placement instead of half of it. The exporter now
  carries all five promotion states with `workspace_id`, `workstream_id`,
  `tier_reason` and a readable branch name, so fact tombstones — which have no
  tier of their own — finally describe the same population as the exported
  facts. The importer enforces the local writer's invariant: a project-wide
  promotion arrives with its workspace and branch keys cleared, and a
  `promotion_state` this version does not know is reported as a malformed row
  that rejects its generation instead of being flattened to project scope.
  Because `workstream_id` is `hash(project_id, branch)`, branch memory comes
  back as branch memory on the other machine. (#37)
- **Sync protocol 4 → 5**, fail-closed. A v4 importer rewrites an unknown
  promotion state to `legacy-project`, which would silently widen branch memory
  to project scope on an older device. v5 importers still read v4 generations; a
  v4 peer rejects a v5 generation whole rather than mis-reading it. (#37, #48)

### Ontology

- Make a parked fact a state rather than a silent `General/Misc` assignment.
  `facts.ontology_state` / `ontology_parked_at` / `ontology_parked_version`
  distinguish a fact the classifier gave up on from one the model actually filed
  under Misc, so `memex status` reports `Ontology: READY|PENDING (N classified,
  P parked, Q pending)` instead of counting failures as classified and calling
  the pipeline ready. A parked fact is retried exactly once per
  (classifier policy, embedding generation) pair. (#41)
- Stop charging a whole batch's facts for a system-side failure: an output-budget
  overflow is a function of batch size, so the batch is split and retried
  without consuming an attempt. Only a single-fact call that still overflows is
  billed as a content failure. (#41)
- Surface an unrepairable category vector index instead of logging it. An
  `IndexRepairError` is recorded in `ontology_index_repair_state`, printed by
  `memex status` as `ontology category index: MANUAL REPAIR REQUIRED (…)`, and
  failed by a new `memex doctor` check, `ontology-index`. Classification is
  blocked in that state; `memex backfill embeddings` rebuilds the vectors. (#41)
- Make the taxonomy unique by schema and repairable by command. Case-insensitive
  UNIQUE indexes on domain names and on category names within a domain, with an
  idempotent migration that merges pre-existing duplicates (oldest row wins, no
  Chronicle event, no generation bump), plus `ON CONFLICT DO NOTHING` and a
  re-select so two concurrent classifications converge. `memex ontology
  list|merge|rename` repairs the near-duplicates that used to require wiping the
  whole ontology — this classifier once grew to 1,612 categories. Neither
  command touches fact meaning; each writes one metadata line to
  `logs/ui-audit.jsonl`. (#47)
- Record the classification similarity on the fact (`facts.ontology_similarity`)
  so a 0.42 assignment and a 0.98 assignment are distinguishable afterwards,
  count `result.stale` as progress so the circuit breaker stops treating an
  all-stale batch as no progress, run `applyClassification` in an immediate
  transaction, and drop `is_new_domain`/`is_new_category` from the prompt.
  (#47)

### Maintenance

- Express maintenance wave lineage as columns. `model_work_budgets.root_wave_id`
  and `run_seq` replace the `:run:<uuid>` suffix that grew 41 characters per
  rollover; children inherit the root wave id, and existing nested ids are
  normalized without losing the rolling-cap linkage. (#42)
- Bound the derived-lane yield. The P0/P1 early return in the maintenance hook
  becomes a persisted consecutive-skip counter (`derived_lane_skips`): after
  three skips for the same reason the derived lanes — consolidation, re-embed,
  ontology, extraction — run once anyway. `memex status` shows
  `Derived lanes: skipped N times (reason: …)`, so "why is pending not going
  down" has an answer that points at the other pipeline. A deterministically
  failing Capsule job could previously starve them indefinitely and silently.
  (#43)

### Recovery and observability

- Add `memex backfill receipts`: a model-free rebuild of the missing local
  meaning-evidence receipts for facts whose source exchanges all still resolve.
  `memex status` reports the gap as `facts without local evidence: N / M`.
  Without a receipt a fact is held back from automatic consolidation, which
  reads from the outside as "duplicate memories keep piling up".
  `recordLocalMeaningEvidence` now reports its failures instead of returning
  quietly. (#45)
- Stop deleting a local receipt on every remote semantic win. Receipts are never
  exported, so deleting one destroyed that device's evidence binding with no way
  back; sync-import now demotes it to `fact_evidence_receipts.authority =
  'peer-authority'`, which `memex backfill receipts` can promote back. (#45)
- Report `memory_jobs` by kind × state in `memex status --json` under a new
  `jobs` key. (#46)

### CLI

- Resolve the installed plugin root in exactly one place (`src/plugin-root.ts`):
  `MEMEX_PLUGIN_ROOT`, then the `$CODEX_HOME` plugin cache entry matching the
  manifest version, then `codex plugin list --json`, then the running launcher.
  `memex doctor`, `runtime-exec`'s fallback message and the new `memex deps
  materialize [--root]` all judge the same directory — the `~/.local/bin/memex`
  npx cache used to be mistaken for the installed plugin. (#53)
- `memex deps materialize` runs `npm install --omit=dev --no-audit --no-fund` in
  that root and touches nothing else: no marketplace, plugin registry, hook file
  or data root. `memex update` materializes automatically after a reinstall
  (`--no-materialize` prints the command instead), and `memex install` falls
  back to an npm install in the installed root instead of failing preflight when
  the source checkout has no production dependency closure. (#53)
- Document and fix the CLI surface `memex index --help` was pointing at:
  `--verify`, `--repair`, `--rebuild`, `--cleanup`, `--session`,
  `migrate-projects` and `facts --all` are all covered, and the help no longer
  references a document that does not exist. (#46)

### Web UI

- Rename 기억 to 기억·사실, default the workspace to 전체 프로젝트 (조회), and say
  permanently what that means: browsing is broad, injection is still the current
  project plus common memory. The scope dropdown is ordered and carries a fact
  count per scope, conversations and activity on the common scope offer a
  one-click switch, and `/facts?fact=<id>` opens the same drawer as
  `/facts/<id>`. (#24, #26)
- Surface the memory tier and let the screen move it. `/api/v2/facts` reports
  `hiddenByTier`, the project view banners the branch/workstream memory its
  scope hides with a `tiers=all` toggle shared with the scope modal, rows and the
  summary tab carry a tier badge with the injection condition in its tooltip,
  and the detail panel promotes or demotes one rung through
  `POST /api/v2/facts/promote|demote` (CSRF, audit line, the one-step rule
  explained in the modal). A card in 관리 runs `migrate-tiers --dry-run` and
  opens the apply button only after a preview. (#22)
- Say what a failure means and what to do about it. `ui/public/guidance.mjs`
  carries 33 failure classes derived from GUIDE §20 — cause, impact, next
  action, action, whether it is ignorable — with unmapped errors shown verbatim
  and no invented cause. Overview attention cards group by class with real
  actions, and 활동·추적 gains a 다음 행동 column. A coverage test extracts every
  `throw new Error` string and skip-reason enum from `src/` and fails when one
  is neither mapped nor explicitly listed. (#23)
- Explain the workspace from inside the workspace: a page ⓘ, one-line tooltips
  on controls, badges, table headers and management commands, a `?` glossary of
  17 terms, and a 도움말 표시 setting. Every entry cites a doc anchor and the
  coverage test verifies those anchors exist. (#28)
- Add 관리 › 동기화: a default-off switch whose enable modal validates the shared
  folder, a status block (folder, path source, writability, device id, last
  export, other devices seen), and 지금 내보내기 / 가져오기 through in-process
  `sync-control` calls with a single-run lock and a pinned data root. Manual file
  transfer, device aliases and the conflict history are deferred to 0.6.2.
  (#48)
- Raise helper text to at least 11px. (#26)

### Gates and packaging

- Widen the release gate to `node --test test/*.test.mjs`. The old
  `test/*slice.test.mjs` glob left six non-slice `.mjs` tests outside the
  documented gate. (#26)
- Stop packaging the retained gate archives: `merge-gate-pre-*.json` and
  `benchmark-pre-*.json` are excluded through a `files` negation, so the tarball
  stops growing by one file per release while the current receipts still ship.
  (#26)
- Add `scripts/check-real-root-untouched.mjs`, a read-only snapshot/compare that
  proves a gate run left the real Memex data root untouched — content hashes, so
  a read that only moves mtime is not a failure. (#26)
- Stop logging an unlabeled hook invocation as `event: "Unknown"`, and keep the
  `observe-hook-event` CLI guard from firing inside the esbuild MCP bundle,
  where it would have exited the MCP server with a usage error. (#26)
- The installed lifecycle inventory is now 7 events and 13 owned hook entries;
  SessionEnd owns two. (#35)

### Documentation

- Re-check every command, flag, environment variable, path, status string, route
  and link in README, README-KR, the owner docs and the bundled skills against
  the code rather than against another document, the way 0.6.0 was audited. The
  statements 0.6.1 made false are gone: the export hook wired to no event, the
  Web UI unable to move a memory between tiers, protocol v4 as the current
  version, twelve owned hook entries. GUIDE §20 — the single source the Web UI
  derives its failure guidance from — gains the four classes 0.6.1 added, and
  #29/#30 plus the deferred half of #48 are labelled 0.6.2. (#25)

### Upgrade

Continuity schema stays at version `7`. Every 0.6.1 column, table and index is
additive and migrates on the first hook, CLI or MCP run — including the ontology
duplicate merge and the wave-id normalization — so there is no separate
migration step and no downtime.

```bash
memex update          # then restart Codex so hooks, skills and MCP reload
memex status
memex backfill receipts      # if "facts without local evidence" is not 0
memex ontology list          # review near-duplicate categories
```

`memex update` now materializes the runtime dependencies into the new plugin
root by itself; pass `--no-materialize` to get the command printed instead of
run. If `memex doctor` reports `dependencies: fail`, run `memex deps
materialize`.

Cross-device sync stays **off** unless you enable it, and nothing leaves the
machine until you do:

```bash
memex sync enable --dir <a shared folder you own>
memex sync export
memex sync status
```

The sync protocol is now **v5**. A v5 device still imports v4 generations, but a
v4 peer rejects a v5 generation rather than mis-reading it — upgrade both
machines before expecting sync to resume. Memories in the shared folder are
plaintext JSONL; encryption is out of scope, so use a cloud folder that is
yours.

## 0.6.0 - 2026-09-10

### Memory scope and tiers

- Give memory a tier. Inside a Git checkout the directory is still the project,
  but the branch is now the tier: a session on the default branch — or in a
  non-Git directory — writes project-common memory, while any other branch or
  worktree writes its own branch tier, keyed on `(project, branch)`. Injection
  and lookup read global plus project-common plus the current branch, and two
  worktrees of one repository checked out on the same branch share a tier.
  **This changes where new memory lands**: before 0.6.0 every extracted fact
  went to a per-session workstream and was never read again. `facts.tier_reason`
  records the branch signal — `no-branch-signal`, `default-branch` or
  `branch:<name>` — that placed it. (#18)
- Move memory between tiers on a one-rung ladder, `workstream ⇄ project ⇄
  global`. A skipped rung is refused, and every move — a user action, the
  evidence-based automatic reconcile that runs in the SessionStart maintenance
  stage as SQL with no model call, or an in-session scope directive — appends a
  Chronicle `PROMOTED` / `DEMOTED` carrying from-tier, to-tier, actor and reason.
  `memex facts tier|promote|demote` is the interface today; Web UI buttons
  follow in 0.6.1 (#22). (#19)
- Capture the branch and the repository default branch — `origin/HEAD`, then
  `packed-refs`, then `init.defaultBranch` — at session start and propagate them
  to `exchanges.git_branch` and the workstream `branch_hint`. Workstream ids are
  now derived deterministically from `(project, branch)`, or from the project
  alone when there is no branch signal, replacing the
  `ws-<hash(project, session)>` fallback that split one project into a
  workstream per session. (#16)
- Update a workspace row in place when a plain directory later becomes a Git
  checkout. `workspace_id` and `project_id` never change, so existing
  project-common memory, Capsules and history survive untouched, and
  `workspace_location_events` records one `WORKSPACE_LOCATION_CHANGED`. A common
  dir or remote that already belongs to another project is never merged
  automatically: the conflict is marked `requires_approval` with a `suggest`
  entry in `project_identity_audit` and waits for an explicit
  `approved_remote_mappings` approval. (#21)
- Refuse `/`, `unknown` and any path with an empty basename as a project
  identity. A session with such a cwd degrades to global-only reading instead of
  joining a catch-all bucket and reading other projects' facts as its own. The
  existing `/` project is quarantined — no facts deleted — and listed by
  `memex status`. (#38)

### Work Capsule convergence

- Raise the Work Capsule bound to 12,000 characters (`MEMEX_CAPSULE_MAX_CHARS`,
  floor 2,000) and store an oversized patch truncated in priority order instead
  of throwing. `work_capsules.truncated`, `truncated_fields_json` and
  `original_chars` record exactly what was cut, with one WARN line. (#17)
- Halve the next evidence page after a failed capsule attempt and, at the
  minimum page, skip the still-failing head fragment and advance the frontier,
  so a workstream can no longer stall forever. A dead job is no longer
  re-created on every checkpoint. (#33)
- Stop overwriting a terminal `failed-visible` state with `retry`:
  `failMemoryJob` returns the real transition and the worker's update is
  guarded. A one-shot idempotent repair fixes rows already stuck that way. (#34)

### Recovery of terminal work

- Add `memex jobs list|show|retry|dismiss` and `memex recover
  <job-id|target-id|--all-dead> [--dry-run]`, which reset the whole terminal
  unit — job, checkpoint, capsule state, extraction target, items, exchange
  state and failed ranges — in one transaction. Nothing is deleted: a cleared
  `last_error` is preserved in `memory_jobs.retry_history`, and `dismiss`
  retires a job as `superseded` with its reason and an audit line. Re-running
  the worker never recovered dead work, and the guide no longer claims it does.
  (#20, #39)
- Report all eight terminal states in `memex status` behind a single `Needs
  attention` count, alongside the quarantined-project list. Seven of the eight
  had no operator surface at all before this, so a stalled pipeline was
  indistinguishable from an idle one. (#39, #38)

### Honest observability

- Distinguish `injected` (one or more facts) from `context-only` (zero facts) in
  the injection log, record a `baseline_margin_gap` telemetry row per retrieval,
  surface a dead lexical lane as `lexical_lane_unavailable` instead of an empty
  `catch`, let `MEMEX_INJECT_BASELINE_MARGIN` override the 0.045 default, and
  warn (`injection-yield`) after eight consecutive zero-fact injections. The
  margin itself is unchanged: the observed zero-fact runs are now measurable
  rather than hidden. (#32)
- Log a recall receipt that could not be marked emitted as `status:
  "receipt-failed"` in `inject-context.jsonl` instead of discarding it on
  stderr. `memex doctor` fails `inject-output` on it, and a new
  `recall-provenance` check compares emitted contexts against `recall_events`
  rows. (#44)
- Print one stderr line when an installed plugin has no runtime dependencies and
  the launcher falls back to `npx github:BongSuCHOI/memex#main`. `memex doctor`
  reports `dependencies: fail` against the installed plugin root, and `memex
  install` is exposed as a CLI command that materializes them without a network
  install. (#40)

### CLI

- Print usage and exit `0` for `--help` on every subcommand. `update`,
  `setup-hooks`, `remove-hooks` and `migrate-projects` used to execute the real
  work when asked for help. (#36)
- Accept `memex search --both` as the explicit hybrid mode and reject any other
  unknown `--` option with exit `1` instead of silently treating it as a query
  term. (#46)

### Documentation

- Document the 0.6.0 model across README, README-KR and the owner docs: one
  scope-and-tier table as the single source, complete CLI and
  environment-variable references, the full data-root layout, `memex doctor`'s
  eleven checks, a failure-class recovery table in `docs/GUIDE.md`, and
  per-skill triggers, walk-throughs and effects in `docs/MCP-AND-SKILLS.md`.
  Every command, flag, environment variable, path, link and status string was
  checked against the code rather than against another document. Remove the
  duplicated Final RFC copy and the superseded worker prompt pack; the locked
  copy at `docs/architecture/memex-continuity-v1.md` still matches
  `rfc-lock.json`. (#25)

### Upgrade

Continuity schema stays at version `7` and the sync protocol stays at `4`. Every
0.6.0 column and table is additive and migrates on the first hook, CLI or MCP
run — there is no separate migration step and no downtime.

```bash
memex update          # then restart Codex so hooks, skills and MCP reload
memex status          # read "Needs attention" and "Quarantined projects"
memex recover --all-dead --dry-run
memex recover --all-dead
memex facts migrate-tiers --dry-run
memex facts migrate-tiers --apply
```

`memex recover --all-dead` returns work that earlier versions left terminal with
no path back; run the worker afterwards (`memex-continuity-worker` or `memex
backfill extract`) for it to be processed. `memex facts migrate-tiers` moves the
pre-0.6.0 facts that the new branch-signal rule makes project-common, one
Chronicle `PROMOTED` per fact; it never runs automatically and requires
`--dry-run` or `--apply` explicitly. Review the dry-run list before applying.

Moving a memory between tiers is a CLI action in 0.6.0; the Web UI gains
promote/demote buttons in 0.6.1 (#22). Rollback still requires the pre-upgrade
DB backup and the matching plugin version, and older writers must not share the
migrated DB — see [GUIDE.md](docs/GUIDE.md#15-continuity-운영).

## 0.5.2 - 2026-09-10

- Mark a deadline- or window-expired model budget `exhausted` in durable state
  before refusing a claim. 0.5.1 refused the claim without the transition that
  `reserveModelAttempt` used to perform, so `memex model-work resume --new-run`
  rejected the budget as still active and foreground backfills deferred
  forever. The exhaustion predicate and transition are now one shared helper
  used by the pre-claim check, attempt reservation, explicit exhaustion and
  automatic maintenance; `resume --new-run` also accepts an active budget whose
  deadline or window has already passed. (#14)
- Print the exact recovery command in the backfill worker's `DEFERRED
  (budget_exhausted: …)` line and summary: `memex model-work resume
  <budget-id> --new-run`.
- Make the backfill claim test fixtures independent of the wall clock; the
  0.5.1 fixtures pinned 2026-09-09 timestamps and began failing the next day.

## 0.5.1 - 2026-09-10

- Resolve the model budget before claiming an extraction or capsule job. A
  budget that is already past its deadline or outside its automatic window no
  longer reaches the extractor, so a wake that renews the budget seconds later
  can pick the job up immediately instead of finding it in a one-hour retry
  backoff with a burned attempt. A claim that raced the renewal and made no
  provider call is refunded rather than deferred. (#12)
- Report why a claim was refused. The backfill worker prints `HANDOFF (lease
  held by another runner)`, `DEFERRED (retry backoff until <time>)` or
  `SKIPPED (attempt cap reached)` and counts them separately; `memex status`
  shows the backoff count and the earliest retry time inside the pending
  extraction figure. Exit codes `0` / `1` / `2` keep their meaning. (#11)

## 0.5.0 - 2026-09-09

- Replace the Web UI with Memex Workspace: seven pages (overview, conversation
  ledger, memory, taxonomy, knowledge map, activity & tracing, management), a
  shared fact detail panel (summary / evidence / history / processing & reuse)
  reachable from conversations, search, the graph and jobs, project and
  common-memory scope selection, ⌘K search, dark mode and a responsive layout.
  Reads are served from `/api/v2/*` over the read-only connection; fact edits,
  deactivation, restore and hard delete go through the existing
  `fact-management` service behind a per-session CSRF token on a loopback-only
  listener. The `memex-ui` command and port 3847 are unchanged.
- Render the knowledge map with native WebGL (2D map by default, 3D galaxy on
  demand, Canvas2D fallback) and remove the bundled three.js copy, so the UI
  ships no third-party JavaScript.
- Show Chronicle changes with effective and recorded time, processing jobs with
  input versions and model attempts, context-injection records, system logs and
  management runs. Unobserved values render as 미수집 instead of 0, and
  injections that provided no memory never use a success badge.
- Run doctor, status, sync and backfill only after explicit confirmation with a
  time limit and cancellation; opening or refreshing a page never starts model
  work. The edit dialog discloses the local embedding-model run and the
  taxonomy reset that a meaning change causes.
- Derive the UI audit-log location from `MEMEX_DB_PATH` when `MEMEX_HOME` is
  unset, and isolate `MEMEX_HOME`/`XDG_CONFIG_HOME` in every UI test and gate.
- Fold `docs/VISUALIZATION.md` into `docs/WEBUI-WORKSPACE.md`; point the browser
  E2E, benchmark and graph-probe scripts at the new UI (`/api/v2/graph`).

## 0.4.4 - 2026-09-09

- Report foreground backfill as partially complete when retryable, active or
  terminally unresolved work remains, including exact post-run per-stage counts
  and exit code `2` instead of a false all-complete message. Fatal worker errors
  stop later stages and return `1`.
- Coalesce automatic maintenance wake checks once every three minutes per data
  root while preserving the existing one-hour resume cooldown, rolling 24-hour
  model-attempt cap, job cursor, retry and active-claim state.

## 0.4.3 - 2026-09-09

- Resume unfinished automatic maintenance from `SessionStart` and asynchronously
  from `UserPromptSubmit`, coalescing wakeups once per minute per data root without
  resetting model budgets or waiting for workers.
- Create a new automatic run only after a one-hour cooldown and within a shared
  rolling 24-hour cap of 256 model attempts. Preserve completed work, retry history,
  active claims, backoff and failed-call accounting across atomic renewal.
- Prioritize pending ontology and relation work, and enable automatic ontology by
  default. `MEMEX_AUTO_ONTOLOGY=0` disables new automatic classification while
  explicit manual model-work renewal remains operator-controlled.
- Add the operational ledger and wake state as local-only, additive schema. Stop
  older Memex workers before updating; sync protocol v4 is unchanged. See the
  [maintenance budget and wait diagnostics](docs/GUIDE.md#17-모델-작업-예산과-대기-진단).

## 0.4.2 - 2026-09-09

- Send asynchronous startup status notices to stderr so they cannot become
  extra model context and trigger another answer.
- Recover exact identifiers omitted by fact summarization from scoped human
  source evidence, labeled as potentially stale context rather than current truth.
- Make automatic ontology opt-in with `MEMEX_AUTO_ONTOLOGY=1` after the isolated
  comparison; retain manual ontology, existing derived data, and core embeddings.

- Separate fixed host guidance from JSON-encoded, untrusted memory and restore
  concise work state with explicit stale/pending evidence. Track prepared and
  emitted context separately; host acceptance requires independent evidence.
- Combine identifier/path/error fact lookup with semantic retrieval, preserving
  scoped lexical fallback during embedding outages. Apply character and
  conservative estimated-token budgets to the complete injected context.
- Connect model attempts, retries, usage and pending targets to durable work
  budgets. Add read-only diagnostics and explicit bounded run renewal while
  preserving the prior attempt ledger and active job leases.
- Separate required fact `ReadScope` from `MutationPolicy`; isolate legacy path readers
  and check graph seeds, every hop, related search/trace results and resident corrections.
- Block cross-workstream/promotion consolidation before model calls and revalidate
  participant meaning, lifecycle, placement and source fingerprints at commit.
- Adopt verified incoming text instead of model-generated merged wording. Preserve
  ambiguous facts with review reasons and distinguish local verification from peer origin.
- Preserve both participants' live provenance across embedding races and keep terminal
  privacy tombstone reasons through subsequent deletion.
- Add read-only integrity previews, exact selected/idempotent repairs, and backup/restore
  verification tools. Keep unresolved legacy/semantic findings for review.
- Update owner contracts and retain frozen before/after regressions plus recovery evidence.
  Existing schema v7 and sync protocol v4 remain unchanged.

## 0.4.1 - 2026-09-07

- Constrain Work Capsule generation with a native Codex output schema so evidence
  and hypothesis items retain their typed source IDs. Other model calls remain
  opt-in; local provenance, size, revision and CAS validation still applies.
- Reserve compact/resume work context before corrections consume the bundle budget.
- Replace scalar Capsule coverage with immutable, ordered workstream evidence and
  bounded fixed-target pages. Preserve six-Stop/8KiB coalescing across sessions;
  commit projection/cursor/lease atomically and invalidate stale purge/rebind work.
- Retry unrendered Hot Evidence using per-session/epoch sequence cursors, including
  on acknowledgement prompts; commit emitted prefix and fact residency together.
- Stream large capture deltas and journal verification through 4MiB buffers,
  preserving JSONL boundaries, hash chains, fsync/outbox atomicity and orphan retry.
- Add schema v7 replay migration with old-worker fencing. Source replacement
  epochs retain distinct exchange/tool identities.
- Refresh current architecture/installation/verification docs and remove unused imports.

### Upgrade and verification

The first run migrates the local DB to schema `7`; sync protocol stays `4`.
Migration replays surviving evidence but cannot recover already overwritten
historical generations. Older writers must not share the migrated DB; rollback
requires the pre-upgrade DB backup and matching plugin version. See
[GUIDE.md](docs/GUIDE.md#15-continuity-운영).

The current clean-SHA gate is [merge-gate.json](docs/verification/merge-gate.json).
Bounded synthetic Luna output-schema and rolling-state results are retained in
[capsule-output-schema-evaluation.json](docs/verification/capsule-output-schema-evaluation.json);
they do not establish corpus-wide completeness or production failure rates.

## 0.4.0 - 2026-09-04

### Memex Continuity Architecture v1

Normative target: `docs/architecture/memex-continuity-v1.md` (SHA-locked). As-built map:
`docs/CONTINUITY.md`. Deviations: `docs/verification/continuity-v1/rfc-deviations.md` (D-000–D-036).
Final gate: `docs/verification/continuity-v1/final-integration-gate.md`.

#### Added

- Rolling journal + hash-verified checkpoints with an atomic outbox and a durable
  priority queue (`capture_index` → `capsule_update` → exact extraction), detached
  worker wake, lease/retry/dead-visible states, and capture-gap recovery.
- Exact extraction spine: immutable ordered targets, contiguous cursor, generation
  reprocessing for grown exchanges, exact failed ranges (no sampling loss).
- Work Capsule (typed, context-only) with generation CAS and a deterministic tail
  baton; immediate `SessionStart(compact|resume)` rehydration without PostCompact.
- Stable `project_id → workspace_id → workstream_id → session_id` identity with
  additive migration, explicit link/split/remote approval, conservative workstream
  binding, promotion slots, project `memory_revision` invalidation, Hot Evidence lane.
- Chronicle: `fact_revisions` extended into the append-only event history (7 kinds,
  content-hashed idempotent ids, `effective_at` vs `recorded_at`, grounded cause vs
  classifier note, rollback linkage), subject-slot resolution at extraction, incident
  episodes/patterns/remediation with a bounded match API, `trace_fact` timeline
  pagination, `memex facts history|explain`.
- Adaptive recall: lexical pre-retrieval gate (no LLM), single reused embedding on
  the ambiguous path, revision-aware delta/correction, deterministic Memory Bundle
  under hard budgets, verified-only WATCH, TRACE pointers, demoted assistant lane,
  measured telemetry, `npm run bench:recall` calibration harness and artifact.

#### Changed

- Continuity schema `6` (`PRAGMA user_version`), additive and rerunnable; sync
  protocol stays `4` with additive stable-identity, Chronicle event and event
  tombstone rows (older peers reject such generations visibly).
- Extracted facts default to `workstream` scope; `decision`/`project-current`
  truth requires explicit evidence-bearing promotion (BRANCH TRUTH).
- `PostCompact` is registered as telemetry only; correctness never depends on it.
- New sessions start at the current project memory revision; short explicit memory
  questions reach the gate (the 20-character hook floor was removed).
- Consolidator verdicts pass a source-effective temporal judge; its reason is a
  classifier note, never a grounded cause.

#### Fixed

- Concurrent `initDatabase()` could fail with `trigger exchanges_fts_au already exists`.
- Paged extraction jobs could block capture indexing in the same session partition.
- A Work Capsule sourced from a purged session could survive privacy purge.
- Sibling changes to workstream-scoped resident facts were not corrected on
  acknowledgement prompts.

#### Migration notes

- First run after upgrade performs the v1→v6 additive migration inside one immediate
  transaction; interrupted migrations resume. No manual step is required.
- `session-end-hook.js` remains as a final-fence alias; plugin registration uses
  `continuity-hook.js`. Legacy path queries and extraction markers remain read-only
  compatibility surfaces.

#### Rollback notes

- Older plugin versions ignore the new tables/columns; the DB does not need to be
  downgraded. Older sync peers reject new-shape generations rather than importing
  them partially. Restore a pre-upgrade DB backup only if a full revert is required.

#### Known limitations

- Cost figures are counts of calls and bytes (calibration on the deterministic
  embedding stub plus a 20-pair real-model spot check); no time or money savings are
  claimed. Production-model calibration replay and the product A/B remain manual.
- `SessionStart(resume|compact)` rehydration still uses the Phase 3 scope-wide
  correction list; the prompt path is residency-derived.
- Formal `codex plugin validate` is unavailable in CLI 0.153.2; substitute checks apply.

## 0.3.0 - 2026-09-03

### Added

- Added bounded semantic context windows and long-range referent retrieval for
  deictic approvals, workflow adoption, and cross-language fact extraction.
- Added local `fact_context_dependencies` for persisted long-range interpretive
  lineage, separate from authoritative `source_exchange_ids`.
- Added curated legacy/P2 real-model evaluation fixtures, rejection telemetry,
  archive-shadow methodology, and merge-gate evidence.
- Added Fact Detail and `trace_fact` surfaces that distinguish authoritative
  provenance from non-authoritative context.

### Changed

- Fact scope now follows durable applicability instead of conversation location.
- The semantic verifier reports the context it used; server validation
  canonicalizes the minimal persisted dependency set and rejects malformed,
  unknown, duplicate, overlapping, or out-of-pool usage.
- Immediate local context remains transient while persisted historical context
  participates in consolidation, privacy purge, and local lifecycle handling.
- Tier-C repeated-signal inference is limited to the same session's current
  authoritative extraction window; assistant and recall text remain context-only.

### Fixed

- Prevented assistant, recall, negative ratification, and translated-text paths
  from laundering unsupported claims into durable facts.
- Preserved semantic antecedents across watermark and extraction-window
  boundaries without promoting historical context to authority.
- Improved open-vocabulary recommendation, workflow, sequence, and original
  choice resolution while retaining fail-closed ambiguity handling.
- Removed local/historical referent duplication and stale dependency telemetry.

### Verification

The authoritative release evidence is stored in
`docs/verification/merge-gate.json`. Known real-model and archive quality limits
remain recorded as `PASS-WITH-NOTES`; hard authority and leakage checks remain
release blockers.

## 0.2.0 - 2026-08-31

### Added

- Added `memex home [--json]` to print the resolved Memex data root.
- Added opt-in terminal CLI shim management through
  `memex setup --install-cli` / `--uninstall-cli`.
- Added `memex backfill all` for sequential extract → ontology → embeddings
  onboarding with idempotent retry behavior.
- Added durable multi-device sync protocol v4 with committed generations,
  integrity manifests, tombstones, and recall receipts.
- Added independent semantic and lifecycle generations/clocks for durable facts.
- Added local taxonomy epoch invalidation so in-flight classification cannot
  recreate taxonomy after a privacy purge.
- Added guarded manual KR fact translation with strict batch validation and
  semantic CAS.

### Changed

- Fact reconciliation now treats **semantic**, **lifecycle**, and **lineage** as
  independent axes instead of allowing one winner row to overwrite unrelated
  state.
- Cross-device lineage is monotonic: source exchange IDs are unioned and
  consolidated counts use max, including brand-new remote inserts.
- Replicated deactivate/restore events preserve their original remote event
  timestamps and are revalidated at commit time.
- Consolidation now discards stale model verdicts when either participant's
  semantic or lifecycle generation changes.
- Ontology, relations, KR translations, and vectors are local-derived state and
  are excluded from the durable sync payload.
- Privacy conversation exclusion now invalidates taxonomy state, resets
  surviving classification attempts, and prevents stale peers from resurrecting
  excluded facts.
- Sync import is fail-closed at the generation boundary: required files,
  manifest hashes, strict row shape, and identity are validated before DB
  mutation.
- Export serialization now uses the local SQLite database's process-owned
  `BEGIN IMMEDIATE` transaction instead of a cloud-synced lockfile.
- Exchange and fact-derived embedding/classification writers use commit-time
  CAS/content revalidation to discard stale async results.
- `memex backfill <target>` runs in the foreground by default; background mode is
  explicit.
- Data-root resolution is consistently `MEMEX_HOME` →
  `$XDG_CONFIG_HOME/memex` → `~/.config/memex`.
- Public README, Korean README, contributor rules, and owner documentation were
  refreshed around the current protocol v4 architecture and operating model.

### Fixed

- Fixed remote→remote reconciliation where the semantic winner could
  accidentally replace an independently newer lifecycle state.
- Fixed replicated lifecycle events being stamped with local wall-clock time.
- Fixed same-state newer lifecycle clocks being ignored.
- Fixed stale lifecycle/consolidation operations committing after concurrent
  deactivate/restore races.
- Fixed fresh sync imports dropping provenance collected from non-winning peer
  rows.
- Fixed stale ontology classification recreating taxonomy after privacy purge.
- Fixed privacy purge leaving ontology retry state permanently exhausted.
- Fixed stale KR translations attaching to facts whose meaning changed during
  translation.
- Fixed export-lock ownership/stale-break races by removing the sync lockfile
  design.
- Fixed generation/reader integrity paths that could otherwise observe or apply
  partial sync state.

### Verification

The release gate covers:

- Typecheck: PASS
- Build: PASS
- Vitest: 68 files / 598 tests PASS
- Codex slice: 23/23 PASS
- All Node slices: 91/91 PASS
- Install E2E: PASS
- Marketplace E2E: PASS
- Package-runtime E2E: PASS
- Lifecycle E2E: PASS

The raw release-candidate evidence is stored at
`docs/verification/merge-gate.json`. Its `candidate.codeSha` is the only
authoritative commit attribution; it is regenerated from the final clean
committed baseline before release.

## 0.1.0 - 2026-08-27

First independent public Memex release.

### Highlights

- Codex-native ingestion of `$CODEX_HOME/sessions` rollout JSONL with
  canonical project identity and read-only source handling.
- Local conversation archive with vector, FTS5/BM25, and hybrid search.
- Incremental durable fact extraction with provenance, confidence gating,
  consolidation, revisions, and retry-safe watermarks.
- Evidence-level trust model that keeps Memex recall and assistant synthesis
  searchable without allowing self-reinforcing fact extraction.
- Domain/category ontology, typed relations, scoped graph traversal, and
  cross-project insights.
- Bounded UserPromptSubmit context injection with relevance filtering and
  per-session deduplication.
- Nine MCP tools and three bundled Codex skills.
- Loopback-only Web UI with conversations, facts, pipeline health, and 3D
  Knowledge Galaxy.
- Codex plugin marketplace installation, plugin-managed lifecycle hooks,
  isolated runtime launcher, setup/update/doctor flows, and explicit fallback
  hook management.
- Project/global/all scope enforcement across CLI, MCP, graph traversal,
  retrieval, UI, and import surfaces.
- Isolated installer, lifecycle, MCP, browser, cleanup, packaging, and
  performance verification infrastructure.

Memex `0.1.0` is intentionally pre-1.0: the product is usable and substantially
tested, while public marketplace and Codex host-adapter contracts may still
evolve.

## Project lineage

Memex continues the MIT-licensed knowledge-system lineage of
[`obra/episodic-memory`](https://github.com/obra/episodic-memory) and
[`jung-wan-kim/memory-bank`](https://github.com/jung-wan-kim/memory-bank), while
replacing the previous host adapter with a Codex-native implementation.

See [docs/LINEAGE.md](docs/LINEAGE.md) for attribution and migration context.
