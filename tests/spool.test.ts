import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { consumeSpool } from '../packages/collector/src/claude-scanner.js';

function spoolFile(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-'));
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const nowIso = () => new Date().toISOString();

describe('consumeSpool', () => {
  it('maps sessionId -> trigger, most-specific wins', () => {
    const path = spoolFile([
      { sessionId: 's1', trigger: 'interactive', ts: nowIso() },
      { sessionId: 's1', trigger: 'scheduled', ts: nowIso() }, // cron beats interactive
      { sessionId: 's2', trigger: 'ci', ts: nowIso() },
    ]);
    const map = consumeSpool(path);
    expect(map.get('s1')).toBe('scheduled');
    expect(map.get('s2')).toBe('ci');
  });

  it('prunes events older than 14 days but keeps recent ones', () => {
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const path = spoolFile([
      { sessionId: 'old', trigger: 'scheduled', ts: old },
      { sessionId: 'new', trigger: 'scheduled', ts: nowIso() },
    ]);
    consumeSpool(path);
    const remaining = readFileSync(path, 'utf8');
    expect(remaining).toContain('"new"');
    expect(remaining).not.toContain('"old"');
  });

  it('missing spool and corrupt lines never throw', () => {
    expect(consumeSpool('/nonexistent/spool.jsonl').size).toBe(0);
    const path = spoolFile([{ sessionId: 's1', trigger: 'ci', ts: nowIso() }]);
    writeFileSync(path, '{bad json\n' + readFileSync(path, 'utf8'));
    const map = consumeSpool(path);
    expect(map.get('s1')).toBe('ci'); // valid line still parsed
  });
});
