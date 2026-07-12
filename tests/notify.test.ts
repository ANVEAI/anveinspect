import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatSlackPayload, deliverAlerts, type DeliverableAlert } from '../packages/collector/src/notify.js';
import { FleetStore } from '../packages/collector/src/store.js';

const ALERT: DeliverableAlert = {
  id: 'al-1',
  kind: 'missed_window',
  reason: 'nightly-bot missed daily 03:00 window — 7h overdue',
  created_at: '2026-07-13T10:00:00Z',
  display_name: 'nightly-bot',
  machine_label: 'mbp',
  last_success_at: '2026-07-12T03:04:00Z',
  cadence: 'daily 03:00',
};

describe('formatSlackPayload', () => {
  it('carries full diagnosis: kind, agent, reason, context, ack command', () => {
    const p: any = formatSlackPayload(ALERT, 'http://localhost:4177');
    expect(p.text).toBe('[MISSED WINDOW] nightly-bot missed daily 03:00 window — 7h overdue');
    const flat = JSON.stringify(p.blocks);
    expect(flat).toContain('last successful run: 2026-07-12T03:04:00Z');
    expect(flat).toContain('cadence: daily 03:00');
    expect(flat).toContain('anveinspect ack al-1');
    // copy rule: utility language — no exclamation marks
    expect(flat).not.toMatch(/!/);
  });
});

function seededDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anveinspect-'));
  const dbPath = join(dir, 'fleet.db');
  const store = new FleetStore(dbPath);
  store.db.prepare(`INSERT INTO machines (id, label) VALUES ('m1','mbp')`).run();
  store.db
    .prepare(`INSERT INTO alerts (id, kind, agent_fingerprint, machine_id, reason, created_at) VALUES ('a1','missed_window',NULL,'m1','r1','2026-07-13T09:00:00Z'), ('a2','token_spike',NULL,'m1','r2','2026-07-13T09:01:00Z')`)
    .run();
  store.close();
  return dbPath;
}

describe('deliverAlerts', () => {
  it('delivers each undelivered open alert exactly once', async () => {
    const dbPath = seededDb();
    const sent: string[] = [];
    const fetchFn = (async (_url: any, init: any) => {
      sent.push(JSON.parse(init.body).text);
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;
    const cfg = { slackWebhookUrl: 'https://hooks.example/x' };
    const first = await deliverAlerts(dbPath, { fetchFn, config: cfg });
    expect(first.delivered).toEqual(['a1', 'a2']);
    const second = await deliverAlerts(dbPath, { fetchFn, config: cfg });
    expect(second.delivered).toEqual([]); // exactly-once
    expect(sent).toHaveLength(2);
  });

  it('failed delivery stays undelivered and retries next call', async () => {
    const dbPath = seededDb();
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return { ok: calls > 2, status: calls > 2 ? 200 : 500 } as Response; // first pass fails both
    }) as typeof fetch;
    const cfg = { slackWebhookUrl: 'https://hooks.example/x' };
    const first = await deliverAlerts(dbPath, { fetchFn, config: cfg });
    expect(first.failed).toHaveLength(2);
    const second = await deliverAlerts(dbPath, { fetchFn, config: cfg });
    expect(second.delivered).toHaveLength(2); // retried, not lost
  });

  it('no webhook configured -> explicit skip, never a crash', async () => {
    const dbPath = seededDb();
    const outcome = await deliverAlerts(dbPath, { config: {} });
    expect(outcome.skipped).toBe('no_webhook');
  });
});
