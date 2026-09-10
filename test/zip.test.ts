import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip, crc32, isSafeZipName, readZip } from '../src/zip.js';

/**
 * Issue #48 — the container a sync generation is handed over in.
 *
 * The point of these tests is that the file is a REAL zip (macOS Finder and
 * `unzip` must open it, because a user will double-click it) and that reading
 * one is fail-closed: a path that escapes, a truncated file, a wrong CRC or an
 * unknown compression method must throw, never return a partial payload.
 */
describe('minimal zip container (#48)', () => {
  const text = (value: string) => Buffer.from(value, 'utf8');

  it('round-trips stored and deflated entries', () => {
    const compressible = text('{"fact":"repeat"}\n'.repeat(400));
    const tiny = text('{}');
    const entries = readZip(createZip([
      { name: 'meta.json', data: tiny },
      { name: 'facts.jsonl', data: compressible },
    ]));
    expect([...entries.keys()]).toEqual(['meta.json', 'facts.jsonl']);
    expect(entries.get('meta.json')).toEqual(tiny);
    expect(entries.get('facts.jsonl')).toEqual(compressible);
    // Deflating a repetitive payload must actually pay for itself.
    expect(createZip([{ name: 'facts.jsonl', data: compressible }]).length).toBeLessThan(compressible.length / 2);
    // Byte-identical output for identical input: a generation's identity is its
    // manifest, not the moment it was zipped.
    expect(createZip([{ name: 'meta.json', data: tiny }]))
      .toEqual(createZip([{ name: 'meta.json', data: tiny }]));
  });

  it('is readable by the system unzip, and reads what the system zip writes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memex-zip-'));
    try {
      const ours = path.join(temp, 'ours.zip');
      fs.writeFileSync(ours, createZip([
        { name: 'meta.json', data: text('{"protocol_version":5}') },
        { name: 'facts.jsonl', data: text('{"id":"a"}\n') },
      ]));
      expect(execFileSync('unzip', ['-t', ours], { encoding: 'utf8' })).toContain('No errors detected');
      expect(execFileSync('unzip', ['-p', ours, 'meta.json'], { encoding: 'utf8' })).toBe('{"protocol_version":5}');

      // The other direction: a user may zip the generation directory in Finder,
      // which nests the files under the folder name.
      const source = path.join(temp, 'generation');
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'meta.json'), '{"protocol_version":5}');
      execFileSync('zip', ['-q', '-r', path.join(temp, 'theirs.zip'), 'generation'], { cwd: temp });
      const theirs = readZip(fs.readFileSync(path.join(temp, 'theirs.zip')));
      expect(theirs.get('generation/meta.json')?.toString('utf8')).toBe('{"protocol_version":5}');
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it('refuses names that would escape the extraction directory', () => {
    for (const name of ['../escape.json', '/etc/passwd', 'a/../../b', 'dir/', '', 'C:\\x', 'a\\b', 'a/\0b']) {
      expect(isSafeZipName(name)).toBe(false);
    }
    expect(isSafeZipName('meta.json')).toBe(true);
    expect(isSafeZipName('generation/meta.json')).toBe(true);
    expect(() => createZip([{ name: '../escape.json', data: text('x') }])).toThrow(/not writable/);
  });

  it('fails closed on a damaged container instead of returning a prefix', () => {
    const good = createZip([{ name: 'facts.jsonl', data: text('{"id":"a"}\n'.repeat(50)) }]);
    expect(() => readZip(text('not a zip at all'))).toThrow(/too short to contain a central directory/);
    expect(() => readZip(text('x'.repeat(500)))).toThrow(/central directory not found/);
    expect(() => readZip(good.subarray(0, good.length - 30))).toThrow(/central directory not found/);
    // A payload byte flipped after the CRC was pinned: either the inflate or the
    // CRC check must reject it — never "here is what we could read".
    const tampered = Buffer.from(good);
    // 30-byte local header + "facts.jsonl" = the compressed stream starts at 41.
    tampered[45] ^= 0xff;
    expect(() => readZip(tampered)).toThrow();
    // Caps are enforced, not advisory.
    expect(() => readZip(good, { maxEntries: 0 })).toThrow(/more than the 0 allowed/);
    expect(() => readZip(good, { maxTotalBytes: 10 })).toThrow(/expands to more than/);
  });

  it('computes the standard CRC-32', () => {
    // Known value for "123456789" (ISO-HDLC / zip CRC-32).
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});
