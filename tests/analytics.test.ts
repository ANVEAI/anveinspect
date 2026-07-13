import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { costOf, DEFAULT_RATES } from '../packages/collector/src/pricing.js';
import { FleetStore } from '../packages/collector/src/store.js';
import { computeAnalytics } from '../packages/collector/src/analytics.js';

describe('costOf', () => {
  it('prices known models by input/output/cache rates', () => {
    const r = costOf({ 'claude-sonnet-5': { input: 1_000_000, output: 1_000_000, cacheCreation: 0, cacheRead: 0 } }, DEFAULT_RATES);
    expect(r.priced).toBe(true);
    expect(r.usd).toBeCloseTo(3 + 15, 4); // $3 input + $15 output per 1M
  });
  it('prices cache-read and cache-creation tokens by their own rates (golden)', () => {
    // sonnet: input 3, output 15, cacheRead 0.3, cacheWrite 3.75 per MTok
    const r = costOf({ 'claude-sonnet-5': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 1e6 } }, DEFAULT_RATES);
    expect(r.usd).toBeCloseTo(3 + 15 + 0.3 + 3.75, 4); // 22.05 — every token class counted
  });
  it('falls back to input×0.1 (cache read) and input×1.25 (cache write) when a rate omits them', () => {
    // a custom rate with no cache fields -> the documented fallbacks apply
    const r = costOf(
      { m: { input: 0, output: 0, cacheRead: 1e6, cacheCreation: 1e6 } },
      { m: { input: 10, output: 20 } },
    );
    expect(r.usd).toBeCloseTo(10 * 0.1 + 10 * 1.25, 4); // 13.5
  });
  it('unknown model contributes 0 and is flagged unpriced (never a fake number)', () => {
    const r = costOf({ 'some-future-model': { input: 1e6, output: 1e6, cacheCreation: 0, cacheRead: 0 } }, DEFAULT_RATES);
    expect(r.priced).toBe(false);
    expect(r.usd).toBe(0);
    expect(r.partial).toBe(false); // all unknown -> not partial, just unpriced
  });
  it('mixed known + unknown models: priced but flagged partial (usd is an undercount)', () => {
    const r = costOf(
      {
        'claude-sonnet-5': { input: 1e6, output: 1e6, cacheCreation: 0, cacheRead: 0 },
        'some-future-model': { input: 1e6, output: 1e6, cacheCreation: 0, cacheRead: 0 },
      },
      DEFAULT_RATES,
    );
    expect(r.priced).toBe(true);
    expect(r.partial).toBe(true); // the unknown model's cost was dropped — not silently
    expect(r.usd).toBeCloseTo(3 + 15, 4); // only the sonnet portion is counted
  });
  it('null tokens -> unpriced, zero', () => {
    expect(costOf(null, DEFAULT_RATES)).toEqual({ usd: 0, priced: false, partial: false });
  });
});

describe('computeAnalytics', () => {
  function seed() {
    const path = join(mkdtempSync(join(tmpdir(), 'an-')), 'fleet.db');
    const s = new FleetStore(path);
    s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
    s.db.prepare(`INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at) VALUES ('fp','claude_code','p','basename','p','interactive','pricey',1.0,'2026-07-13T00:00:00Z')`).run();
    const now = new Date();
    const recent = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    const tok = (i: number, o: number) => JSON.stringify({ 'claude-opus-4-8': { input: i, output: o, cacheCreation: 0, cacheRead: 0 } });
    const addRun = s.db.prepare(`INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,status,tokens_by_model,tool_call_counts,models) VALUES (?,?,'m1',?,?,?,'{}','[]')`);
    addRun.run('r1', 'fp', recent(1), 'completed', tok(1_000_000, 1_000_000)); // $15 + $75 = $90
    addRun.run('r2', 'fp', recent(2), 'completed', null); // tokenless
    addRun.run('r3', 'fp', recent(3), 'completed', tok(0, 0)); // priced, $0
    return s;
  }
  it('sums estimated cost with honest coverage counters', () => {
    const s = seed();
    const a = computeAnalytics(s.db);
    s.close();
    expect(a.estimatedCostUsd).toBeCloseTo(90, 2); // opus 1M in + 1M out
    expect(a.pricedRuns).toBe(2);      // r1 + r3
    expect(a.tokenlessRuns).toBe(1);   // r2
    expect(a.costByModel[0]!.model).toBe('claude-opus-4-8');
    expect(a.topCostAgents[0]!.name).toBe('pricey');
    expect(a.busiestHours).toHaveLength(24);
  });
});
