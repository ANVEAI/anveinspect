import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB, openDb, listAgents, fleetStatus, ackAlert, runCheck, connectorStatus, buildReport, computeInsights, lineageSummary, topLineageRoots, lineageTree } from '@anveinspect/collector';

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
    if (req.url === '/api/insights') {
      const db = openDb(DEFAULT_DB);
      const insights = computeInsights(db);
      db.close();
      return send(200, insights);
    }
    if (req.url === '/api/lineage') {
      const db = openDb(DEFAULT_DB);
      const out = { summary: lineageSummary(db), roots: topLineageRoots(db, 25) };
      db.close();
      return send(200, out);
    }
    if (req.url?.startsWith('/api/lineage/tree')) {
      const runId = new URL(req.url, 'http://x').searchParams.get('run') || '';
      const db = openDb(DEFAULT_DB);
      const tree = lineageTree(db, runId, 8);
      db.close();
      return tree ? send(200, tree) : send(404, { error: 'no lineage for run ' + runId });
    }
    if (req.url === '/api/ai' || req.url === '/llms.txt') {
      // AI-discovery surface: full fleet report as markdown for ANY assistant
      const db = openDb(DEFAULT_DB);
      const r = buildReport(db);
      db.close();
      return send(200, r.markdown, 'text/markdown; charset=utf-8');
    }
    // State-changing POSTs: reject cross-origin so a random web page the user
    // has open can't blind-POST to localhost (loopback bind alone doesn't stop that).
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const host = req.headers.host ?? `127.0.0.1:${PORT}`;
      if (origin && origin !== `http://${host}` && origin !== `http://localhost:${PORT}`) {
        return send(403, { error: 'cross-origin POST rejected' });
      }
    }
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

// Bind to loopback ONLY: the dashboard exposes full fleet data and an
// unauthenticated ack/check surface — it must never be reachable off-box.
server.listen(PORT, '127.0.0.1', () => console.log(`anveinspect dashboard: http://localhost:${PORT} (db: ${DEFAULT_DB})`));
