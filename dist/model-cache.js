/**
 * Issue #92 — where the embedding model weights live.
 *
 * `@xenova/transformers` caches downloaded weights in `env.cacheDir`, whose
 * default is `<node_modules/@xenova/transformers>/.cache` — a path RELATIVE TO
 * THE PACKAGE. Every Memex version unpacks into its own plugin root
 * (`~/.codex/plugins/cache/<market>/memex/<version>`), so that default gives each
 * version its own 129 MB cache and `memex update` silently throws the old one
 * away.
 *
 * Measured on the real data root (2026-09-10): `0.6.2` and `0.6.3` roots held no
 * cache, the fresh `0.6.4` root downloaded 129 MB on first use, and the first six
 * `inject` runs on that root took 69,596 / 74,010 / 69,792 / 68,238 / 68,647 /
 * 67,941 ms — all download. With a warm cache the same work is 321–1,204 ms. It
 * was worse than one slow prompt: the session's MCP daemon and the hook's
 * in-process fallback downloaded the SAME 129 MB concurrently, because the daemon
 * blew its 10s compute budget while downloading and the hook fell back into a
 * root whose cache was equally empty.
 *
 * So the cache moves OUT of the install tree and into the data root, which
 * survives every update: `<data root>/models`, resolved through the same home
 * precedence as everything else (`getMemexHome`), with `MEMEX_MODEL_CACHE_DIR` as
 * the explicit override.
 *
 * Dependencies: node builtins, `./paths.js` and `./plugin-root.js` only — no
 * `@xenova/transformers`. `memex doctor` and the `memex deps warm` gate have to
 * answer "is the model there?" on a host whose runtime closure is MISSING, which
 * is exactly when the answer matters; loading the model library to find out would
 * make the check fail in that case.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMemexHome } from "./paths.js";
import { codexCacheCandidates, resolveInstalledPluginRoot } from "./plugin-root.js";
/**
 * Multilingual retrieval model (Korean/English/100 langs), 384-dim — same
 * dimension as the original all-MiniLM-L6-v2 so vec tables are unchanged.
 *
 * Model selection (2026-06-12, measured on real-DB Korean/English pairs):
 *   - all-MiniLM-L6-v2: English-only — Korean queries score ~0 vs English facts
 *   - paraphrase-multilingual-MiniLM-L12-v2: top-1 ranking broke on real data
 *     (unrelated Korean pairs up to 0.82 — strong anisotropy)
 *   - multilingual-e5-small: perfect top-1 ranking on the hard set; absolute
 *     scores are compressed (~0.72-0.99) so consumers use either retuned
 *     thresholds (passage↔passage) or probe-baseline normalization (queries).
 *
 * e5 protocol: queries are embedded with a "query: " prefix, stored content
 * with "passage: ". Pass the mode explicitly at call sites.
 *
 * Vectors from different models are NOT comparable; EMBEDDING_VERSION (see
 * src/embeddings.ts) tracks which model produced a stored vector and the
 * re-embed worker upgrades rows.
 *
 * It lives here rather than in `src/embeddings.ts` because the cache layout is
 * keyed on the model id, and this module must stay loadable without the model
 * library.
 */
export const DEFAULT_EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_MODEL = process.env.MEMEX_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
/** Basename of the stable cache inside the data root. */
const MODEL_CACHE_BASENAME = "models";
/** Per-package default of `@xenova/transformers` — the legacy layout. */
const LEGACY_CACHE_RELATIVE = path.join("node_modules", "@xenova", "transformers", ".cache");
/** How `embeddingCacheDir()` was resolved — reported verbatim by doctor. */
export function embeddingCacheSource() {
    return process.env.MEMEX_MODEL_CACHE_DIR?.trim() ? "env" : "data-root";
}
/**
 * The ONE directory every Memex process caches model weights in.
 *
 * `MEMEX_MODEL_CACHE_DIR` wins (an operator pointing at a shared or external
 * volume); otherwise `<data root>/models`, so `MEMEX_HOME` →
 * `$XDG_CONFIG_HOME/memex` → `~/.config/memex` decides it exactly as it decides
 * the archive and the index.
 */
export function embeddingCacheDir() {
    const override = process.env.MEMEX_MODEL_CACHE_DIR?.trim();
    if (override)
        return path.resolve(override);
    return path.resolve(getMemexHome(), MODEL_CACHE_BASENAME);
}
/** Where `<cacheDir>` holds one model's files: `<cacheDir>/<org>/<name>`. */
export function embeddingModelCacheDir(model = EMBEDDING_MODEL, cacheDir = embeddingCacheDir()) {
    return path.join(cacheDir, ...model.split("/"));
}
/** `=1` only — see `EmbeddingCacheStatus.stub`. */
export function embeddingStubReplacesModel() {
    return process.env.MEMEX_EMBEDDING_STUB === "1";
}
function walk(dir, onFile) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, onFile);
            continue;
        }
        if (!entry.isFile())
            continue;
        try {
            onFile(full, fs.statSync(full).size);
        }
        catch {
            /* vanished mid-walk — it does not count */
        }
    }
}
/**
 * Is a model present in `modelDir`, and how big is it?
 *
 * Read-only: `doctor` and the warm gate both call it, and neither may create the
 * directory as a side effect of asking.
 */
