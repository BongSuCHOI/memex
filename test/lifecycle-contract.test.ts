import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LIFECYCLE_COMMANDS, type HookEvent } from '../src/lifecycle.js';
import {
  HOOK_EXIT_MARGIN_MS,
  hookBudgetMs,
  hookHostTimeoutMs,
} from '../src/hook-budget.js';

/**
 * 재감사 P2-4 — SessionStart 네 명령은 hooks.json에서 서로 독립적인 async 항목이며,
 * 이 문서(eventual-consistency 계약)와 manifest가 다시 어긋나지 않게 표면을 고정한다.
 * 순서 보장은 의도적으로 없다: 실제 데이터 의존도 없고(sync는 export하지 않음,
 * import는 peer snapshot을 읽음), 동시 실행 간 파일 일관성은 P2-5 generation
 * snapshot이 보장한다.
 */

interface HookEntry {
  type: string;
  command: string;
  async?: boolean;
}

function hooksFile(): Record<string, { matcher: string; hooks: HookEntry[] }[]> {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'hooks.json'), 'utf-8')).hooks;
}

describe('Continuity lifecycle hooks contract', () => {
  it('SessionStart separates synchronous continuity from startup/resume maintenance', () => {
    const blocks = hooksFile().SessionStart;
    expect(blocks).toHaveLength(2);
    const continuity = blocks.find((block) => block.matcher === 'startup|resume|clear|compact')!;
    expect(continuity.hooks).toHaveLength(1);
    expect(continuity.hooks[0].command).toContain('memex-hook-continuity');
    expect(continuity.hooks[0].async).toBeUndefined();
    const maintenance = blocks.find((block) => block.matcher === 'startup|resume')!;
    expect(maintenance.hooks).toHaveLength(4);
    for (const entry of maintenance.hooks) {
      expect(entry.type).toBe('command');
      expect(entry.async).toBe(true);
      expect(entry.command).toMatch(/memex-hook-version-drift|memex sync --background|memex-hook-sync-import|memex-hook-maintenance/);
    }
  });

  it('capture events use one bounded synchronous local-only gateway', () => {
    for (const event of ['Stop', 'Interrupt', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      const entries = hooksFile()[event][0].hooks;
      // The capture gateway is always the FIRST entry and always synchronous.
      // Only SessionEnd carries a second one — the cross-device export (#35),
      // a timed synchronous entry since 0.6.8 (#110): Codex runs SessionEnd
      // hooks synchronously anyway and warned when the entry said `async`.
      expect(entries[0].command).toContain('memex-hook-continuity');
      expect(entries[0].async).toBeUndefined();
      const extra = entries.slice(1);
      if (event === 'SessionEnd') {
        expect(extra).toHaveLength(1);
        expect(extra[0].command).toContain('memex-hook-sync-export');
        expect(extra[0].async).toBeUndefined();
        expect(extra[0].timeout).toBe(3);
      } else {
        expect(extra).toHaveLength(0);
      }
    }
  });

  it('SessionEnd is a final fence plus a timed export, not the legacy extraction→export chain', () => {
    const entries = hooksFile().SessionEnd[0].hooks;
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(entry.command).not.toContain('memex-hook-session-end');
    // The legacy chain ran extraction/consolidation/export in the foreground.
    // The export is a separate timed entry gated on the sync switch (#110).
    expect(entries[1].async).toBeUndefined();
    expect(entries[1].timeout).toBe(3);
  });

  /**
   * Issue #166 — the work Mac skipped 3/3 captures with `db_wait_ms: 0`: the
   * fixed cost before the first database call (node start, dist import, DB open
   * with its migration pass, marker fsync) is 1.45-1.9 s there, and a 2,000 ms
   * budget derived from a 3 s host timeout was gone before the capture phase.
   * Codex allows a larger timeout for these events, so the manifest asks for one
   * and the budget is derived from it — the numbers may not drift apart again.
   */
  it('host timeouts are the raised limits, and the doctor table and budget agree (#166)', () => {
    const expected: Record<string, number> = {
      SessionStart: 10, Stop: 10, Interrupt: 10, PostCompact: 10, PreCompact: 15,
      // Codex clamps SessionEnd to 3 s and warns above it (#110/#112).
      SessionEnd: 3,
    };
    for (const [event, seconds] of Object.entries(expected)) {
      const manifest = hooksFile()[event][0].hooks[0];
      expect(manifest.command).toContain('memex-hook-continuity');
      expect(manifest.timeout).toBe(seconds);
      // `memex doctor` diagnoses against its own table; it has to say the same.
      const registered = LIFECYCLE_COMMANDS[event as HookEvent]
        .find((command) => command.script === 'scripts/continuity-hook.js');
      expect(registered?.timeout).toBe(seconds);
      // And the budget is that timeout minus ONE fixed exit margin.
      expect(hookHostTimeoutMs(event)).toBe(seconds * 1_000);
      expect(hookBudgetMs(event)).toBe(seconds * 1_000 - HOOK_EXIT_MARGIN_MS);
    }
    // The export entry travels with SessionEnd's clamp, unchanged.
    expect(hooksFile().SessionEnd[0].hooks[1].timeout).toBe(3);
  });
});
