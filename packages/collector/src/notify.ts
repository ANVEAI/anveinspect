import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';

/**
 * Alert delivery (local mode): Slack incoming webhook with the rich-context
 * anatomy from the design spec — full diagnosis in the message, link-style
 * actions. Inline Ack buttons need the hosted interactivity endpoint (Slice 4).
 *
 * Delivery is exactly-once per alert: alerts carry delivered_at; only
 * undelivered open alerts send; failures stay undelivered and retry on the
 * next tick (the alert itself remains visible in dashboard/CLI regardless —
 * delivery failure is never silent loss).
 */

export const NOTIFY_PATH = process.env.ANVEINSPECT_NOTIFY ?? join(homedir(), '.anveinspect', 'notify.json');

export interface NotifyConfig {
  slackWebhookUrl?: string;
}

export function loadNotifyConfig(path = NOTIFY_PATH): NotifyConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`notify.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export interface DeliverableAlert {
  id: string;
  kind: string;
  reason: string;
  created_at: string;
  display_name: string | null;
  machine_label: string | null;
  last_success_at: string | null;
  cadence: string | null;
}

const KIND_LABEL: Record<string, string> = {
  missed_window: 'MISSED WINDOW',
  token_spike: 'TOKEN SPIKE',
  run_error: 'RUN ERROR',
  machine_silent: 'MACHINE SILENT',
};

/** Slack Block Kit payload — utility language, no exclamation marks, no "Oops" (design spec copy rule). */
export function formatSlackPayload(alert: DeliverableAlert, dashboardUrl: string): Record<string, unknown> {
  const context: string[] = [];
  if (alert.machine_label) context.push(`machine: ${alert.machine_label}`);
  if (alert.cadence) context.push(`cadence: ${alert.cadence}`);
  if (alert.last_success_at) context.push(`last successful run: ${alert.last_success_at}`);
  context.push(`detected: ${alert.created_at}`);
  return {
    text: `[${KIND_LABEL[alert.kind] ?? alert.kind}] ${alert.reason}`, // notification fallback line
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${KIND_LABEL[alert.kind] ?? alert.kind}* · ${alert.display_name ?? 'machine'}\n${alert.reason}`,
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: context.join('  ·  ') }] },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `<${dashboardUrl}|Open dashboard>  ·  ack: \`anveinspect ack ${alert.id}\``,
        },
      },
    ],
  };
}

export function undeliveredOpenAlerts(dbPath: string): DeliverableAlert[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .prepare(
        `SELECT al.id, al.kind, al.reason, al.created_at,
                a.display_name,
                m.label AS machine_label,
                (SELECT c.expect FROM cadences c WHERE c.agent_fingerprint = al.agent_fingerprint LIMIT 1) AS cadence,
                (SELECT r.started_at FROM runs r WHERE r.agent_fingerprint = al.agent_fingerprint
                   AND r.status IN ('completed') ORDER BY r.started_at DESC LIMIT 1) AS last_success_at
         FROM alerts al
         LEFT JOIN agents a ON a.fingerprint = al.agent_fingerprint
         LEFT JOIN machines m ON m.id = al.machine_id
         WHERE al.acked_at IS NULL AND al.delivered_at IS NULL
           AND (al.snoozed_until IS NULL OR al.snoozed_until > datetime('now'))
         ORDER BY al.created_at ASC`,
      )
      .all() as DeliverableAlert[];
  } finally {
    db.close();
  }
}

export interface DeliveryOutcome {
  delivered: string[];
  failed: { id: string; error: string }[];
  skipped: 'no_webhook' | null;
}

export async function deliverAlerts(
  dbPath: string,
  opts: { fetchFn?: typeof fetch; config?: NotifyConfig; dashboardUrl?: string } = {},
): Promise<DeliveryOutcome> {
  const config = opts.config ?? loadNotifyConfig();
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const dashboardUrl = opts.dashboardUrl ?? 'http://localhost:4177';
  if (!config.slackWebhookUrl) return { delivered: [], failed: [], skipped: 'no_webhook' };

  const pending = undeliveredOpenAlerts(dbPath);
  const delivered: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const db = new Database(dbPath);
  try {
    for (const alert of pending) {
      try {
        const res = await fetchFn(config.slackWebhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(formatSlackPayload(alert, dashboardUrl)),
        });
        if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
        db.prepare(`UPDATE alerts SET delivered_at = datetime('now') WHERE id = ?`).run(alert.id);
        delivered.push(alert.id);
      } catch (err) {
        failed.push({ id: alert.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    db.close();
  }
  return { delivered, failed, skipped: null };
}
