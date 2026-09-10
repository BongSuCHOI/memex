export interface ZipEntry {
    name: string;
    data: Buffer;
}
export interface ZipReadLimits {
    /** Entries the container may carry before it is refused. */
    maxEntries?: number;
    /** Total decompressed bytes allowed (guards a high-ratio archive). */
    maxTotalBytes?: number;
}
export declare function crc32(buffer: Buffer): number;
/**
 * Reject a name that would escape the extraction directory or name a
 * directory. The caller still decides which names it accepts; this is the
 * container-level floor (zip-slip).
 */
export declare function isSafeZipName(name: string): boolean;
export declare function createZip(entries: ZipEntry[]): Buffer;
/**
 * Read every entry into memory, verifying each CRC-32 and declared length.
 * Returns name → bytes; a container whose records do not agree throws.
 */
export declare function readZip(buffer: Buffer, limits?: ZipReadLimits): Map<string, Buffer>;
