import fs from 'fs';
import path from 'path';
import { getSyncDir, SYNC_PAYLOAD_FILE_NAMES, countPayloadRows, payloadSha256 } from '../src/sync-export.js';

export const SYNC_PAYLOAD_FILES = [
  'facts.jsonl',
  'fact-revisions.jsonl',
  'fact-tombstones.jsonl',
  'recall-events.jsonl',
] as const;

export type SyncPayload = Partial<Record<(typeof SYNC_PAYLOAD_FILES)[number], string>>;

const DEFAULT_FACT_AT = '2026-08-01T00:00:00.000Z';

/** One protocol-v4 fact row with every required field filled (strict row
 * validation rejects rows missing semantic_updated_at/lifecycle_updated_at/
 * is_active). Override anything per test. */
export function factRow(
  overrides: { id: string; fact: string } & Partial<Record<string, unknown>>,
): string {
  return JSON.stringify({
    category: 'knowledge',
    scope_type: 'global',
    scope_project: null,
    source_exchange_ids: '[]',
    created_at: DEFAULT_FACT_AT,
    updated_at: DEFAULT_FACT_AT,
    semantic_updated_at: DEFAULT_FACT_AT,
    lifecycle_updated_at: DEFAULT_FACT_AT,
    consolidated_count: 1,
    is_active: 1,
    ...overrides,
  });
}

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
  // integrity manifest — importer fail-closed 검증 대상(P1-4 보강)
  fs.writeFileSync(
    path.join(genDir, 'meta.json'),
    JSON.stringify(
      {
        protocol_version: 4,
        generation: generationId,
        device_id: deviceId,
        exported_at: '2026-08-30T00:00:00.000Z',
        files: Object.fromEntries(
          SYNC_PAYLOAD_FILE_NAMES.map((name) => [
            name,
            { rows: countPayloadRows(payload[name] ?? ''), sha256: payloadSha256(payload[name] ?? '') },
          ]),
        ),
      },
      null,
      2,
    ),
  );
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
