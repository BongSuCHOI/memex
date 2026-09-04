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
      expect(entries).toHaveLength(1);
      expect(entries[0].command).toContain('memex-hook-continuity');
      expect(entries[0].async).toBeUndefined();
    }
  });

  it('SessionEnd is a final fence, not the legacy extraction→export chain', () => {
    const entries = hooksFile().SessionEnd[0].hooks;
    expect(entries).toHaveLength(1);
    expect(entries[0].command).not.toContain('memex-hook-session-end');
  });
});
