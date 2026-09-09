/**
 * Issue #53 — one resolution of "the INSTALLED plugin root".
 *
 * `~/.local/bin/memex` is an npx shim
 * (`npx --yes --package=github:BongSuCHOI/memex#main memex "$@"`), so the CLI
 * frequently executes from the npx cache
 * (`~/.npm/_npx/<hash>/node_modules/memex`) rather than from the plugin Codex
 * actually loads (`~/.codex/plugins/cache/<market>/memex/<version>`). Resolving
 * the root from `__dirname/..` therefore inspected the wrong directory: doctor
 * reported `dependencies: missing` for the npx copy (npm hoists dependencies, so
 * that copy never has its own `node_modules`) while the real installation was
 * fine, or vice versa. Every consumer — `memex doctor`, `memex install`,
 * `memex deps materialize`, and the `cli/runtime-exec.js` fallback message —
 * asks this module instead, so they can never disagree again.
 *
 * Resolution order:
 *   1. `MEMEX_PLUGIN_ROOT` — an explicit operator/harness override always wins.
 *   2. The Codex cache identity derived from `$CODEX_HOME/plugins/cache`.
 *   3. `codex plugin list --json` → `installedPath` (only when asked; it spawns).
 *   4. The launcher's own root (the historical `PLUGIN_ROOT` behaviour).
 *
 * (2) is tried before (3) because it is a pure filesystem read with the same
 * answer, and because a diagnostic must not spawn a process on every run.
 *
 * Dependencies: node builtins only. `cli/runtime-exec.js` loads this module on
 * the path where the runtime dependency closure is known to be missing.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The production packages a hook needs before it can run without npx. */
export const RUNTIME_DEPENDENCIES = [
    "better-sqlite3",
    "@xenova/transformers",
    "sqlite-vec",
];
/** Files that identify a directory as a usable Memex installation. */
const INSTALL_MARKERS = ["cli/memex.js", ".codex-plugin/plugin.json"];
export function codexHomeDir(codexHome) {
    const configured = codexHome ?? process.env.CODEX_HOME;
    return configured ? path.resolve(configured) : path.join(os.homedir(), ".codex");
}
/** Version declared by a checkout/installation, manifest first, package second. */
export function readManifestVersion(root) {
    for (const relative of [
        path.join(".codex-plugin", "plugin.json"),
        "package.json",
    ]) {
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
            if (typeof parsed.version === "string" && parsed.version.trim()) {
                return parsed.version.trim();
            }
        }
        catch {
            /* unreadable candidate: try the next one */
        }
    }
    return null;
}
function looksInstalled(candidate) {
    return INSTALL_MARKERS.every((marker) => fs.existsSync(path.join(candidate, marker)));
}
/** Numeric-aware ordering so `0.10.0` sorts above `0.9.0`. */
function compareVersions(a, b) {
    const parse = (value) => value.split(/[.\-+]/).map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
    const left = parse(a);
    const right = parse(b);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? -1) - (right[i] ?? -1);
        if (diff !== 0)
            return diff;
    }
    return a.localeCompare(b);
}
/**
 * Every `<codex home>/plugins/cache/<market>/memex/<version>` that carries a
 * real installation, newest version first. Exported for the resolution test.
 */
export function codexCacheCandidates(codexHome) {
    const cacheRoot = path.join(codexHomeDir(codexHome), "plugins", "cache");
    let markets;
    try {
        markets = fs.readdirSync(cacheRoot, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const found = [];
    for (const market of markets) {
        if (!market.isDirectory())
            continue;
        const pluginDir = path.join(cacheRoot, market.name, "memex");
        let versions;
        try {
            versions = fs.readdirSync(pluginDir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const version of versions) {
            if (!version.isDirectory())
                continue;
            const root = path.join(pluginDir, version.name);
            if (!looksInstalled(root))
                continue;
            found.push({ root, marketplace: market.name, version: version.name });
        }
    }
    // Prefer the `memex` marketplace on a tie so two registrations of the same
    // version resolve deterministically on every device.
    return found.sort((a, b) => compareVersions(b.version, a.version) ||
        (a.marketplace === "memex" ? -1 : b.marketplace === "memex" ? 1 : 0) ||
        a.root.localeCompare(b.root));
}
function fromCodexCache(wantedVersion, codexHome) {
    const candidates = codexCacheCandidates(codexHome);
    if (candidates.length === 0)
        return null;
    const exact = wantedVersion
        ? candidates.find((candidate) => candidate.version === wantedVersion)
        : undefined;
    const chosen = exact ?? candidates[0];
    return { root: chosen.root, version: chosen.version };
}
function fromCodexPluginList() {
    let listed;
    try {
        const result = spawnSync("codex", ["plugin", "list", "--json"], {
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.error || result.status !== 0 || !result.stdout)
            return null;
        listed = JSON.parse(result.stdout);
    }
    catch {
        return null;
    }
    const installed = listed?.installed;
    if (!Array.isArray(installed))
        return null;
    for (const entry of installed) {
        if (entry?.name !== "memex" || entry.installed === false)
            continue;
        const installedPath = entry.installedPath;
        if (typeof installedPath !== "string" || !path.isAbsolute(installedPath))
            continue;
        if (!fs.existsSync(installedPath))
            continue;
        return {
            root: fs.realpathSync(installedPath),
            version: typeof entry.version === "string" ? entry.version : null,
        };
    }
    return null;
}
/**
 * Resolve the plugin root Codex actually loads. Never throws: the launcher root
 * is always an answer, so a diagnostic can report *something* even on a host
 * with no Codex installation at all.
 */
export function resolveInstalledPluginRoot(options = {}) {
    const fallbackRoot = path.resolve(options.fallbackRoot ?? path.join(HERE, ".."));
    if (options.explicitRoot) {
        const root = path.resolve(options.explicitRoot);
        return { root, source: "env", version: readManifestVersion(root) };
    }
    if (process.env.MEMEX_PLUGIN_ROOT) {
        const root = path.resolve(process.env.MEMEX_PLUGIN_ROOT);
        return { root, source: "env", version: readManifestVersion(root) };
    }
    const localVersion = readManifestVersion(fallbackRoot);
    const cached = fromCodexCache(localVersion, options.codexHome);
    if (cached)
        return { root: cached.root, source: "codex-cache", version: cached.version };
    if (options.probeCodex) {
        const listed = fromCodexPluginList();
        if (listed) {
            return {
                root: listed.root,
                source: "codex-plugin-list",
                version: listed.version ?? readManifestVersion(listed.root),
            };
        }
    }
    return { root: fallbackRoot, source: "launcher", version: localVersion };
}
/** Runtime packages absent from `<root>/node_modules`. */
export function missingRuntimeDependencies(root) {
    return RUNTIME_DEPENDENCIES.filter((dependency) => !fs.existsSync(path.join(root, "node_modules", dependency, "package.json")));
}
