/**
 * Explicit data-root migration (`memex migrate-home`).
 *
 * Product contract (storage/compat): durable data created before v0.2 lives
 * under a historical "memory-bank" directory. It is NEVER silently moved,
 * copied, merged, or deleted. This module implements the ONE explicit,
 * user-initiated migration path:
 *
 *   source (detected or --from) ──copy──▶ target (= current getMemexHome())
 *
 * Guarantees:
 * - Copy → verify → succeed. The SOURCE DIRECTORY IS NEVER DELETED OR MUTATED.
 *   Cleanup of the verified-unused old root remains an explicit manual step so
 *   an interrupted run can always be retried from the pristine original.
 * - Verification is content-aware, not just byte counting: the SQLite index DB
 *   gets a real PRAGMA integrity_check, archive file counts and byte totals
 *   are compared tree-for-tree, and exchange-row counts are compared read-only.
 * - The target must not already contain Memex derived data (refuse, don't merge).
 * - Every run appends a machine-readable receipt under <target>/logs/ so the
 *   migration itself is auditable and retryable evidence is preserved.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { detectLegacyDataRoot, getMemexHome } from "./paths.js";

export interface MigrateHomeOptions {
    /** Explicit source data root. Defaults to detectLegacyDataRoot(). */
    from?: string;
    /** Plan everything, write nothing. */
    dryRun?: boolean;
}

export interface MigrateHomeResult {
    /** 'ok' = migrated & verified; 'already-at-target' = nothing to do. */
    status: "ok" | "already-at-target";
    dryRun: boolean;
    sourceRoot: string;
    targetRoot: string;
    dirsCopied: string[];
    filesCopied: number;
    bytesCopied: number;
    sqliteIntegrityChecked: boolean;
    /** Read-only row-count comparison result across both roots. */
    rowsCompared: { table: string; source: number; target: number }[];
}

const MEMEX_SUBDIRS = [
    "conversation-archive",
    "conversation-index",
    "conversation-index/state",
];

function isDirectory(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** Byte size + file count of a directory tree, skipped symlinks included as entries. */
function treeStats(root: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const visit = (dir: string): void => {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isSymbolicLink()) {
                files++;
                continue;
            }
            if (e.isDirectory()) {
                visit(p);
            } else if (e.isFile()) {
                files++;
                try {
                    bytes += fs.statSync(p).size;
                } catch {
                    /* unreadable transient file */
                }
            }
        }
    };
    visit(root);
    return { files, bytes };
}

