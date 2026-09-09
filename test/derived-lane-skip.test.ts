/**
 * Issue #43 — P0/P1 backlog must not starve the derived lanes silently.
 *
 * The SessionStart / UserPromptSubmit script used to `return` as soon as ANY
 * claimable capture_index / capsule_update job existed, skipping fact
 * consolidation, re-embed, ontology backfill AND extraction backfill at once,
 * with no log line, no telemetry sample and nothing in `memex status`. A
 * capsule job that fails deterministically is re-created at every new
 * checkpoint, so that skip could repeat forever.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  DERIVED_LANE_FORCE_AFTER,
  clearDerivedLaneSkips,
  describeDerivedLaneSkipReason,
  ensureDerivedLaneSkipTable,
  readDerivedLaneSkips,
  recordDerivedLaneSkip,
} from '../src/derived-lane-skip.js';

function db(): Database.Database {
  const handle = new Database(':memory:');
  ensureDerivedLaneSkipTable(handle);
  return handle;
}

describe('issue #43 — bounded, observable derived-lane skips', () => {
  it('lets the derived lanes through on the Nth consecutive skip', () => {
    const handle = db();
    try {
      expect(DERIVED_LANE_FORCE_AFTER).toBe(3);
      const first = recordDerivedLaneSkip(handle, 'continuity_backlog');
      expect(first).toMatchObject({ consecutive: 1, forced: false });
      expect(recordDerivedLaneSkip(handle, 'continuity_backlog')).toMatchObject({
        consecutive: 2,
        forced: false,
      });
      const third = recordDerivedLaneSkip(handle, 'continuity_backlog');
      expect(third.consecutive).toBe(3);
      expect(third.forced).toBe(true);

      // The counter resets on the forced pass, so priority still wins the next
      // two invocations — the release is periodic, not permanent.
      const after = readDerivedLaneSkips(handle)!;
      expect(after.consecutive).toBe(0);
      expect(after.lastForcedAt).toBeTruthy();
      expect(recordDerivedLaneSkip(handle, 'continuity_backlog').forced).toBe(false);
      expect(recordDerivedLaneSkip(handle, 'continuity_backlog').forced).toBe(false);
      expect(recordDerivedLaneSkip(handle, 'continuity_backlog').forced).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('counts every skip for status and names the reason', () => {
    const handle = db();
    try {
      for (let i = 0; i < 4; i++) recordDerivedLaneSkip(handle, 'continuity_backlog');
      const state = readDerivedLaneSkips(handle)!;
      expect(state.totalSkips).toBe(4);
      expect(state.reason).toBe('continuity_backlog');
      expect(describeDerivedLaneSkipReason(state.reason)).toBe('continuity backlog');
      expect(state.lastSkippedAt).toBeTruthy();
    } finally {
      handle.close();
    }
  });

  it('starts a new run of skips when the reason changes', () => {
    const handle = db();
    try {
      recordDerivedLaneSkip(handle, 'continuity_backlog');
      recordDerivedLaneSkip(handle, 'continuity_backlog');
      const other = recordDerivedLaneSkip(handle, 'other_backlog');
      expect(other.consecutive).toBe(1);
      expect(other.forced).toBe(false);
      expect(readDerivedLaneSkips(handle)!.reason).toBe('other_backlog');
    } finally {
      handle.close();
    }
  });

  it('clears the counter once the backlog drains', () => {
    const handle = db();
    try {
      recordDerivedLaneSkip(handle, 'continuity_backlog');
      recordDerivedLaneSkip(handle, 'continuity_backlog');
      clearDerivedLaneSkips(handle);
      const state = readDerivedLaneSkips(handle)!;
      expect(state.consecutive).toBe(0);
      expect(state.totalSkips).toBe(0);
      // The next skip after a drain starts a fresh run.
      expect(recordDerivedLaneSkip(handle, 'continuity_backlog').consecutive).toBe(1);
    } finally {
      handle.close();
    }
  });

  it('reports nothing on a database that never skipped', () => {
    const handle = new Database(':memory:');
    try {
      expect(readDerivedLaneSkips(handle)).toBeNull();
    } finally {
      handle.close();
    }
  });
});