export function inspectModelCacheDir(modelDir) {
    let files = 0;
    let bytes = 0;
    let weights = false;
    walk(modelDir, (file, size) => {
        files++;
        bytes += size;
        if (file.toLowerCase().endsWith(".onnx") && size > 0)
            weights = true;
    });
    const config = (() => {
        try {
            return fs.statSync(path.join(modelDir, "config.json")).size > 0;
        }
        catch {
            return false;
        }
    })();
    return { present: weights && config, files, bytes };
}
export function embeddingCacheStatus(model = EMBEDDING_MODEL) {
    const dir = embeddingCacheDir();
    const modelDir = embeddingModelCacheDir(model, dir);
    const { present, files, bytes } = inspectModelCacheDir(modelDir);
    return {
        dir,
        source: embeddingCacheSource(),
        model,
        modelDir,
        present,
        files,
        bytes,
        stub: embeddingStubReplacesModel(),
    };
}
/**
 * Root of the copy that is EXECUTING, derived from this module's own URL.
 *
 * Every shape sits one level below the root: `src/model-cache.ts`,
 * `dist/model-cache.js` and the esbuild bundle `dist/mcp-server.js`.
 */
function executionRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, "..");
    try {
        return fs.realpathSync(root);
    }
    catch {
        return root;
    }
}
/**
 * Every per-root cache a previous version could have left behind, best first.
 *
 * Three sources, in the order that makes the first hit the most likely to be
 * complete: the root that is running right now (it downloaded today's 129 MB),
 * then every installed version in the Codex plugin cache (the roots earlier
 * updates filled and abandoned), then the resolved installed/launcher root.
 *
 * Read-only and de-duplicated. A root with no cache directory is simply not
 * listed, so the caller never has to filter.
 */
export function legacyEmbeddingCacheCandidates(options = {}) {
    const running = options.executionRoot ?? executionRoot();
    const roots = [
        { root: running, kind: "execution-root" },
    ];
    try {
        for (const candidate of codexCacheCandidates(options.codexHome)) {
            roots.push({ root: candidate.root, kind: "codex-cache" });
        }
    }
    catch {
        /* an unreadable Codex home contributes nothing */
    }
    try {
        roots.push({
            root: resolveInstalledPluginRoot({
                fallbackRoot: running,
                probeCodex: false,
                codexHome: options.codexHome,
            }).root,
            kind: "launcher",
        });
    }
    catch {
        /* resolution is best-effort */
    }
    const found = [];
    const seen = new Set();
    for (const { root, kind } of roots) {
        const cacheDir = path.join(root, LEGACY_CACHE_RELATIVE);
        if (seen.has(cacheDir))
            continue;
        seen.add(cacheDir);
        try {
            if (!fs.statSync(cacheDir).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        found.push({ cacheDir, kind, root });
    }
    return found;
}
/**
 * One-time adoption of a legacy per-root cache into the stable directory.
 *
 * COPY, never move: the legacy cache belongs to an installation this process
 * does not own — in the `codex-cache` case to a DIFFERENT version's tree — and
 * moving or deleting files there would break that installation, which may be
 * running right now. Nothing outside `<cacheDir>` is written, and nothing
 * anywhere is removed.
 *
 * A no-op once the stable cache holds the model, which is what makes it
 * "one-time" without any marker file to keep honest.
 */
export function adoptLegacyEmbeddingCache(options = {}) {
    const model = options.model ?? EMBEDDING_MODEL;
    const cacheDir = embeddingCacheDir();
    const none = (reason) => ({
        copied: false, from: null, kind: null, bytes: 0, files: 0, reason,
    });
    if (inspectModelCacheDir(embeddingModelCacheDir(model, cacheDir)).present) {
        return none("already-present");
    }
    for (const candidate of legacyEmbeddingCacheCandidates(options)) {
        const sourceModelDir = embeddingModelCacheDir(model, candidate.cacheDir);
        const source = inspectModelCacheDir(sourceModelDir);
        // Only a COMPLETE legacy cache is worth copying: adopting a half-downloaded
        // tree would leave the stable cache looking present while transformers still
        // had to fetch the weights.
        if (!source.present)
            continue;
        const targetModelDir = embeddingModelCacheDir(model, cacheDir);
        try {
            fs.mkdirSync(path.dirname(targetModelDir), { recursive: true });
            // `force: false` + `errorOnExist: false` = existing files are skipped, so a
            // partially adopted cache is completed rather than rewritten, and a
            // concurrent adopter cannot truncate a file this one is reading.
            fs.cpSync(sourceModelDir, targetModelDir, {
                recursive: true,
                force: false,
                errorOnExist: false,
            });
        }
        catch (error) {
            return {
                ...none("copy-failed"),
                from: sourceModelDir,
                kind: candidate.kind,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        const adopted = inspectModelCacheDir(targetModelDir);
        return {
            copied: adopted.present,
            from: sourceModelDir,
            kind: candidate.kind,
            bytes: adopted.bytes,
            files: adopted.files,
            reason: adopted.present ? null : "copy-failed",
        };
    }
    return none("no-legacy-cache");
}
/** Create the stable cache directory. Returns it, whether or not it existed. */
export function ensureEmbeddingCacheDir() {
    const dir = embeddingCacheDir();
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch {
        // An unwritable cache directory is not fatal here: transformers will report
        // it on the download path, and a read-only host can still run with a cache
        // somebody else populated.
    }
    return dir;
}
/** Human-readable size for log lines and doctor details. */
export function formatCacheBytes(bytes) {
    if (bytes >= 1024 ** 3)
        return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2)
        return `${Math.round(bytes / 1024 ** 2)} MB`;
    if (bytes >= 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}
