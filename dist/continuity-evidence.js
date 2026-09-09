// SQLite assigns a device-local, never-reused sequence. Consumers traverse the
// ordered subset belonging to their workstream; gaps from other streams or
// privacy deletion are not missing input.
// Even JSON's six-character escape expansion stays below one page.
const TEXT_PART_CHARS = 3_000;
export const CAPSULE_PAGE_CHARS = 24_000;
export const CAPSULE_PAGE_ITEMS = 8;
/**
 * Smallest page a shrinking retry may reach (issue #33). One evidence fragment
 * is the indivisible unit: below this the only remaining move is to record the
 * failure and step over that fragment.
 */
export const CAPSULE_MIN_PAGE_ITEMS = 1;
const CAPSULE_MIN_PAGE_CHARS = TEXT_PART_CHARS;
export const CAPSULE_POLICY_VERSION = "continuity-capsule-v2";
export function appendExchangeEvidence(db, exchangeId) {
    if (!db.inTransaction)
        throw new Error("evidence append requires the exchange write transaction");
    const row = db.prepare(`
    SELECT e.id, e.session_id, e.workspace_id, e.content_generation, e.content_hash,
           e.line_start, e.line_end, e.timestamp, e.user_message, e.assistant_message,
           COALESCE(e.workstream_id, s.workstream_id) AS workstream_id
    FROM exchanges e JOIN session_memory_state s ON s.session_id = e.session_id
    JOIN minimal_workstreams w ON w.workstream_id = COALESCE(e.workstream_id, s.workstream_id)
    WHERE e.id = ? AND e.project_id = s.project_id AND e.project_id = w.project_id
      AND COALESCE(e.workstream_id, s.workstream_id) = s.workstream_id
      AND NOT EXISTS (SELECT 1 FROM conversation_exclusions x WHERE x.session_id = e.session_id)
  `).get(exchangeId);
    if (!row)
        return 0;
    if (db.prepare(`SELECT 1 FROM workstream_evidence
    WHERE workstream_id = ? AND exchange_id = ? AND content_generation = ? LIMIT 1`)
        .get(row.workstream_id, exchangeId, row.content_generation))
        return 0;
    const tools = db.prepare(`
    SELECT id, tool_name, tool_result, source_type FROM tool_calls
    WHERE exchange_id = ? AND learnable = 1 AND is_error = 0
      AND source_type IN ('repo_file','git_history','test_execution')
    ORDER BY timestamp, id
  `).all(exchangeId);
    const base = {
        exchangeId, contentGeneration: Number(row.content_generation), contentHash: row.content_hash,
        sourceSessionId: row.session_id, effectiveAt: row.timestamp,
        lines: [Number(row.line_start), Number(row.line_end)],
    };
    const full = { ...base, human: row.user_message, assistantContextOnly: row.assistant_message, trustedTools: tools };
    const parts = [];
    if (JSON.stringify(full).length <= 8_000) {
        parts.push(full);
    }
    else {
        // No sampling or truncation. Oversized exchanges are a deterministic series
        // of labeled fragments; every character remains pending until consumed.
        const split = (text, make) => {
            for (let offset = 0; offset < text.length;) {
                let end = Math.min(text.length, offset + TEXT_PART_CHARS);
                if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]))
                    end--;
                parts.push({ ...base, human: "", assistantContextOnly: "", trustedTools: [], ...make(text.slice(offset, end), offset) });
                offset = end;
            }
        };
        split(String(row.user_message), (human, textOffset) => ({ human, textOffset }));
        split(String(row.assistant_message), (assistantContextOnly, textOffset) => ({ assistantContextOnly, textOffset }));
        for (const tool of tools)
            split(String(tool.tool_result ?? ""), (tool_result, textOffset) => ({
                trustedTools: [{ ...tool, tool_result }], textOffset,
            }));
    }
    db.prepare("INSERT OR IGNORE INTO capsule_frontiers(workstream_id) VALUES (?)").run(row.workstream_id);
    const insert = db.prepare(`INSERT INTO workstream_evidence
    (workstream_id, exchange_id, source_session_id, workspace_id, content_generation,
     content_hash, part, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [part, payload] of parts.entries()) {
        insert.run(row.workstream_id, exchangeId, row.session_id, row.workspace_id, row.content_generation, row.content_hash, part, JSON.stringify({ ...payload, part, parts: parts.length }), new Date().toISOString());
    }
    return parts.length;
}
export function appendSessionEvidence(db, sessionId) {
    const tx = db.transaction(() => {
        const rows = db.prepare("SELECT id FROM exchanges WHERE session_id = ? ORDER BY exchange_seq, rowid")
            .all(sessionId);
        for (const row of rows)
            appendExchangeEvidence(db, row.id);
    });
    db.inTransaction ? tx() : tx.immediate();
}
export function readCapsulePage(db, checkpointId) {
    if (!db.inTransaction)
        throw new Error("Capsule page requires a transaction");
    const state = db.prepare(`
    SELECT s.workstream_id, s.target_seq, s.target_revision,
           s.page_items_hint, s.page_chars_hint, f.through_seq, f.revision
    FROM capsule_checkpoint_state s JOIN capsule_frontiers f USING(workstream_id)
    WHERE s.checkpoint_id = ?
  `).get(checkpointId);
    if (!state)
        throw new Error("Capsule frontier is missing");
    // Issue #33: a previous failed attempt narrows this page so the retry is not
    // byte-for-byte identical to the attempt that already failed.
    const pageItems = state.page_items_hint === null
        ? CAPSULE_PAGE_ITEMS
        : Math.max(CAPSULE_MIN_PAGE_ITEMS, Math.min(CAPSULE_PAGE_ITEMS, state.page_items_hint));
    const pageChars = state.page_chars_hint === null
        ? CAPSULE_PAGE_CHARS
        : Math.max(CAPSULE_MIN_PAGE_CHARS, Math.min(CAPSULE_PAGE_CHARS, state.page_chars_hint));
    let targetSeq = state.target_seq;
    if (targetSeq === null || state.target_revision !== state.revision) {
        targetSeq = Math.max(state.through_seq, db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS n FROM workstream_evidence WHERE workstream_id = ?
    `).get(state.workstream_id).n);
        db.prepare("UPDATE capsule_checkpoint_state SET target_seq = ?, target_revision = ? WHERE checkpoint_id = ?")
            .run(targetSeq, state.revision, checkpointId);
    }
    const rows = db.prepare(`
    SELECT seq, payload_json FROM workstream_evidence
    WHERE workstream_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?
  `).all(state.workstream_id, state.through_seq, targetSeq, pageItems);
    const evidence = [];
    let chars = 0;
    let throughSeq = state.through_seq;
    for (const row of rows) {
        if (row.payload_json.length > CAPSULE_PAGE_CHARS)
            throw new Error("Capsule evidence fragment exceeds page budget");
        // A shrunken budget must never produce an empty page: the first fragment
        // always fits, and the char cap only limits how many follow it.
        if (evidence.length > 0 && chars + row.payload_json.length > pageChars)
            break;
        evidence.push({ ...JSON.parse(row.payload_json), evidenceSeq: row.seq });
        chars += row.payload_json.length;
        throughSeq = row.seq;
    }
    // The fixed target can contain deleted rows. Deletion bumps revision and
    // resets the target before this read; an empty eligible range is safe to drain.
    if (!rows.length)
        throughSeq = Math.max(throughSeq, targetSeq);
    return { fromSeq: state.through_seq, throughSeq, targetSeq, revision: state.revision, evidence };
}
export function commitCapsulePage(db, workstreamId, page) {
    return db.prepare(`UPDATE capsule_frontiers SET through_seq = ?
    WHERE workstream_id = ? AND through_seq = ? AND revision = ?`)
        .run(page.throughSeq, workstreamId, page.fromSeq, page.revision).changes === 1;
}
/**
 * Halve the next page for this checkpoint (issue #33).
 *
 * `commitCapsulePage` is the only writer of `through_seq`, and it runs inside
 * the successful patch application. A failed attempt therefore left the
 * frontier exactly where it was, and the next `readCapsulePage` re-read the
 * identical rows: `max_attempts` retries of a deterministic failure. Feeding
 * the failure back as a smaller page makes the retry meaningfully different.
 *
 * Returns the page budget the next attempt will use, and whether that budget
 * is already at the floor (nothing left to shrink).
 */
