import net from 'node:net';
/**
 * Warm inject daemon — a unix-socket sidecar inside the long-lived MCP server.
 *
 * Why: the UserPromptSubmit hook pays ~2.3s PER PROMPT as a cold node process
 * (measured: model load 1,130ms + node startup ~400ms + imports 186ms dominate;
 * the actual search is ~30ms). Every Codex session with the plugin runs an MCP server
 * with the embedding model warm — this sidecar lets the hook reuse it: the hook
 * connects, sends the prompt, and gets the context back in ~150ms warm.
 *
 * Lifecycle safety (this plugin's orphan-flood history makes this explicit):
 *  - The daemon lives INSIDE the MCP server process — no new detached process,
 *    no new lifecycle to leak. server.unref() so it never keeps the process
 *    alive on its own; it dies exactly when the MCP server dies.
 *  - Only ONE server binds the socket, and binding is serialized by a lock
 *    file so two starters cannot probe-then-bind over each other.
 *  - Socket mode 600 — same-user only; the payload is the user's own prompt.
 *  - Requests are line-delimited JSON; a malformed request gets a refusal and
 *    never throws into the MCP server.
 *
 * IDENTITY (issue #84) — the socket used to be "whoever got there first".
 *
 * The daemon is a sidecar of *any* running MCP server, and several hosts
 * compete for one socket path under the data root. Observed on the real data
 * root: a Claude Code session had started `Documents/memex/dist/mcp-server.js`
 * from a development checkout (a pre-0.6.0 `dist`), that process owned the
 * socket, and all four prompts from Codex's 0.6.2 hook were answered by the old
 * code — `status:"injected", injected:0, via:"daemon"` (the 0.6.2
 * `context-only` split was not in that build), zero `baseline_margin_gap`
 * telemetry, and that build's tier-read rules. Updating the plugin and
 * restarting Codex did not help, because the stale process still held the
 * socket, and nothing in `doctor` or `status` showed it.
 *
 * Two mechanisms close that:
 *  1. The hook and the daemon exchange identities on the same connection
 *     BEFORE any computation. The daemon answers a prompt only when protocol,
 *     version, build id, plugin root and resolved DB path all match; otherwise
 *     it replies `mismatch` having computed nothing and touched no receipt, and
 *     the hook falls back in-process. An old daemon (no handshake in its reply)
 *     is treated the same way, so correctness holds before both sides update.
 *  2. A development checkout does not open the listener at all unless asked:
 *     only the resolved INSTALLED plugin root serves (see `injectDaemonPolicy`).
 */
/** Wire protocol version. Bumped only for an incompatible message change. */
export declare const INJECT_DAEMON_PROTOCOL = 1;
/**
 * What a daemon must agree with a hook on before it will answer a prompt.
 *
 * Every field is a statement about the CODE that would run, not about who asked:
 * `pluginRoot` is the realpath of the directory the running module was loaded
 * from (never the installed-root resolver — the point is to describe this
 * process), and `dbPath` is the data root it would read and write.
 */
export interface InjectDaemonIdentity {
    protocol: number;
    version: string | null;
    buildId: string | null;
    pluginRoot: string;
    dbPath: string;
}
/** An identity plus the process facts a diagnostic needs to act on it. */
export interface InjectDaemonOwner extends InjectDaemonIdentity {
    pid: number;
    instanceId: string;
    startedAt: string;
    /**
     * Issue #92: is this owner still loading the embedding model?
     *
     * Absent from a pre-0.6.5 owner's reply, which is why it is optional and why
     * `undefined` must read as "it did not say" rather than as `false`.
     */
    warming?: boolean;
}
/**
 * The owner's embedding-model readiness (issue #92).
 *
 * `cold` is the window between `listen()` and the warm-up actually starting;
 * `warming` is the one that matters — on a cold model cache it lasted 68-74s on
 * the observed data root, and every `inject` request that arrived inside it used
 * to queue behind the download, blow the 10s compute budget, and leave the hook
 * to fall back into a SECOND concurrent download of the same 129 MB.
 */
