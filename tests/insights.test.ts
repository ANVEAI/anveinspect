import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetStore } from '../packages/collector/src/store.js';
import { computeInsights } from '../packages/collector/src/insights.js';
import { buildReport } from '../packages/collector/src/report.js';

const NOW = new Date('2026-07-13T12:00:00Z');
const DAY = 86_400_000;

function seed(): { store: FleetStore; path: string } {
  const path = join(mkdtempSync(join(tmpdir(), 'insights-')), 'fleet.db');
  const store = new FleetStore(path);
  store.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
  const addAgent = store.db.prepare(
    `INSERT INTO agents (fingerprint, vendor, project_identity, project_identity_source, agent_name,
       trigger_source, display_name, identity_confidence, first_seen_at, source)
     VALUES (?, 'claude_code', ?, ?, ?, ?, ?, 1.0, '2026-06-01T00:00:00Z', 'local_collector')`,
  );
  addAgent.run('fp-cron', 'github.com/x/cron', 'git_remote', 'nightly', 'scheduled', 'nightly-bot');
  addAgent.run('fp-dev', 'devproj', 'basename', 'devproj', 'interactive', 'devproj');
  const addRun = store.db.prepare(
    `INSERT INTO runs (id, agent_fingerprint, machine_id, started_at, ended_at, status, tokens_by_model, tool_call_counts, models)
     VALUES (?, ?, 'm1', ?, ?, ?, ?, '{}', '[]')`,
  );
  // nightly-bot: 10 clean daily runs at ~02:00 UTC, 100k tokens each
  for (let i = 10; i >= 1; i--) {
    const start = new Date(NOW.getTime() - i * DAY - 10 * 3_600_000);
    addRun.run(
      `cron-${i}`, 'fp-cron', start.toISOString(), new Date(start.getTime() + 8 * 60_000).toISOString(),
      'completed', JSON.stringify({ m: { input: 90_000, output: 10_000, cacheCreation: 0, cacheRead: 0 } }),
    );
  }
  // devproj: 3 runs, one error, one tokens-unavailable
  addRun.run('dev-1', 'fp-dev', new Date(NOW.getTime() - 2 * DAY).toISOString(), null, 'error',
    JSON.stringify({ m: { input: 5_000, output: 1_000, cacheCreation: 0, cacheRead: 0 } }));
  addRun.run('dev-2', 'fp-dev', new Date(NOW.getTime() - 1 * DAY).toISOString(), null, 'completed', null);
  addRun.run('dev-3', 'fp-dev', new Date(NOW.getTime() - 0.5 * DAY).toISOString(), null, 'completed',
    JSON.stringify({ m: { input: 4_000, output: 1_000, cacheCreation: 0, cacheRead: 0 } }));
  return { store, path };
}

describe('computeInsights', () => {
  it('builds a 30-day daily series and ranks agents by tokens', () => {
    const { store } = seed();
    const ins = computeInsights(store.db, NOW);
    store.close();
    expect(ins.dailyTokens).toHaveLength(30);
    expect(ins.topAgents[0]!.name).toBe('nightly-bot');
    expect(ins.topAgents[0]!.tokens30d).toBe(1_000_000);
    expect(ins.topAgents[0]!.avgRunMinutes).toBe(8);
  });

  it('suggests an inferred daily cadence for stable-gap agents, never for declared ones', () => {
    const { store } = seed();
    let ins = computeInsights(store.db, NOW);
    const suggestion = ins.cadenceSuggestions.find((s) => s.agent === 'nightly-bot');
    expect(suggestion).toBeDefined();
    expect(suggestion!.suggestedExpect).toMatch(/^daily /);
    expect(suggestion!.provenance).toBe('inferred');
    // declaring it removes the suggestion
    store.db
      .prepare(`INSERT INTO cadences (agent_fingerprint, machine_id, expect, grace_minutes, declared, origin, updated_at)
                VALUES ('fp-cron','m1','daily 02:00',60,1,'file','2026-07-13T00:00:00Z')`)
      .run();
    ins = computeInsights(store.db, NOW);
    expect(ins.cadenceSuggestions.find((s) => s.agent === 'nightly-bot')).toBeUndefined();
    store.close();
  });

  it('flags scheduled agents without declared cadence as unwatched risks', () => {
    const { store } = seed();
    const ins = computeInsights(store.db, NOW);
    store.close();
    expect(ins.unwatchedRisks.map((r) => r.agent)).toContain('nightly-bot');
  });

  it('tracks failure rate and data-quality counters honestly', () => {
    const { store } = seed();
    const ins = computeInsights(store.db, NOW);
    store.close();
    const dev = ins.topAgents.find((a) => a.name === 'devproj')!;
    expect(dev.failureRate).toBeCloseTo(1 / 3, 5);
    expect(ins.dataQuality.tokensUnavailableRuns).toBe(1);
    expect(ins.dataQuality.basenameIdentityAgents).toBe(1);
  });
});

describe('connector-agent token honesty', () => {
  it('platform_connector agents report tokens as unavailable (null), never 0', async () => {
    const { FleetStore } = await import('../packages/collector/src/store.js');
    const { listAgents } = await import('../packages/collector/src/queries.js');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dbPath = join(mkdtempSync(join(tmpdir(), 'conn-')), 'fleet.db');
    const s = new FleetStore(dbPath);
    s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
    s.db
      .prepare(
        `INSERT INTO agents (fingerprint, vendor, source, project_identity, project_identity_source,
           agent_name, trigger_source, display_name, identity_confidence, first_seen_at, last_run_at)
         VALUES ('fpv','vertex','platform_connector','us-central1/A1','git_remote','probe','scheduled',
           'anveinspect-vertex-probe',1.0,'2026-07-13T00:00:00Z','2026-07-13T00:00:00Z')`,
      )
      .run();
    const rows = listAgents(s.db);
    s.close();
    const vertex = rows.find((r) => r.vendor === 'vertex')!;
    expect(vertex.tokens30d).toBeNull(); // catalog-only: unavailable, not 0
  });
});

describe('buildReport', () => {
  it('produces a self-describing markdown bundle with real numbers, no dollar figures', () => {
    const { store } = seed();
    const r = buildReport(store.db, NOW);
    store.close();
    expect(r.markdown).toContain('# AnveInspect fleet report');
    expect(r.markdown).toContain('nightly-bot');
    expect(r.markdown).toContain('1.0M');
    expect(r.markdown).toContain('unavailable ≠ zero');
    expect(r.markdown).toContain('UNWATCHED: nightly-bot');
    expect(r.markdown).not.toMatch(/\$\d/); // no invented dollars
  });
});
