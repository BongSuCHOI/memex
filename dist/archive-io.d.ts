import fs from "fs";
import { Readable } from "stream";
/** Strip a trailing `.zst` so archive filenames compare in canonical form. */
export declare function canonicalArchiveName(fileName: string): string;
/**
 * Resolve the on-disk file for an archive path, trying both the plain and
 * `.zst`-compressed variants. When both exist the NEWER one wins (an active
 * session may have re-synced a plain copy after compression, or the
 * compressor may have refreshed the `.zst` after a stale plain copy).
 * Returns null when neither exists.
 */
export declare function resolveArchiveFile(filePath: string): string | null;
/** Whether an archive file exists in either plain or compressed form. */
export declare function archiveFileExists(filePath: string): boolean;
/**
 * 원자적 아카이브 복사 (CONVERSATION-LIFECYCLE.md:11 "Archived: atomic copy").
 * 직접 copyFileSync 를 쓰면 복사 도중 크래시가 잘린 아카이브를 남기고, mtime 이
 * 새로워져 "최신"으로 오인된다. 임시 파일 + 같은 파일시스템 rename 으로 방어한다.
 */
export declare function atomicCopyFileSync(sourcePath: string, archivePath: string): void;
/** Read an archive file as UTF-8, transparently decompressing `.zst`. */
export declare function readArchiveFile(filePath: string): string;
/**
 * Create a readable stream over an archive file, transparently decompressing
 * `.zst`. Suitable as input for readline.createInterface.
 */
export declare function createArchiveReadStream(filePath: string): Readable;
/** stat() the resolved archive file (plain or compressed), null if missing. */
export declare function statArchiveFile(filePath: string): fs.Stats | null;
