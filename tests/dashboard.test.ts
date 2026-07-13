import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The dashboard server itself (moved into the collector for installability).
 * Real HTTP against a seeded db on an ephemeral port — no mocks.
 *
 * DEFAULT_DB is captured at module load, so the env var MUST be set before the
 * collector modules are imported — hence the dynamic imports below.
 */

const dbPath = join(mkdtempSync(join(tmpdir(), 'dash-')), 'fleet.db');
process.env.ANVEINSPECT_DB = dbPath;

const { FleetStore } = await import('../packages/collector/src/store.js');
const { startDashboard } = await import('../packages/collector/src/dashboard.js');

const s = new FleetStore(dbPath);
s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
s.db
  .prepare(
    `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at,last_run_at)
     VALUES ('fp1','claude_code','p','basename','p','interactive','promo-agent',1.0,'2026-07-13T00:00:00Z','2026-07-13T01:00:00Z')`,
  )
  .run();
s.db
  .prepare(
    `INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,ended_at,status,tokens_by_model,tool_call_counts,models)
     VALUES ('r1','fp1','m1','2026-07-13T00:30:00Z','2026-07-13T01:00:00Z','completed','{"m":{"input":100,"output":50,"cacheCreation":0,"cacheRead":0}}','{}','[]')`,
  )
  .run();
s.close();

const PORT = 4993;
const base = `http://127.0.0.1:${PORT}`;
const server = startDashboard(PORT);
await new Promise((r) => setTimeout(r, 300));

afterAll(() => {
  server?.close();
  delete process.env.ANVEINSPECT_DB;
});

describe('startDashboard (embedded server)', () => {
  it('serves the SPA shell at /', async () => {
    const html = await fetch(base + '/').then((r) => r.text());
    expect(html).toContain('AnveInspect');
  });

  it('every GET endpoint returns 200 with sane JSON', async () => {
    for (const ep of ['/api/fleet', '/api/insights', '/api/activity', '/api/analytics', '/api/lineage', '/api/graph']) {
      const res = await fetch(base + ep);
      expect(res.status, ep).toBe(200);
      await res.json(); // must parse
    }
  });

  it('fleet payload reflects the seeded db', async () => {
    const fleet: any = await fetch(base + '/api/fleet').then((r) => r.json());
    expect(fleet.pulse.total).toBe(1);
    expect(fleet.inventory[0].name).toBe('promo-agent');
  });

  it('unknown /api route is a JSON 404, never HTML', async () => {
    const res = await fetch(base + '/api/nope');
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toContain('unknown API route');
  });

  it('cross-origin POST is rejected with 403', async () => {
    const res = await fetch(base + '/api/tag', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ agent: 'promo-agent', tag: 'x' }),
    });
    expect(res.status).toBe(403);
  });

  it('tag round-trip via HTTP (same-origin)', async () => {
    const hdrs = { 'content-type': 'application/json', origin: base };
    const add = await fetch(base + '/api/tag', { method: 'POST', headers: hdrs, body: JSON.stringify({ agent: 'promo-agent', tag: 'video-star' }) });
    expect(add.status).toBe(200);
    const detail: any = await fetch(base + '/api/agent?name=promo-agent').then((r) => r.json());
    expect(detail.tags).toContain('video-star');
    const rm = await fetch(base + '/api/untag', { method: 'POST', headers: hdrs, body: JSON.stringify({ agent: 'promo-agent', tag: 'video-star' }) });
    expect(((await rm.json()) as any).removed).toBe(true);
  });
});
