import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.FLEETDECK_DB ?? join(__dirname, '..', 'fleet-data', 'fleet.db');
const PORT = Number(process.env.PORT ?? 4177);

/** Status derivation, v1 (no declared cadences yet — honest heuristics only):
 *  FAILED  = last run ended in error (StopFailure class)
 *  STALE   = previously active weekly+ agent with no run in >7d
 *  HEALTHY = ran within 7d
 *  Token spike detection ships with the cadence engine (Slice 2), not before. */
function fleetSnapshot() {
  const db = new Database(DB_PATH, { readonly: true });
  const agents = db
    .prepare(
      `SELECT a.fingerprint, a.display_name, a.vendor, a.project_identity, a.project_identity_source,
              a.trigger_source, a.identity_confidence, a.last_run_at,
              (SELECT COUNT(*) FROM runs r WHERE r.agent_fingerprint = a.fingerprint) AS run_count,
              (SELECT r.status FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS last_status,
              (SELECT r.machine_id FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS machine_id
       FROM agents a ORDER BY a.last_run_at DESC`,
    )
    .all() as any[];

  const tokensByAgent = new Map<string, number | null>();
  for (const a of agents) {
    const rows = db
      .prepare(`SELECT tokens_by_model FROM runs WHERE agent_fingerprint = ? AND started_at > datetime('now','-30 days')`)
      .all(a.fingerprint) as any[];
    let sum = 0;
    let anyAvailable = false;
    for (const r of rows) {
      if (r.tokens_by_model === null) continue;
      anyAvailable = true;
      const parsed = JSON.parse(r.tokens_by_model) as Record<string, { input: number; output: number }>;
      for (const t of Object.values(parsed)) sum += t.input + t.output;
    }
    tokensByAgent.set(a.fingerprint, anyAvailable ? sum : rows.length > 0 ? null : 0);
  }

  const machines = db.prepare(`SELECT id, label, last_heartbeat_at FROM machines`).all() as any[];
  const now = Date.now();
  const DAY = 86_400_000;

  const inventory = agents.map((a) => {
    const last = a.last_run_at ? Date.parse(a.last_run_at) : null;
    const ageDays = last ? (now - last) / DAY : Infinity;
    const status =
      a.last_status === 'error' ? 'failed'
      : ageDays > 7 && a.run_count > 3 ? 'stale'
      : 'healthy';
    return {
      name: a.display_name,
      vendor: a.vendor,
      machine: machines.find((m) => m.id === a.machine_id)?.label ?? '—',
      lastRunAt: a.last_run_at,
      status,
      runCount: a.run_count,
      trigger: a.trigger_source,
      identitySource: a.project_identity_source,
      confidence: a.identity_confidence,
      tokens30d: tokensByAgent.get(a.fingerprint) ?? null,
    };
  });

  const attention = inventory
    .filter((i) => i.status !== 'healthy')
    .map((i) => ({
      severity: i.status === 'failed' ? 'red' : 'amber',
      who: i.name,
      why:
        i.status === 'failed'
          ? 'last run ended in error'
          : `stale — no run since ${i.lastRunAt?.slice(0, 10) ?? 'unknown'} (${i.runCount} prior runs)`,
    }));

  const vendors = new Set(inventory.map((i) => i.vendor));
  db.close();
  return {
    generatedAt: new Date().toISOString(),
    pulse: {
      total: inventory.length,
      failed: inventory.filter((i) => i.status === 'failed').length,
      stale: inventory.filter((i) => i.status === 'stale').length,
      machines: machines.length,
      platforms: vendors.size,
    },
    attention,
    inventory,
    machines,
  };
}

const server = createServer((req, res) => {
  try {
    if (req.url === '/api/fleet') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fleetSnapshot()));
      return;
    }
    const html = readFileSync(join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(PORT, () => console.log(`fleetdeck dashboard: http://localhost:${PORT} (db: ${DB_PATH})`));
