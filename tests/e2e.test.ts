import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

/**
 * End-to-end: drive the real CLI as a scheduled operator would, against an
 * isolated database seeded with a realistic Claude Code project layout.
 * This exercises scan -> declare -> check -> status -> ack -> report through
 * the actual process boundary (not just imported functions).
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'packages', 'collector', 'src', 'cli.ts');

let env: NodeJS.ProcessEnv;
let projectsRoot: string;
let dbPath: string;

function cli(args: string[]): any {
  const raw = execFileSync('npx', ['tsx', CLI, ...args, '--json'], { env, encoding: 'utf8' });
  return JSON.parse(raw);
}
function cliText(args: string[]): string {
  return execFileSync('npx', ['tsx', CLI, ...args], { env, encoding: 'utf8' });
}

beforeAll(() => {
  const tmp = mkdtempSync(join(tmpdir(), 'anveinspect-e2e-'));
  dbPath = join(tmp, 'fleet.db');
  projectsRoot = join(tmp, 'claude', 'projects');

  // Build a realistic project: a "nightly" session whose last run was >1 day ago,
  // so a declared "daily 03:00" cadence will register as missed.
  const proj = join(projectsRoot, '-Users-x-nightly');
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const older = new Date(Date.now() - 2 * 86_400_000);
  const lines = [
    { type: 'user', sessionId, timestamp: older.toISOString(), cwd: '/Users/x/nightly', gitBranch: 'main', version: '2.1.200', message: { role: 'user', content: [{ type: 'text', text: 'x' }] } },
    { type: 'assistant', sessionId, timestamp: new Date(older.getTime() + 5000).toISOString(), requestId: 'req1', message: { id: 'msg1', model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
  ];
  require('node:fs').mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  env = {
    ...process.env,
    ANVEINSPECT_DB: dbPath,
    HOME: tmp, // isolates ~/.anveinspect and the scanner's ~/.claude/projects lookup
  };
  // The scanner reads ~/.claude/projects; point HOME's .claude at our fixtures
  require('node:fs').mkdirSync(join(tmp, '.claude'), { recursive: true });
  require('node:fs').symlinkSync(join(tmp, 'claude', 'projects'), join(tmp, '.claude', 'projects'));
});

describe('e2e: operator lifecycle through the CLI', () => {
  it('scan ingests the seeded fleet', () => {
    const r = cli(['scan']);
    expect(r.agents).toBeGreaterThanOrEqual(1);
    expect(r.runs).toBeGreaterThanOrEqual(1);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('declaring a daily cadence on the stale agent then checking produces a missed-window alert', () => {
    cli(['cadence', 'declare', 'nightly', 'daily 03:00', '--grace', '60']);
    const check = cli(['check']);
    const missed = check.openAlerts.find((a: any) => a.kind === 'missed_window');
    expect(missed).toBeDefined();
    expect(missed.reason).toContain('nightly');
  });

  it('status reflects the open alert', () => {
    const s = cli(['status']);
    expect(s.pulse.openAlerts).toBeGreaterThanOrEqual(1);
  });

  it('ack closes the alert and it disappears from status', () => {
    const before = cli(['status']);
    const alertId = before.openAlerts[0].id;
    const acked = cli(['ack', alertId]);
    expect(acked.acked).toBe(true);
    const after = cli(['status']);
    expect(after.openAlerts.find((a: any) => a.id === alertId)).toBeUndefined();
  });

  it('re-check does NOT re-fire an acked alert within the same window (dedup holds)', () => {
    const recheck = cli(['check']);
    expect(recheck.openAlerts.find((a: any) => a.kind === 'missed_window')).toBeUndefined();
  });

  it('report renders a self-describing markdown bundle with real numbers', () => {
    const text = cliText(['report']);
    expect(text).toContain('# AnveInspect fleet report');
    expect(text).toContain('nightly');
    expect(text).not.toMatch(/\$\d/);
  });

  it('unknown command exits non-zero with an actionable message', () => {
    let threw = false;
    try {
      execFileSync('npx', ['tsx', CLI, 'bogus'], { env, encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) {
      threw = true;
      expect(String(e.stderr)).toContain('unknown command');
    }
    expect(threw).toBe(true);
  });
});
