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

  it('no webhook + desktop disabled -> explicit skip, never a crash', async () => {
    const dbPath = seededDb();
    // desktopNotifications:false forces the skip path deterministically on every OS
    const outcome = await deliverAlerts(dbPath, { config: { desktopNotifications: false } });
    expect(outcome.skipped).toBe('no_webhook');
  });
});

describe('desktop notification fallback (no Slack webhook)', () => {
  it('pages via the injected desktop notifier and keeps exactly-once semantics', async () => {
    const dbPath = seededDb();
    const shown: { title: string; body: string }[] = [];
    const desktopNotifier = (title: string, body: string) => void shown.push({ title, body });
    const cfg = {}; // no webhook -> darwin fallback path
    const first = await deliverAlerts(dbPath, { config: cfg, desktopNotifier });
    expect(first.channel).toBe('desktop');
    expect(first.delivered).toEqual(['a1', 'a2']);
    expect(shown).toHaveLength(2);
    expect(shown[0]!.title).toContain('MISSED WINDOW');
    const second = await deliverAlerts(dbPath, { config: cfg, desktopNotifier });
    expect(second.delivered).toEqual([]); // dedup identical to the Slack channel
    expect(shown).toHaveLength(2);
  });

  it('explicit desktopNotifications:false with no webhook skips honestly', async () => {
    const dbPath = seededDb();
    const out = await deliverAlerts(dbPath, { config: { desktopNotifications: false } });
    expect(out.skipped).toBe('no_webhook');
    expect(out.delivered).toEqual([]);
  });

  it('a failing notifier leaves alerts undelivered for retry', async () => {
    const dbPath = seededDb();
    const boom = () => { throw new Error('osascript unavailable'); };
    const first = await deliverAlerts(dbPath, { config: {}, desktopNotifier: boom });
    expect(first.delivered).toEqual([]);
    expect(first.failed).toHaveLength(2);
    // recovery: a working notifier delivers on the next tick
    const shown: string[] = [];
    const second = await deliverAlerts(dbPath, { config: {}, desktopNotifier: (t) => void shown.push(t) });
    expect(second.delivered).toEqual(['a1', 'a2']);
  });
});
