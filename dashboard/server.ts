import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB, openDb, listAgents, fleetStatus, ackAlert, runCheck, connectorStatus } from '@fleetdeck/collector';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4177);

/** Same query layer as the CLI and MCP server — every surface shows identical numbers. */
function snapshot() {
  const db = openDb(DEFAULT_DB);
  const status = fleetStatus(db);
  const inventory = listAgents(db);
  db.close();
  return {
    generatedAt: status.generatedAt,
    pulse: status.pulse,
    attention: [
      ...status.openAlerts.map((a: any) => ({
        severity: 'red',
        who: a.display_name ?? 'machine',
        why: a.reason,
        alertId: a.id,
      })),
      ...status.staleAgents.map((a: any) => ({
        severity: 'amber',
        who: a.name,
        why: `stale — no run since ${a.lastRunAt?.slice(0, 10) ?? 'unknown'} (${a.runCount} prior runs)`,
        alertId: null,
      })),
    ],
    inventory,
    machines: status.machines,
    connectors: connectorStatus(DEFAULT_DB),
  };
}

const server = createServer((req, res) => {
  const send = (code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
  };
  try {
    if (req.url === '/api/fleet') return send(200, snapshot());
    if (req.url === '/api/check' && req.method === 'POST') return send(200, runCheck(DEFAULT_DB));
    if (req.url?.startsWith('/api/ack/') && req.method === 'POST') {
      const id = decodeURIComponent(req.url.slice('/api/ack/'.length));
      return send(200, { acked: ackAlert(DEFAULT_DB, id), id });
    }
    return send(200, readFileSync(join(__dirname, 'index.html'), 'utf8'), 'text/html');
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`fleetdeck dashboard: http://localhost:${PORT} (db: ${DEFAULT_DB})`));