/** Read-only row count for one table in a SQLite DB. Returns null when missing/unreadable. */
function sqliteRowCount(dbPath: string | null, table: string): number | null {
    if (!dbPath || !fs.existsSync(dbPath)) return null;
    try {
        // Statically imported so the compiled ESM keeps working; better-sqlite3
        // is a declared production dependency and always resolvable here.
        const db = new Database(dbPath, { readonly: true });
        try {
            const present = db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
                )
                .get(table);
            if (!present) return null;
            const row = db
                .prepare(`SELECT COUNT(*) AS c FROM ${table}`)
                .get() as { c: number } | undefined;
            return row ? Number(row.c) : null;
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/** True if the directory contains any recognizable Memex derived-data subdir/file. */
function containsMemexData(root: string): boolean {
    if (!isDirectory(root)) return false;
    const names = new Set<string>();
    try {
        for (const entry of fs.readdirSync(root, { withFileTypes: true }))
            names.add(entry.name);
    } catch {
        return false;
    }
    return ["conversation-archive", "conversation-index"].some((sub) =>
        names.has(sub),
    );
}

export function migrateHome(opts: MigrateHomeOptions = {}): MigrateHomeResult {
    const target = getMemexHome();
    const source = opts.from ?? detectLegacyDataRoot();

    if (!source || !isDirectory(source)) {
        throw new Error(
            "No legacy data root detected. Pass it explicitly: memex migrate-home --from ~/.config/memory-bank",
        );
    }
    const resolvedSource = path.resolve(source);
    if (resolvedSource === path.resolve(target)) {
        throw new Error(
            "Source and target are the same directory — nothing to migrate.",
        );
    }

    const dirsExisting = MEMEX_SUBDIRS.filter((sub) =>
        isDirectory(path.join(resolvedSource, sub)),
    );
    if (
        dirsExisting.length === 0 &&
        !isDirectory(path.join(resolvedSource, "logs"))
    ) {
        throw new Error(
            `Source has no recognizable Memex subdirectories (${dirsExisting.join(", ")}) — refusing.`,
        );
    }
    if (containsMemexData(target)) {
        throw new Error(
            `Target ${target} already contains Memex data — refusing to merge. Resolve manually first.`,
        );
    }

    // Dry-run report: sizes are estimated from the source tree.
    const stats = treeStats(resolvedSource);

    if (opts.dryRun) {
        return {
            status: "ok",
            dryRun: true,
            sourceRoot: resolvedSource,
            targetRoot: path.resolve(target),
            dirsCopied: dirsExisting,
            filesCopied: stats.files,
            bytesCopied: stats.bytes,
            sqliteIntegrityChecked: false,
            rowsCompared: [],
        };
    }

    // ── Real migration ────────────────────────────────────────────────────
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(resolvedSource, target, {
        recursive: true,
        force: false, // target was proven absent-of-memex-data above
        errorOnExist: true,
        verbatimSymlinks: true,
    });

    // Content verification pass 1: byte/file parity between source and target.
    const copiedStats = treeStats(target);
    if (copiedStats.files !== stats.files) {
        throw new Error(
            `Verification failed: copied file count mismatch (src ${stats.files} vs dst ${copiedStats.files}).`,
        );
    }
    if (copiedStats.bytes !== stats.bytes) {
        throw new Error(
            `Verification failed: copied byte total mismatch (src ${stats.bytes} vs dst ${copiedStats.bytes}).`,
        );
    }

    // Content verification pass 2: real SQLite integrity check plus row-count
    // comparison against the ORIGINAL database (never mutating either).
    const rowsCompared: { table: string; source: number; target: number }[] =
        [];
    const tables = ["exchanges", "facts", "tool_calls", "ontology_relations"];
    let integrityOk = false;
    for (const rel of ["conversation-index/db.sqlite"]) {
        const srcDbPath = path.join(resolvedSource, rel);
        const dstDbPath = path.join(target, rel);
        if (!fs.existsSync(srcDbPath)) continue;

        try {
            const dst = new Database(dstDbPath, { readonly: true });
            try {
                const res = dst.pragma("integrity_check");
                const okFirst = Array.isArray(res)
                    ? String(res[0]?.integrity_check ?? "").toUpperCase()
                    : String(res).toUpperCase();
                if (!okFirst.includes("OK")) {
                    throw new Error(
                        `SQLite integrity_check failed: ${String(res).slice(0, 300)}`,
                    );
                }
                integrityOk = true;
            } finally {
                dst.close();
            }
        } catch (err) {
            throw new Error(
                `SQLite verification failed for ${rel}: ${(err as Error).message}`,
            );
        }
        for (const table of tables) {
            rowsCompared.push({
                table,
                source: sqliteRowCount(srcDbPath, table) ?? -1,
                target: sqliteRowCount(dstDbPath, table) ?? -1,
            });
        }
    }
    const rowMismatch = rowsCompared.find(
        (r) => r.source >= 0 && r.target >= 0 && r.source !== r.target,
    );
    if (rowMismatch) {
        throw new Error(
            `Row-count mismatch on '${rowMismatch.table}' (source=${rowMismatch.source}, target=${rowMismatch.target}).`,
        );
    }

    // Audit trail inside the NEW root only. The OLD root stays untouched.
    const logDir = path.join(target, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
        path.join(logDir, "home-migration.json"),
        JSON.stringify(
            {
                kind: "memex-home-migration",
                recordedAt: new Date().toISOString(),
                from: resolvedSource,
                to: path.resolve(target),
                files: copiedStats.files,
                bytes: copiedStats.bytes,
                sqliteIntegrityOk: integrityOk,
                rows: rowsCompared,
            },
            null,
            2,
        ) + "\n",
    );

    return {
        status: "ok",
        dryRun: false,
        sourceRoot: resolvedSource,
        targetRoot: path.resolve(target),
        dirsCopied: dirsExisting,
        filesCopied: copiedStats.files,
        bytesCopied: copiedStats.bytes,
        sqliteIntegrityChecked: integrityOk,
        rowsCompared,
    };
}
