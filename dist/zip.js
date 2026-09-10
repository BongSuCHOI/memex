/**
 * Issue #48 — the minimum ZIP container Memex needs to hand one sync generation
 * to a second Mac by hand.
 *
 * Why it is here and not a dependency: a `.zip` is what macOS Finder, Mail and
 * AirDrop all understand without asking the user to install anything, and Node
 * already ships the only hard part (`deflateRaw`). Adding a packaging library
 * for ~150 lines of well-specified record layout would widen the supply chain
 * of a local-first tool for nothing.
 *
 * Deliberately narrow: stored (0) and deflated (8) entries, no encryption, no
 * ZIP64, no directory entries, no data descriptors. A generation is four JSONL
 * files plus `meta.json`, so the 4 GiB / 65,535-entry ZIP32 limits are
 * unreachable. Anything outside that shape is rejected with a reason rather
 * than guessed at — the reader is pointed at a file a user typed the path of.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
const VERSION_DEFLATE = 20;
/** Fixed MS-DOS timestamp (1980-01-01 00:00) so the same payload zips to the
 * same bytes — a generation's identity is its manifest, not its mtime. */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;
const MAX_ENTRY_NAME = 255;
const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c;
    }
    return table;
})();
export function crc32(buffer) {
    let crc = -1;
    for (let i = 0; i < buffer.length; i++)
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}
/**
 * Reject a name that would escape the extraction directory or name a
 * directory. The caller still decides which names it accepts; this is the
 * container-level floor (zip-slip).
 */
export function isSafeZipName(name) {
    if (!name || name.length > MAX_ENTRY_NAME)
        return false;
    if (name.includes("\0") || name.includes("\\"))
        return false;
    if (name.startsWith("/") || name.endsWith("/") || /^[A-Za-z]:/.test(name))
        return false;
    return !name.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
export function createZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const entry of entries) {
        if (!isSafeZipName(entry.name))
            throw new Error(`zip entry name is not writable: ${entry.name}`);
        const name = Buffer.from(entry.name, "utf8");
        const deflated = deflateRawSync(entry.data, { level: 9 });
        // Storing beats deflating when compression grows the payload (tiny files).
        const stored = deflated.length >= entry.data.length;
        const body = stored ? entry.data : deflated;
        const crc = crc32(entry.data);
        const local = Buffer.alloc(LOCAL_HEADER_BYTES);
        local.writeUInt32LE(LOCAL_SIGNATURE, 0);
        local.writeUInt16LE(VERSION_DEFLATE, 4);
        local.writeUInt16LE(0, 6); // flags: no encryption, no data descriptor
        local.writeUInt16LE(stored ? 0 : 8, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(entry.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        locals.push(local, name, body);
        const central = Buffer.alloc(CENTRAL_HEADER_BYTES);
        central.writeUInt32LE(CENTRAL_SIGNATURE, 0);
        central.writeUInt16LE(VERSION_DEFLATE, 4);
        central.writeUInt16LE(VERSION_DEFLATE, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(stored ? 0 : 8, 10);
        central.writeUInt16LE(DOS_TIME, 12);
        central.writeUInt16LE(DOS_DATE, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(entry.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt16LE(0, 30); // extra
        central.writeUInt16LE(0, 32); // comment
        central.writeUInt16LE(0, 34); // disk number
        central.writeUInt16LE(0, 36); // internal attributes
        central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // unix mode 0644 (regular file)
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + body.length;
    }
    const centralBytes = centrals.reduce((sum, part) => sum + part.length, 0);
    const eocd = Buffer.alloc(EOCD_BYTES);
    eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBytes, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, ...centrals, eocd]);
}
function findEndOfCentralDirectory(buffer) {
    // The EOCD sits last, followed only by an optional comment (<= 65,535 bytes).
    const limit = Math.max(0, buffer.length - (EOCD_BYTES + 0xffff));
    for (let i = buffer.length - EOCD_BYTES; i >= limit; i--) {
        if (buffer.readUInt32LE(i) === EOCD_SIGNATURE)
            return i;
    }
    return -1;
}
/**
 * Read every entry into memory, verifying each CRC-32 and declared length.
 * Returns name → bytes; a container whose records do not agree throws.
 */
export function readZip(buffer, limits = {}) {
    const maxEntries = limits.maxEntries ?? 64;
    const maxTotalBytes = limits.maxTotalBytes ?? 256 * 1024 * 1024;
    if (buffer.length < EOCD_BYTES)
        throw new Error("zip is too short to contain a central directory");
    const eocd = findEndOfCentralDirectory(buffer);
    if (eocd < 0)
        throw new Error("zip central directory not found (not a zip container?)");
    const count = buffer.readUInt16LE(eocd + 10);
    const centralSize = buffer.readUInt32LE(eocd + 12);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    if (count > maxEntries)
        throw new Error(`zip carries ${count} entries, more than the ${maxEntries} allowed`);
    if (centralOffset + centralSize > buffer.length)
        throw new Error("zip central directory is out of bounds");
    const files = new Map();
    let cursor = centralOffset;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (cursor + CENTRAL_HEADER_BYTES > buffer.length)
            throw new Error("zip central directory ends early");
        if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE)
            throw new Error("zip central directory record is malformed");
        const method = buffer.readUInt16LE(cursor + 10);
        const crc = buffer.readUInt32LE(cursor + 16);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLength = buffer.readUInt16LE(cursor + 28);
        const extraLength = buffer.readUInt16LE(cursor + 30);
        const commentLength = buffer.readUInt16LE(cursor + 32);
        const localOffset = buffer.readUInt32LE(cursor + 42);
        const name = buffer.toString("utf8", cursor + CENTRAL_HEADER_BYTES, cursor + CENTRAL_HEADER_BYTES + nameLength);
        cursor += CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
        if (name.endsWith("/"))
            continue; // directory marker: nothing to read
        if (!isSafeZipName(name))
            throw new Error(`zip entry name is not readable: ${JSON.stringify(name)}`);
        total += uncompressedSize;
        if (total > maxTotalBytes)
            throw new Error(`zip expands to more than the ${maxTotalBytes} bytes allowed`);
        if (localOffset + LOCAL_HEADER_BYTES > buffer.length)
            throw new Error(`zip entry ${name} points outside the file`);
        if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE)
            throw new Error(`zip entry ${name} has no local header`);
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + LOCAL_HEADER_BYTES + localNameLength + localExtraLength;
        if (start + compressedSize > buffer.length)
            throw new Error(`zip entry ${name} is truncated`);
        const body = buffer.subarray(start, start + compressedSize);
        let data;
        if (method === 0)
            data = Buffer.from(body);
        else if (method === 8)
            data = inflateRawSync(body, { maxOutputLength: maxTotalBytes });
        else
            throw new Error(`unsupported zip compression method ${method} for entry ${name}`);
        if (data.length !== uncompressedSize)
            throw new Error(`zip entry ${name} does not match its declared size`);
        if (crc32(data) !== crc)
            throw new Error(`zip entry ${name} fails its CRC-32 check`);
        files.set(name, data);
    }
    return files;
}
