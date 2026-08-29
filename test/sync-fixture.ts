import fs from 'fs';
import path from 'path';
import { getSyncDir } from '../src/sync-export.js';

export const SYNC_PAYLOAD_FILES = [
  'facts.jsonl',
  'fact-revisions.jsonl',
  'fact-tombstones.jsonl',
  'recall-events.jsonl',
  'ontology-domains.jsonl',
  'ontology-categories.jsonl',
  'ontology-relations.jsonl',
] as const;

export type SyncPayload = Partial<Record<(typeof SYNC_PAYLOAD_FILES)[number], string>>;

/**
 * Commit `payload` as one complete generation for `deviceId` — the only way
 * tests may deliver sync input since the root mirror / device-root reading
 * was removed (재감사 P1-1): importers read committed generations only.
 * Files absent from the payload are written empty, matching the exporter,
 * and the CURRENT manifest is flipped to the new generation atomically.
 */
export function craftCommittedGeneration(
  deviceId: string,
  payload: SyncPayload = {},
  opts: { generationId?: string } = {},
): { syncDir: string; deviceDir: string; genDir: string; generationId: string } {
  const syncDir = getSyncDir();
  const generationId =
    opts.generationId ?? `gen-${deviceId}-${Math.random().toString(36).slice(2, 10)}`;
  const deviceDir = path.join(syncDir, 'devices', deviceId);
  const genDir = path.join(deviceDir, 'generations', generationId);
  fs.mkdirSync(genDir, { recursive: true });
  for (const name of SYNC_PAYLOAD_FILES) {
    fs.writeFileSync(path.join(genDir, name), payload[name] ?? '');
  }
  fs.writeFileSync(
    path.join(deviceDir, 'CURRENT'),
    JSON.stringify({ generation: generationId, exported_at: '2026-08-30T00:00:00.000Z' }),
  );
  return { syncDir, deviceDir, genDir, generationId };
}

/** Parse the CURRENT manifest of a device directory. */
export function readCurrentGeneration(deviceDir: string): string {
  return (JSON.parse(
    fs.readFileSync(path.join(deviceDir, 'CURRENT'), 'utf-8'),
  ) as { generation: string }).generation;
}
