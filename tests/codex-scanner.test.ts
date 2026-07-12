import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanCodexSessions } from '../packages/collector/src/codex-scanner.js';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'codex-'));
  const day = join(root, '2026', '07', '13');
  mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: '2026-07-13T02:00:00.000Z', type: 'session_meta', payload: { session_id: 'sess-1', cwd: '/Users/x/myproj', cli_version: '1.2.3', source: 'exec' } },
    { timestamp: '2026-07-13T02:00:01.000Z', type: 'turn_started', payload: { type: 'turn_started', turn_id: 't1' } },
    { timestamp: '2026-07-13T02:00:09.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
  ];
  writeFileSync(join(day, 'rollout-2026-07-13T02-00-00-sess-1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  // corrupt file: must be skipped, never fatal
  writeFileSync(join(day, 'rollout-corrupt.jsonl'), '{not json\n');
  return root;
}

describe('scanCodexSessions', () => {
  it('parses session_meta into an agent + run with honest unavailable tokens', () => {
    const r = scanCodexSessions(fixture());
    expect(r.filesScanned).toBe(2);
    expect(r.runs).toHaveLength(1);
    const run = r.runs[0]!;
    expect(run.id).toBe('codex:sess-1');
    expect(run.startedAt).toBe('2026-07-13T02:00:00.000Z');
    expect(run.endedAt).toBe('2026-07-13T02:00:09.000Z');
    expect(run.tokensByModel).toBeNull(); // unavailable, never zero
    expect(run.clientVersion).toBe('1.2.3');
    expect(r.agents[0]!.vendor).toBe('codex');
    expect(r.agents[0]!.displayName).toBe('myproj');
  });

  it('missing root returns empty, never throws', () => {
    const r = scanCodexSessions('/nonexistent/codex');
    expect(r.runs).toEqual([]);
  });
});
