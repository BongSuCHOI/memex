// guidance — prose for the failure-class catalogue. Owner: i18n L4 (#109).
//
// `ui/public/guidance.mjs` keeps structure and logic only: the order of `CLASSES` (which is
// classify()'s priority), `id`, the `match` rules, `ignorable`, the action descriptors and the
// `source` anchor. Titles, causes, impacts and next actions all live here.
//
// Two rules: no HTML and no interpolation slots, except `guidance.attention.*.detail` (word
// order forces the count into the dictionary); thresholds, env vars and versions stay as
// literals inside the prose. The catalogue never invents a cause it cannot evidence.
export default {
  // ── 37 classes × {title, cause, impact, next}; the module owns the array order ──
  'guidance.db-unavailable.title': 'Cannot connect to the local database',
  'guidance.db-unavailable.cause': 'The index database file is missing or cannot be opened: either nothing has been synced yet, or the path or permissions changed.',
  'guidance.db-unavailable.impact': 'Reads, injection and memory changes all stop. Stored memories are not lost.',
  'guidance.db-unavailable.next': 'Check the DB path under Administration › Runtime, run diagnostics, then build the index with Sync conversations.',

  'guidance.deps-missing.title': 'Runtime dependencies are not installed',
  'guidance.deps-missing.cause': 'The installed plugin root has no native dependencies, so every hook runs through an unpinned npx fallback.',
  'guidance.deps-missing.impact': 'Hooks get slower and versions are not pinned. The memory data itself is not damaged.',
  'guidance.deps-missing.next': 'Materialise the dependencies in the install root, then confirm that diagnostics reports dependencies ok.',

  'guidance.capsule-bound-exceeded.title': 'Capsule work killed by the pre-0.6.0 bound',
  'guidance.capsule-bound-exceeded.cause': 'Cores before 0.6.1 failed the work when a Capsule patch exceeded the storage bound (MEMEX_CAPSULE_MAX_CHARS). Work carrying this error ended in a terminal state back then — since 0.6.1 the core truncates and stores instead of failing.',
  'guidance.capsule-bound-exceeded.impact': 'That workstream’s continuity summary is left un-updated. No facts were lost.',
  'guidance.capsule-bound-exceeded.next': 'Upgrading alone does not resume it (the worker only picks up pending and retry). Use memex recover to put it back into the pending state — recovery deletes nothing.',

  'guidance.capsule-truncated.title': 'The task-context Capsule was truncated',
  'guidance.capsule-truncated.cause': 'The Capsule patch exceeded the storage bound (MEMEX_CAPSULE_MAX_CHARS, 12,000 characters by default), so the lowest-priority items were dropped first. Since 0.6.1 the core truncates and stores rather than failing the work.',
  'guidance.capsule-truncated.impact': 'No effect on facts — a Capsule is interpretive context, not direct evidence. Only some items of the continuity summary are not preserved.',
  'guidance.capsule-truncated.next': 'Safe to ignore. If you keep needing the dropped items, raise MEMEX_CAPSULE_MAX_CHARS and reprocess that workstream.',

  'guidance.budget-exhausted.title': 'Model work budget exhausted',
  'guidance.budget-exhausted.cause': 'This run spent its budget — one of the deadline, the call window, or the attempt count.',
  'guidance.budget-exhausted.impact': 'The remaining targets are left unprocessed in the pending state. Memories already stored are untouched.',
  'guidance.budget-exhausted.next': 'Check the budget state, then continue in a new run. The budget ID is under "Budget ID" in the job detail.',

  'guidance.claim-handoff.title': 'Another runner claimed it first',
  'guidance.claim-handoff.cause': 'Another worker already leased the same work, or this run lost a concurrent-write race.',
  'guidance.claim-handoff.impact': 'None. The runner that won processes the work.',
  'guidance.claim-handoff.next': 'Safe to ignore. If the same work is only ever handed off, check whether a runner with an expired lease is still around.',

  'guidance.claim-backoff.title': 'Waiting out a retry backoff',
  'guidance.claim-backoff.cause': 'The retry time after a failure has not arrived yet. Nothing is broken.',
  'guidance.claim-backoff.impact': 'Only that one item is deferred for a while.',
  'guidance.claim-backoff.next': 'Wait, or run the worker. To act immediately, retry just that job.',

  'guidance.claim-attempts.title': 'Attempt cap reached',
  'guidance.claim-attempts.cause': 'This work has spent every attempt it was allowed.',
  'guidance.claim-attempts.impact': 'That range will not be reprocessed automatically.',
  'guidance.claim-attempts.next': 'Read the stored error, fix the cause and recover — or, if it is not worth reviving, dismiss it with a reason.',

  'guidance.claim-error.title': 'Error while claiming work',
  'guidance.claim-error.cause': 'The claim step errored. The processing itself never started.',
  'guidance.claim-error.impact': 'Only this pass is skipped.',
  'guidance.claim-error.next': 'If it repeats on the same work, read the original text in the system log.',

  'guidance.excluded-project.title': 'Project excluded by policy',
  'guidance.excluded-project.cause': 'The project is excluded in the configuration, so it is not a capture or extraction target. This is intended behaviour, not a failure.',
  'guidance.excluded-project.impact': 'Conversations in this project never become memories.',
  'guidance.excluded-project.next': 'Ignore it if that was intended. If not, check the exclusion settings.',

  'guidance.failed-visible.title': 'Range shown as deterministically failed',
  'guidance.failed-visible.cause': 'A failure that repeats identically on retry, so it is shown as-is rather than hidden.',
  'guidance.failed-visible.impact': 'Only that range produces no memories. Other ranges process normally.',
  'guidance.failed-visible.next': 'Read the stored error text and the failed range in the job detail, then recover.',

  'guidance.job-held.title': 'Work held until a setting is fixed',
  'guidance.job-held.cause': 'The job carries a hold reason: the model selection was rejected by the provider, the extraction rules overlay failed validation, or the forbidden-pattern check could not be run at all. The core spends no attempt while a hold is on.',
  'guidance.job-held.impact': 'It sits in the pending state but is never attempted, so it does not clear itself by waiting. Nothing is lost and no attempt is spent — the conversation range stays unextracted until someone fixes the setting.',
  'guidance.job-held.next': 'Fix the configuration that owns the hold: the model selection under Administration › Models, or the extraction rules under Administration › Overlays. A successful write releases the jobs that hold was keeping.',

  'guidance.job-dead.title': 'Work ended in failure',
  'guidance.job-dead.cause': 'Work that reached a terminal state after exhausting the retry cap.',
  'guidance.job-dead.impact': 'The conversation range it covered is not extracted into memories.',
  'guidance.job-dead.next': 'Read the cause in the job detail and recover — or, if it is not worth reviving, dismiss it with a reason. Recovery deletes nothing.',

  'guidance.job-retry.title': 'Work awaiting retry',
  'guidance.job-retry.cause': 'Waiting for the next retry time after a failure.',
  'guidance.job-retry.impact': 'Processing is only delayed; nothing is lost.',
  'guidance.job-retry.next': 'It is handled automatically once the worker runs. If the wait grows long, read the stored error.',

  'guidance.extraction-failed-range.title': 'A failed extraction range was recorded',
  'guidance.extraction-failed-range.cause': 'A terminal range that records exactly which input range failed.',
  'guidance.extraction-failed-range.impact': 'Only that range has no memories.',
  'guidance.extraction-failed-range.next': 'Recover at the same granularity. The original error text is preserved.',

  'guidance.capture-gap.title': 'An open capture gap',
  'guidance.capture-gap.cause': 'A range where capture went fail-open. The core allowed this deliberately.',
  'guidance.capture-gap.impact': 'The conversation in that range is not in the index.',
  'guidance.capture-gap.next': 'Not a target for the recovery command — the next successful capture in the same session closes it. To surface failures immediately, run with MEMEX_STRICT_CAPTURE=1.',

  'guidance.lease-expired.title': 'Running work whose lease expired',
  'guidance.lease-expired.cause': 'It is marked running, but the lease time has already passed: the runner disappeared mid-flight.',
  'guidance.lease-expired.impact': 'It makes no progress until another worker picks it up.',
  'guidance.lease-expired.next': 'Running the worker reclaims the lease. If it persists, recover it.',

  'guidance.model-call-failed.title': 'The model call itself failed',
  'guidance.model-call-failed.cause': 'The failure was in calling the model — the network, starting the runner (codex), or authentication. It is a call-path problem, not a problem with the response content.',
  'guidance.model-call-failed.impact': 'That call produced nothing. The core treats this as a transient error and does not spend an attempt, so the budget is unchanged.',
  'guidance.model-call-failed.next': 'Usually a retry resolves it. If it repeats, check the runner and authentication first using the error text in the Model attempts tab — this is not a prompt or input-length problem.',

  'guidance.model-invalid-json.title': 'The model returned a malformed response',
  'guidance.model-invalid-json.cause': 'The model response did not satisfy the required JSON schema, so the core refused to store it.',
  'guidance.model-invalid-json.impact': 'Only that attempt’s output is discarded. Nothing wrong is stored as a memory.',
  'guidance.model-invalid-json.next': 'Usually a retry resolves it. If it repeats, check the error text and the input length in the Model attempts tab.',

  'guidance.embedding-unavailable.title': 'The embedding runtime could not be prepared',
  'guidance.embedding-unavailable.cause': 'The local embedding model failed to load: the model files are missing, or the runtime dependencies are not in place.',
  'guidance.embedding-unavailable.impact': 'Semantic search and classification stop, and saving a meaning edit fails too. Stored memories are untouched.',
  'guidance.embedding-unavailable.next': 'Materialise the dependencies, run diagnostics, then backfill the missing embeddings.',

  'guidance.ontology-parked.title': 'Memories parked in classification',
  'guidance.ontology-parked.cause': 'Classification was attempted the allowed number of times, failed, and the memory was parked under General/Misc. It does not count as classified.',
  'guidance.ontology-parked.impact': 'It has no proper place in the taxonomy or the knowledge map. The memory itself and its injection are unaffected.',
  'guidance.ontology-parked.next': 'Parked items get one more attempt once the policy or the embedding token changes. Run the ontology backfill.',

  'guidance.ontology-index-repair.title': 'The ontology category index needs repair',
  'guidance.ontology-index-repair.cause': 'The category vector index is in a state that self-healing does not fix. This is an index problem, not a memory problem.',
  'guidance.ontology-index-repair.impact': 'Classification is blocked. New memories keep being stored but pile up waiting to be classified.',
  'guidance.ontology-index-repair.next': 'Backfill embeddings to rebuild the vectors. If it survives that, review it together with the diagnostics output.',

  'guidance.derived-lane-skip.title': 'The derived lane yielded',
  'guidance.derived-lane-skip.cause': 'Higher-priority capture and capsule work is backed up, so consolidation, re-embedding, classification and extraction backfill gave up their turn.',
  'guidance.derived-lane-skip.impact': 'It looks like "the queue never shrinks", but the cause is in another lane. No data is lost.',
  'guidance.derived-lane-skip.next': 'Drain the backlog first. After enough consecutive yields the core forces one pass through.',

  'guidance.evidence-missing.title': 'Memories without a local verification receipt',
  'guidance.evidence-missing.cause': 'There is no local verification receipt for the current meaning version. It can be rebuilt while the original is still there.',
  'guidance.evidence-missing.impact': 'They are excluded from automatic consolidation and lose sync conflicts — this is the real cause behind "duplicate memories keep piling up".',
  'guidance.evidence-missing.next': 'Rebuild them with the receipt backfill. Memories whose original is gone cannot be recovered.',

  'guidance.evidence-unresolved.title': 'The evidence original could not be resolved',
  'guidance.evidence-unresolved.cause': 'The original exchange the memory points at was not found in the current index.',
  'guidance.evidence-unresolved.impact': 'That work ends without storing a memory. It never stores one on wrong evidence.',
  'guidance.evidence-unresolved.next': 'Fill the index with Sync conversations, then recover.',

  'guidance.stale-fact.title': 'The memory changed mid-edit',
  'guidance.stale-fact.cause': 'The same memory changed through another path while the save was in flight, so the core refused to overwrite it.',
  'guidance.stale-fact.impact': 'None — the previous value stands. The safeguard did its job.',
  'guidance.stale-fact.next': 'Refresh the screen, check the current value, then try again.',

  'guidance.tier-step.title': 'Tiers move one rung at a time',
  'guidance.tier-step.cause': 'The move tried to skip a rung on the branch ⇄ project-wide ⇄ global ladder, or it is already at the end.',
  'guidance.tier-step.impact': 'None. Nothing changed.',
  'guidance.tier-step.next': 'Move one rung at a time. To reach global, promote to project-wide first.',

  'guidance.receipt-failed.title': 'The context went out but no receipt was stored',
  'guidance.receipt-failed.cause': 'The memory was emitted as context, but the durable recall receipt stayed in the prepared state.',
  'guidance.receipt-failed.impact': 'It becomes impossible to audit after the fact which memory entered which session and when.',
  'guidance.receipt-failed.next': 'Run diagnostics and check that the DB is writable, plus disk space and permissions.',

  'guidance.no-match.title': 'No related memory was found',
  'guidance.no-match.cause': 'There were no candidates, or all of them fell at the relevance gate. This is not an error.',
  'guidance.no-match.impact': 'No memory was provided for that request.',
  'guidance.no-match.next': 'Check how many memories this project has stored. If some are hidden on a branch tier, you can include them in the view.',

  'guidance.quarantined-project.title': 'Quarantined project',
  'guidance.quarantined-project.cause': 'The project was created from a cwd that cannot identify a project, such as `/`. Its memories are preserved but excluded from injection and reads.',
  'guidance.quarantined-project.impact': 'That project’s memories are not injected. They were not deleted.',
  'guidance.quarantined-project.next': 'There is no automatic recovery command. Work again from a proper cwd, and move the earlier memories over with a tier change if you need them.',

  'guidance.sync-disabled.title': 'Sync is off',
  'guidance.sync-disabled.cause': 'This is the default. Nothing is broken.',
  'guidance.sync-disabled.impact': 'Memory state is not exchanged with other machines.',
  'guidance.sync-disabled.next': 'To use it, set a shared folder under Administration › Sync and turn it on.',

  'guidance.sync-never-exported.title': 'Sync is on but nothing was ever exported',
  'guidance.sync-never-exported.cause': 'The switch is on, but there is no export record.',
  'guidance.sync-never-exported.impact': 'Other machines cannot see this machine’s memories.',
  'guidance.sync-never-exported.next': 'Create the first generation with Export now under Administration › Sync.',

  'guidance.sync-locked.title': 'Another export is in progress',
  'guidance.sync-locked.cause': 'An export is already running against the same data root.',
  'guidance.sync-locked.impact': 'None. Only this request is skipped.',
  'guidance.sync-locked.next': 'Safe to ignore. Try again in a moment.',

  'guidance.sync-unchanged.title': 'Nothing to export',
  'guidance.sync-unchanged.cause': 'No durable memory changed since the last export. Not creating an empty generation is intended behaviour.',
  'guidance.sync-unchanged.impact': 'None. If the other machines already received the last generation, there is nothing for them to fetch either.',
  'guidance.sync-unchanged.next': 'Safe to ignore. To create a generation anyway, export with --force from the CLI.',

  'guidance.sync-export-failed.title': 'Sync export failed',
  'guidance.sync-export-failed.cause': 'Usually the shared folder is not writable (missing path, permissions, or a stalled cloud sync).',
  'guidance.sync-export-failed.impact': 'This machine’s changes do not leave for the others. The local memories are untouched.',
  'guidance.sync-export-failed.next': 'Check the shared-folder path and whether it is writable under Administration › Sync, then export again.',

  'guidance.sync-archive-invalid.title': 'The generation file cannot be written or read',
  'guidance.sync-archive-invalid.cause': 'The path is not a Memex generation file (the zip must contain meta.json and all four JSONL files), or it was made by this machine, or the export path is outside the data root.',
  'guidance.sync-archive-invalid.impact': 'Nothing was applied. The existing memories are untouched.',
  'guidance.sync-archive-invalid.next': 'Paste the exact zip path produced by Administration › Sync on the other Mac. The error text says which condition was broken.',

  'guidance.operation-incomplete.title': 'The admin run finished with work left over',
  'guidance.operation-incomplete.cause': 'The backfill finished in the foreground but left work to do, so it exited with code 2. This is not a failure.',
  'guidance.operation-incomplete.impact': 'The remaining targets are handled by the next run or by the worker.',
  'guidance.operation-incomplete.next': 'Run the same command again, or run the worker.',

  // ── The 37th class, created at runtime by unknownClass() ──
  'guidance.unknown.title': 'Unknown error',
  'guidance.unknown.cause': 'There is no guidance for this error string yet. We do not guess at the cause.',
  'guidance.unknown.impact': 'The blast radius cannot be stated. Read the original text below together with the job detail.',
  'guidance.unknown.next': 'Export the diagnostics JSON and report it with the original text. Diagnostics contain no conversation or memory text and no absolute paths.',

  // ── The 24 action button labels (actions[].labelKey) ──
  'guidance.action.recoverDeadWork': 'Recover failed work',
  'guidance.action.runDoctor': 'Run core diagnostics',
  'guidance.action.syncConversations': 'Sync conversations',
  'guidance.action.viewRuntime': 'Runtime information',
  'guidance.action.viewDeadJobs': 'View failed work',
  'guidance.action.viewModelSettings': 'Model selection settings',
  'guidance.action.viewExtractionRules': 'Extraction rules settings',
  'guidance.action.viewEnvVars': 'Check environment variables',
  'guidance.action.viewAttempts': 'View model attempts',
  'guidance.action.viewRunningJobs': 'View running work',
  'guidance.action.viewErrorLogs': 'View error logs',
  'guidance.action.viewEnvironment': 'Check the environment',
  'guidance.action.viewJobs': 'View jobs',
  'guidance.action.viewRetryJobs': 'View work awaiting retry',
  'guidance.action.backfillEmbeddings': 'Backfill embeddings',
  'guidance.action.backfillOntology': 'Backfill ontology classification',
  'guidance.action.viewTaxonomy': 'View taxonomy',
  'guidance.action.viewFacts': 'View memories',
  'guidance.action.viewChronicle': 'View revisions',
  'guidance.action.viewRecalls': 'View context recalls',
  'guidance.action.viewFactsAllTiers': 'View memories including tiers',
  'guidance.action.viewAllFacts': 'View all memories',
  'guidance.action.syncSettings': 'Sync settings',
  'guidance.action.syncStatus': 'Sync status',
  'guidance.action.viewOperations': 'Admin run history',
  'guidance.action.exportDiagnostics': 'Export diagnostics',

  // ── The 11 count labels on the Overview attention card; one-slot patterns ──
  'guidance.attention.job-held.detail': '{count} waiting on a configuration fix',
  'guidance.attention.job-dead.detail': '{count} failed',
  'guidance.attention.job-retry.detail': '{count} awaiting retry',
  'guidance.attention.failed-visible.detail': '{count} deterministically failed ranges',
  'guidance.attention.extraction-failed-range.detail': '{count} recorded extraction failures',
  'guidance.attention.capture-gap.detail': '{count} open capture gaps',
  'guidance.attention.budget-exhausted.detail': '{count} exhausted model budgets',
  'guidance.attention.ontology-parked.detail': '{count} parked memories',
  'guidance.attention.evidence-missing.detail': '{count} memories without a receipt',
  'guidance.attention.quarantined-project.detail': '{count} quarantined projects',
  'guidance.attention.derived-lane-skip.detail': '{count} consecutive yields',
  // Index repair carries a blocking reason rather than a count; common.unknown when absent.
  'guidance.attention.ontology-index-repair.detail': 'Blocked · {reason}',

  // ── Shared labels ──
  'guidance.ignorable.true': 'Safe to ignore',
  'guidance.ignorable.false': 'Action needed',
  'guidance.ignorable.unknown': 'Impact unknown',
  'guidance.kv.cause': 'Cause',
  'guidance.kv.impact': 'Impact',
  'guidance.kv.next': 'Next action',
  'guidance.source.label': 'Single source',
  'guidance.attention.heading': 'Needs attention',
  'guidance.attention.subtitle': 'Grouped by failure class. Values that were never collected are not counted as zero.',
  'guidance.attention.link': 'Activity & tracing',
};