export type InjectDaemonWarmState = 'cold' | 'warming' | 'ready' | 'failed';
/** Reply type and `daemon.reason` for a request that arrived mid-warm-up. */
export declare const INJECT_DAEMON_WARMING = "warming";
/** Why the listener was or was not opened — one log line, and doctor's note. */
export interface InjectDaemonPolicy {
    open: boolean;
    reason: string;
    executionRoot: string;
    installedRoot: string;
    installedSource: string;
}
/**
 * Root of the copy that is EXECUTING, derived from this module's own URL.
 *
 * Deliberately not `resolveInstalledPluginRoot`: that answers "which plugin did
 * Codex install", and a daemon must describe the code it is actually running —
 * those differing is the entire defect. Holds for every shape this module
 * loads in, since all of them sit one level below the root: the esbuild bundle
 * (`dist/mcp-server.js`), the plain build (`dist/inject-daemon.js`) and a
 * TypeScript run (`src/inject-daemon.ts`).
 */
export declare function injectDaemonExecutionRoot(): string;
/**
 * Build identity of the running code: SHA-256 of the shipped bundle.
 *
 * The version alone cannot separate two builds of the same version — a
 * development checkout and the installed 0.6.3 both say `0.6.3` while running
 * different code. Hashing the bundle does. When there is no bundle to hash
 * (a source run), the version plus the entry's mtime is the honest fallback;
 * when there is no entry at all the field is `null`, and the remaining three
 * fields still gate.
 */
export declare function injectDaemonBuildId(root?: string): string | null;
/**
 * The identity a daemon running out of `root` would present.
 *
 * Memoized per root: the bundle hash is computed once, never on the request
 * path. `dbPath` is read per call because a test harness may move the data root
 * between daemons in one process; the three code fields cannot change.
 */
export declare function injectDaemonIdentityFor(root: string): InjectDaemonIdentity;
/** This process's own identity — what a daemon started here would present. */
export declare function injectDaemonIdentity(): InjectDaemonIdentity;
/** Identity equality — all five fields, compared exactly. */
export declare function injectDaemonIdentityMatches(expected: Partial<InjectDaemonIdentity> | null | undefined, actual: Partial<InjectDaemonIdentity> | null | undefined): boolean;
/**
 * May this process own the socket?
 *
 * Only the resolved installed plugin root serves. A development checkout (the
 * `.mcp.json` of a repository, opened by another host) runs perfectly good code
 * that is simply not the code Codex's hooks belong to, and its owning the
 * socket is how an entire session's injections end up on the wrong build.
 * `probeCodex: false` keeps this a pure filesystem decision — the MCP server's
 * startup path must not spawn `codex`. A `launcher` resolution means nothing
 * authoritative was found (the running copy resolved to itself), which is not
 * evidence of an installation, so the listener stays closed.
 *
 * `MEMEX_INJECT_DAEMON=1` forces it open and `=0` forces it closed, for an
 * operator who knows which root they mean.
 */
export declare function injectDaemonPolicy(): InjectDaemonPolicy;
export declare function injectSocketPath(): string;
/**
 * Bytes a unix socket path may occupy, NOT counting the NUL terminator.
 *
 * `sockaddr_un.sun_path` is a fixed array — 104 bytes on macOS/BSD, 108 on Linux
 * — and both `bind(2)` and `connect(2)` refuse anything longer. A long
 * `MEMEX_HOME` is all it takes, and nothing about the resulting failure was
 * visible before 0.6.6: `listen()` reported it asynchronously, the error handler
 * dropped every code that was not EADDRINUSE, and `doctor` could only say the
 * socket file was absent — which reads as "nothing has started yet". Issue #99.
 */
