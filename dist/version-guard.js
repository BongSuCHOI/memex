/**
 * Version drift guard — a plugin update must not leave old-version processes running.
 *
 * Incident (2026-07-14): a v1.3.3 sync-cli wedged for 23h kept the singleton lock,
 * silently starving every newer sync (indexing frozen), while the stale install
 * record kept spawning v1.3.3 into every new session after v1.4.3 shipped.
 *
 * Two enforcement points use this module:
 *  - sync-cli lock: the lock file carries {pid, version, startedAt} so a newer
 *    sync takes over from an older or wedged holder instead of skipping forever.
 *  - SessionStart sweep (scripts/version-drift-check.js): detached workers
 *    running from an older versioned plugin dir are terminated. MCP servers are
 *    never swept — killing one breaks a live session's tools; those only rotate
 *    on session restart.
 */
/** Small semver-compatible comparator for plugin cache version directories. */
export function compareVersions(a, b) {
    const split = (value) => {
        const [core, ...preParts] = value.split('-');
        return {
            core: core.split('.').map((n) => parseInt(n, 10)),
            pre: preParts.join('-'),
        };
    };
    const pa = split(a);
    const pb = split(b);
    const len = Math.max(pa.core.length, pb.core.length);
    for (let i = 0; i < len; i++) {
        const x = Number.isFinite(pa.core[i]) ? pa.core[i] : 0;
        const y = Number.isFinite(pb.core[i]) ? pb.core[i] : 0;
        if (x !== y)
            return x < y ? -1 : 1;
    }
    if (pa.pre === pb.pre)
        return 0;
    if (!pa.pre)
        return 1;
    if (!pb.pre)
        return -1;
    return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) < 0 ? -1 : 1;
}
/**
 * Parse the JSON lock pid-file content: {pid, version, startedAt}.
 * Returns null when no usable pid can be extracted (caller treats the
 * lock as garbage: reclaim without killing anything).
 */
export function parseLockMeta(raw) {
    const t = raw.trim();
    if (!t)
        return null;
    try {
        const o = JSON.parse(t);
        const pid = typeof o.pid === 'number' ? o.pid : parseInt(String(o.pid), 10);
        if (!Number.isFinite(pid) || pid <= 1)
            return null;
        return {
            pid,
            version: typeof o.version === 'string' && o.version ? o.version : null,
            startedAt: typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) ? o.startedAt : null,
        };
    }
    catch {
        return null;
    }
}
/**
 * Decide whether a live lock holder should be preempted.
 *  - Older known version → take over: stale code must not keep indexing.
 *  - Runtime above wedgeMaxMs → take over regardless of version: a wedged sync
 *    starves indexing either way (observed: 23h; normal incremental sync is
 *    minutes). holderRunMs null (unknown start) → no wedge judgement.
 */
export function decideTakeover(holder, myVersion, holderRunMs, wedgeMaxMs) {
    if (holder.version && compareVersions(holder.version, myVersion) < 0)
        return 'takeover-stale-version';
    if (holderRunMs !== null && holderRunMs > wedgeMaxMs)
        return 'takeover-wedged';
    return 'defer';
}
/**
 * Detached memory-bank workers running from a versioned plugin cache dir.
 * Deliberately excludes mcp-server / mcp-server-wrapper (owned by live sessions).
 */
const WORKER_RE = /plugins\/cache\/[^/]+\/memory-bank\/([A-Za-z0-9][A-Za-z0-9._+-]*)\/(?:dist\/sync-cli\.js|scripts\/(?:backfill-extract-worker|backfill-ontology-worker|fact-consolidate-worker|fact-extract-worker|reembed-worker)\.js)/;
/**
 * If `command` is a memory-bank detached worker from a version OLDER than
 * `myVersion`, return that stale version string; otherwise null.
 */
export function staleWorkerVersion(command, myVersion) {
    const m = WORKER_RE.exec(command);
    if (!m)
        return null;
    return compareVersions(m[1], myVersion) < 0 ? m[1] : null;
}
