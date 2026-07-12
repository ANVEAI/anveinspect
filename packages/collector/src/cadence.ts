import type { Alert, Cadence, Run } from '@anveinspect/schema';
import { randomUUID } from 'node:crypto';

/**
 * Cadence engine — the silent-failure wedge.
 *
 *   expect grammar (v1, declared-first per eng review):
 *     "daily HH:MM"            fires once per day at HH:MM local
 *     "weekdays HH:MM"         Mon-Fri at HH:MM
 *     "weekly DOW HH:MM"       e.g. "weekly mon 09:00"
 *     "every Nh"               rolling: within the last N hours + grace
 *
 *   missed-window rule: latest expected fire time F <= now, and
 *   no run started in [F, now], and now > F + grace  ->  missed_window alert.
 *   Declared cadences only ever page; inferred ones are suggestions (never page).
 */

const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export interface ParsedExpect {
  kind: 'daily' | 'weekdays' | 'weekly' | 'every';
  hour?: number;
  minute?: number;
  dow?: number;
  intervalMs?: number;
}

export function parseExpect(expect: string): ParsedExpect {
  const s = expect.trim().toLowerCase();
  let m = s.match(/^daily (\d{1,2}):(\d{2})$/);
  if (m) return { kind: 'daily', hour: clampHour(m[1]!), minute: clampMin(m[2]!) };
  m = s.match(/^weekdays (\d{1,2}):(\d{2})$/);
  if (m) return { kind: 'weekdays', hour: clampHour(m[1]!), minute: clampMin(m[2]!) };
  m = s.match(/^weekly (sun|mon|tue|wed|thu|fri|sat) (\d{1,2}):(\d{2})$/);
  if (m) return { kind: 'weekly', dow: DOW.indexOf(m[1]!), hour: clampHour(m[2]!), minute: clampMin(m[3]!) };
  m = s.match(/^every (\d+)h$/);
  if (m) return { kind: 'every', intervalMs: Number(m[1]) * 3_600_000 };
  throw new Error(
    `Unparseable cadence "${expect}". Supported: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "every Nh".`,
  );
}

function clampHour(v: string): number {
  const n = Number(v);
  if (n < 0 || n > 23) throw new Error(`hour out of range: ${v}`);
  return n;
}
function clampMin(v: string): number {
  const n = Number(v);
  if (n < 0 || n > 59) throw new Error(`minute out of range: ${v}`);
  return n;
}

/** Most recent expected fire time at or before `now` (local time), or null if none applies yet. */
export function lastExpectedFire(parsed: ParsedExpect, now: Date): Date | null {
  if (parsed.kind === 'every') return new Date(now.getTime() - parsed.intervalMs!);
  const candidate = new Date(now);
  candidate.setHours(parsed.hour!, parsed.minute!, 0, 0);
  const stepBack = (d: Date, days: number) => new Date(d.getTime() - days * 86_400_000);
  if (parsed.kind === 'daily') {
    return candidate > now ? stepBack(candidate, 1) : candidate;
  }
  if (parsed.kind === 'weekdays') {
    let c = candidate > now ? stepBack(candidate, 1) : candidate;
    while (c.getDay() === 0 || c.getDay() === 6) c = stepBack(c, 1);
    return c;
  }
  // weekly
  let c = candidate;
  while (c.getDay() !== parsed.dow! || c > now) c = stepBack(c, 1);
  return c;
}

export interface CheckInput {
  cadence: Cadence;
  agentDisplayName: string;
  /** run start times (ISO) for this (agent, machine), most recent first */
  runStarts: string[];
  now: Date;
}

/** Returns a missed_window alert or null. Pure — trivially testable. */
export function checkMissedWindow(input: CheckInput): Alert | null {
  const { cadence, runStarts, now } = input;
  if (!cadence.declared) return null; // inferred = suggestion only, never pages
  const parsed = parseExpect(cadence.expect);
  const expected = lastExpectedFire(parsed, now);
  if (!expected) return null;
  const graceEnd = expected.getTime() + cadence.graceMinutes * 60_000;
  if (now.getTime() <= graceEnd) return null; // still within grace
  const ranInWindow = runStarts.some((iso) => {
    const t = Date.parse(iso);
    return t >= expected.getTime() && t <= now.getTime();
  });
  if (ranInWindow) return null;
  const overdueMin = Math.round((now.getTime() - expected.getTime()) / 60_000);
  const overdue = overdueMin >= 120 ? `${Math.round(overdueMin / 60)}h` : `${overdueMin}m`;
  return {
    id: randomUUID(),
    kind: 'missed_window',
    agentFingerprint: cadence.agentFingerprint,
    machineId: cadence.machineId,
    reason: `${input.agentDisplayName} missed ${cadence.expect} window — ${overdue} overdue`,
    // one alert per expected-fire window: acking never re-fires it; a NEW missed
    // window (different expected time) produces a new key and does fire
    dedupKey: `missed_window:${cadence.agentFingerprint}:${expected.toISOString()}`,
    createdAt: now.toISOString(),
    ackedAt: null,
    snoozedUntil: null,
  };
}

/** Token spike: latest run > 3x trailing median (min 5 prior runs with token data). */
export function checkTokenSpike(
  agentFingerprint: string,
  machineId: string,
  agentDisplayName: string,
  runs: Pick<Run, 'startedAt' | 'tokensByModel'>[],
  now: Date,
): Alert | null {
  const withTokens = runs
    .filter((r) => r.tokensByModel !== null)
    .map((r) => ({
      startedAt: r.startedAt,
      total: Object.values(r.tokensByModel!).reduce((s, t) => s + t.input + t.output, 0),
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  if (withTokens.length < 6) return null;
  const latest = withTokens[0]!;
  const trailing = withTokens.slice(1).map((r) => r.total).sort((a, b) => a - b);
  const median = trailing[Math.floor(trailing.length / 2)]!;
  if (median <= 0 || latest.total <= median * 3) return null;
  return {
    id: randomUUID(),
    kind: 'token_spike',
    agentFingerprint,
    machineId,
    reason: `${agentDisplayName} token spike — ${(latest.total / median).toFixed(1)}x trailing median (${fmtTokens(latest.total)} vs ${fmtTokens(median)})`,
    // keyed to the triggering run: a genuinely new spiking run re-fires; the
    // same run never re-fires, even after ack
    dedupKey: `token_spike:${agentFingerprint}:${latest.startedAt}`,
    createdAt: now.toISOString(),
    ackedAt: null,
    snoozedUntil: null,
  };
}

function fmtTokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}