export declare function injectSocketPathLimitBytes(): number;
/** `null` when the path fits; otherwise the measurement `doctor` reports. */
export declare function injectSocketPathTooLong(sockPath?: string): {
    bytes: number;
    limit: number;
} | null;
/** Serializes probe→bind across starters. Never held across a request. */
export declare function injectDaemonLockPath(): string;
/**
 * Where a server that did NOT bind announces that it is re-probing (issue #89).
 *
 * One small file per candidate process, removed when that process binds,
 * retires or exits. It exists for `doctor`: a stale socket file is a transient
 * state when some live MCP server is waiting to reclaim it, and a permanent one
 * when none is, and nothing else on disk can tell those two apart.
 */
export declare function injectDaemonCandidateDir(): string;
/** A live server that is waiting to reclaim the socket. */
export interface InjectDaemonCandidate extends InjectDaemonOwner {
    /** Its re-probe interval, so a diagnostic can say when reclaim is due. */
    reprobeMs: number;
}
/**
 * Every candidate whose process is still alive.
 *
 * Read-only and best-effort: a file left by a SIGKILLed process is skipped
 * rather than deleted, because a diagnostic must not mutate runtime state.
 */
export declare function readInjectDaemonCandidates(dir?: string): InjectDaemonCandidate[];
/**
 * Per-connection budget on the daemon side, and therefore the hook's post-ack
 * compute budget too (`SOCKET_COMPUTE_TIMEOUT_MS` in scripts/inject-context.js).
 *
 * It is an IDLE timeout, so it bounds the whole compute: the daemon writes its
 * `ack` and then goes quiet until the context is ready. Waiting longer than this
 * on the hook side would mean waiting on a connection the daemon has already
 * destroyed, which is why the two sides share one number instead of each picking
 * their own.
 */
export declare const INJECT_DAEMON_REQUEST_TIMEOUT_MS = 10000;
/** `doctor`'s budget: long enough to outlast an owner's embedding-model load. */
export declare const INJECT_DAEMON_DIAGNOSTIC_TIMEOUT_MS = 3000;
/**
 * How often a server that did not bind re-probes the socket (issue #89).
 *
 * 20s sits in the middle of the 15–30s the issue asks for: long enough that a
 * rotating host's servers cost nothing measurable, short enough that a prompt
 * typed a few seconds after the owner exits is the only one paying the cold
 * path. `MEMEX_INJECT_DAEMON_REACQUIRE_MS` shortens it for tests, which cannot
 * sit out 20s per case.
 */
export declare function injectDaemonReacquireIntervalMs(): number;
/** Opportunistic re-probe. Never throws, never blocks the caller. */
export declare function injectDaemonReacquireNow(): void;
/**
 * Read-only identity probe — the question `doctor` and a starting server ask.
 *
 * Never `inject`: that would make the owner compute, and a diagnostic must not
 * produce a recall receipt. `listening: false` distinguishes "nothing is there"
 * (ENOENT / ECONNREFUSED, the normal state) from a socket that exists and
 * cannot be spoken to.
 */
export declare function probeInjectDaemon(sockPath?: string, 
/**
 * The bind path wants a short budget (not serving is always correct, and a
 * starting MCP server must not stall). A diagnostic wants a generous one: the
 * kernel accepts into the listen backlog even while the owner's event loop is
 * busy — an embedding model load is ~1.1s — so a short timeout would report a
 * perfectly healthy owner as one that "did not identify itself".
 */
timeoutMs?: number): Promise<{
    listening: boolean;
    owner: InjectDaemonOwner | null;
    /** Set when something listens but did not answer a usable identity. */
    problem: string | null;
    /**
     * The connect errno, when there was one. Issue #89: "no socket file at all"
     * (ENOENT, the ordinary cold state) and "a socket file nobody listens on"
     * (ECONNREFUSED, an owner that exited) are the same decision for a starter
     * and two different reports for `doctor`, which has to say whether anything
     * is expected to fix it.
     */
    code: string | null;
}>;
export declare function startInjectDaemon(): net.Server | null;