export function shrinkCapsulePageHint(db, checkpointId) {
    const row = db.prepare("SELECT page_items_hint, page_chars_hint FROM capsule_checkpoint_state WHERE checkpoint_id = ?").get(checkpointId);
    if (!row)
        return null;
    const currentItems = row.page_items_hint ?? CAPSULE_PAGE_ITEMS;
    const currentChars = row.page_chars_hint ?? CAPSULE_PAGE_CHARS;
    const items = Math.max(CAPSULE_MIN_PAGE_ITEMS, Math.floor(currentItems / 2));
    const chars = Math.max(CAPSULE_MIN_PAGE_CHARS, Math.floor(currentChars / 2));
    db.prepare("UPDATE capsule_checkpoint_state SET page_items_hint = ?, page_chars_hint = ? WHERE checkpoint_id = ?").run(items, chars, checkpointId);
    return {
        items,
        chars,
        atFloor: items === CAPSULE_MIN_PAGE_ITEMS && chars === CAPSULE_MIN_PAGE_CHARS,
    };
}
/** A drained or successfully committed page restores the full page budget. */
export function clearCapsulePageHint(db, checkpointId) {
    db.prepare("UPDATE capsule_checkpoint_state SET page_items_hint = NULL, page_chars_hint = NULL WHERE checkpoint_id = ?").run(checkpointId);
}
/**
 * Record partial progress past a fragment that cannot be distilled (issue #33).
 *
 * When shrinking has reached one fragment and that fragment still fails
 * terminally, leaving the frontier at `fromSeq` freezes the whole workstream:
 * every later Capsule read starts on the same unusable row and every capsule
 * is reported permanently stale. Stepping the frontier over exactly that one
 * fragment keeps the stream moving. The skipped `seq` is returned so the caller
 * records what was not distilled — it is never silently dropped.
 */
export function skipCapsuleEvidenceHead(db, workstreamId, page) {
    const head = page.evidence[0];
    const seq = typeof head?.evidenceSeq === "number" ? head.evidenceSeq : null;
    if (seq === null || seq <= page.fromSeq)
        return null;
    const changed = db.prepare(`UPDATE capsule_frontiers SET through_seq = ?
    WHERE workstream_id = ? AND through_seq = ? AND revision = ?`)
        .run(seq, workstreamId, page.fromSeq, page.revision).changes;
    return changed === 1 ? seq : null;
}
export function capsulePageIsCurrent(db, workstreamId, page) {
    return !!db.prepare(`SELECT 1 FROM capsule_frontiers
    WHERE workstream_id = ? AND through_seq = ? AND revision = ?`)
        .get(workstreamId, page.fromSeq, page.revision);
}
