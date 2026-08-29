import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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

describe('lifecycle hooks contract (P2-4)', () => {
  it('SessionStart registers four independent async stages with no ordering', () => {
    const blocks = hooksFile().SessionStart;
    expect(blocks).toHaveLength(1);
    const entries = blocks[0].hooks;
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.type).toBe('command');
      // Every stage is async and self-contained — no barrier, no chaining.
      expect(entry.async).toBe(true);
      expect(entry.command).toMatch(/memex-hook-version-drift|memex sync --background|memex-hook-sync-import|memex-hook-maintenance/);
    }
  });

  it('SessionEnd remains the single synchronous extraction→export chain', () => {
    const entries = hooksFile().SessionEnd[0].hooks;
    expect(entries).toHaveLength(1);
    // The SessionEnd ordering (extraction then export) lives inside one
    // synchronous script, not in the host's hook list.
    expect(entries[0].async).toBeUndefined();
  });
});
