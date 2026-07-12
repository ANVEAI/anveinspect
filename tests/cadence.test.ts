import { describe, it, expect } from 'vitest';
import { parseExpect, lastExpectedFire, checkMissedWindow, checkTokenSpike } from '../packages/collector/src/cadence.js';
import type { Cadence } from '../packages/schema/src/types.js';

const cadence = (expect_: string, grace = 60, declared = true): Cadence => ({
  agentFingerprint: 'fp1',
  machineId: 'm1',
  expect: expect_,
  graceMinutes: grace,
  declared,
  origin: 'file',
  updatedAt: '2026-07-01T00:00:00Z',
});

// Local-time anchor: a Monday 10:00
const MON_10 = new Date(2026, 6, 13, 10, 0, 0); // 2026-07-13 is a Monday

describe('parseExpect', () => {
  it('parses all four grammars', () => {
    expect(parseExpect('daily 03:00').kind).toBe('daily');
    expect(parseExpect('weekdays 09:30').minute).toBe(30);
    expect(parseExpect('weekly mon 09:00').dow).toBe(1);
    expect(parseExpect('every 6h').intervalMs).toBe(6 * 3_600_000);
  });
  it('rejects garbage with the supported grammar in the message', () => {
    expect(() => parseExpect('sometimes')).toThrow(/Supported/);
    expect(() => parseExpect('daily 25:00')).toThrow(/hour/);
  });
});

describe('lastExpectedFire', () => {
  it('daily: today when time already passed, yesterday when not yet', () => {
    expect(lastExpectedFire(parseExpect('daily 03:00'), MON_10)!.getDate()).toBe(13);
    expect(lastExpectedFire(parseExpect('daily 22:00'), MON_10)!.getDate()).toBe(12);
  });
  it('weekdays: skips the weekend backwards', () => {
    // Monday 01:00, expecting weekdays 09:00 -> last fire was FRIDAY 09:00
    const mon1am = new Date(2026, 6, 13, 1, 0, 0);
    const fire = lastExpectedFire(parseExpect('weekdays 09:00'), mon1am)!;
    expect(fire.getDay()).toBe(5); // Friday
    expect(fire.getDate()).toBe(10);
  });
  it('weekly: lands on the declared day', () => {
    const fire = lastExpectedFire(parseExpect('weekly sun 08:00'), MON_10)!;
    expect(fire.getDay()).toBe(0);
    expect(fire.getDate()).toBe(12);
  });
});

describe('checkMissedWindow', () => {
  it('alerts when the window + grace passed with no run', () => {
    const alert = checkMissedWindow({
      cadence: cadence('daily 03:00', 60),
      agentDisplayName: 'nightly-bot',
      runStarts: ['2026-07-12T03:05:00'], // yesterday's run, not today's
      now: MON_10,
    });
    expect(alert).not.toBeNull();
    expect(alert!.kind).toBe('missed_window');
    expect(alert!.reason).toContain('nightly-bot');
    expect(alert!.reason).toContain('7h overdue');
  });
  it('stays quiet when a run landed inside the window', () => {
    const alert = checkMissedWindow({
      cadence: cadence('daily 03:00', 60),
      agentDisplayName: 'nightly-bot',
      runStarts: [new Date(2026, 6, 13, 3, 4).toISOString()],
      now: MON_10,
    });
    expect(alert).toBeNull();
  });
  it('stays quiet inside the grace period', () => {
    const alert = checkMissedWindow({
      cadence: cadence('daily 09:30', 60),
      agentDisplayName: 'x',
      runStarts: [],
      now: MON_10, // 10:00, grace ends 10:30
    });
    expect(alert).toBeNull();
  });
  it('NEVER pages on inferred (undeclared) cadences', () => {
    const alert = checkMissedWindow({
      cadence: cadence('daily 03:00', 60, false),
      agentDisplayName: 'x',
      runStarts: [],
      now: MON_10,
    });
    expect(alert).toBeNull();
  });
});

describe('checkTokenSpike', () => {
  const run = (daysAgo: number, tokens: number) => ({
    startedAt: new Date(MON_10.getTime() - daysAgo * 86_400_000).toISOString(),
    tokensByModel: { m: { input: tokens, output: 0, cacheCreation: 0, cacheRead: 0 } },
  });
  it('alerts at >3x trailing median with >=5 prior runs', () => {
    const alert = checkTokenSpike('fp1', 'm1', 'leady', [run(0, 500_000), run(1, 100_000), run(2, 90_000), run(3, 110_000), run(4, 100_000), run(5, 95_000)], MON_10);
    expect(alert).not.toBeNull();
    expect(alert!.kind).toBe('token_spike');
    expect(alert!.reason).toMatch(/5\.0x/);
  });
  it('quiet with insufficient history or normal usage', () => {
    expect(checkTokenSpike('fp1', 'm1', 'x', [run(0, 500_000), run(1, 100_000)], MON_10)).toBeNull();
    expect(checkTokenSpike('fp1', 'm1', 'x', [run(0, 120_000), run(1, 100_000), run(2, 90_000), run(3, 110_000), run(4, 100_000), run(5, 95_000)], MON_10)).toBeNull();
  });
  it('ignores tokens-unavailable runs instead of treating them as zero', () => {
    const runs = [run(0, 500_000), { startedAt: run(1, 0).startedAt, tokensByModel: null }, run(2, 100_000), run(3, 90_000), run(4, 110_000), run(5, 100_000), run(6, 95_000)];
    const alert = checkTokenSpike('fp1', 'm1', 'x', runs as any, MON_10);
    expect(alert).not.toBeNull(); // null run excluded from median, not counted as 0
  });
});
