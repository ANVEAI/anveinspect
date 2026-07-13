import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_DB, openDb, listAgents, fleetStatus, ackAlert, runCheck,
  agentDetail, recentActivity,
} from './queries.js';
import { buildReport } from './report.js';
import { computeInsights } from './insights.js';
import { computeAnalytics } from './analytics.js';
import { connectorStatus } from './connectors.js';
import { lineageSummary, topLineageRoots, lineageTree, agentGraph, subagentHealth, runTimeline } from './lineage.js';
import { addTag, removeTag } from './tags.js';

/**
 * The dashboard HTTP server, embeddable so `anveinspect dash` works from an
 * installed package (not just the repo). The SPA html ships alongside the
 * bundle; in the repo it lives at dashboard/index.html.
 */

function resolveHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.ANVEINSPECT_HTML, // explicit override
    join(here, 'index.html'), // installed bundle: dist/index.html next to dist/cli.mjs
    join(here, '..', '..', '..', 'dashboard', 'index.html'), // repo: packages/collector/src -> dashboard/
    join(here, '..', '..', 'dashboard', 'index.html'), // repo: dist/ -> dashboard/ (local bundle run)
  ].filter((c): c is string => !!c);
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(`dashboard index.html not found (tried: ${candidates.join(', ')})`);
}

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

/** Open a db handle, run fn, and ALWAYS close it — even if fn throws. Prevents handle leaks. */
function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb(DEFAULT_DB);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const MAX_BODY = 64 * 1024; // reject POST bodies larger than 64KB — a local client can't exhaust memory

export function startDashboard(port = Number(process.env.PORT ?? 4177)): ReturnType<typeof createServer> {
  const htmlPath = resolveHtml();
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : (body as string));
    };
    try {
      if (req.url === '/api/fleet') return send(200, snapshot());
      if (req.url === '/api/insights') return send(200, withDb((db) => computeInsights(db)));
      if (req.url === '/api/activity') return send(200, { runs: withDb((db) => recentActivity(db, 80)) });
      if (req.url === '/api/analytics') return send(200, withDb((db) => computeAnalytics(db)));
      if (req.url === '/api/lineage')
        return send(200, withDb((db) => ({ summary: lineageSummary(db), roots: topLineageRoots(db, 25), subagents: subagentHealth(db) })));
      if (req.url === '/api/graph') return send(200, withDb((db) => agentGraph(db)));
      if (req.url?.startsWith('/api/timeline')) {
        const runId = new URL(req.url, 'http://x').searchParams.get('run') || '';
        const rows = withDb((db) => runTimeline(db, runId));
        return rows.length ? send(200, { rows }) : send(404, { error: 'no timeline for run ' + runId });
      }
      if (req.url?.startsWith('/api/lineage/tree')) {
        const runId = new URL(req.url, 'http://x').searchParams.get('run') || '';
        const tree = withDb((db) => lineageTree(db, runId, 8));
        return tree ? send(200, tree) : send(404, { error: 'no lineage for run ' + runId });
      }
      if (req.url?.startsWith('/api/agent')) {
        const name = new URL(req.url, 'http://x').searchParams.get('name') || '';
        try {
          return send(200, withDb((db) => agentDetail(db, name)));
        } catch (e) {
          return send(404, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (req.url === '/api/ai' || req.url === '/llms.txt') {
        // AI-discovery surface: full fleet report as markdown for ANY assistant
        return send(200, withDb((db) => buildReport(db).markdown), 'text/markdown; charset=utf-8');
      }
      // State-changing POSTs: reject cross-origin so a random web page the user
      // has open can't blind-POST to localhost (loopback bind alone doesn't stop that).
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        const host = req.headers.host ?? `127.0.0.1:${port}`;
        if (origin && origin !== `http://${host}` && origin !== `http://localhost:${port}`) {
          return send(403, { error: 'cross-origin POST rejected' });
        }
      }
      if (req.url === '/api/check' && req.method === 'POST') return send(200, runCheck(DEFAULT_DB));
      if ((req.url === '/api/tag' || req.url === '/api/untag') && req.method === 'POST') {
        let body = '';
        let aborted = false;
        req.on('data', (c) => {
          if (aborted) return;
          body += c;
          if (body.length > MAX_BODY) { // stop buffering a runaway body
            aborted = true;
            send(413, { error: 'request body too large' });
            req.destroy();
          }
        });
        req.on('end', () => {
          if (aborted) return;
          try {
            const { agent, tag } = JSON.parse(body || '{}');
            if (!agent || !tag) return send(400, { error: 'agent and tag required' });
            if (req.url === '/api/tag') return send(200, addTag(DEFAULT_DB, agent, tag));
            return send(200, { removed: removeTag(DEFAULT_DB, agent, tag), agent, tag });
          } catch (e) { return send(400, { error: e instanceof Error ? e.message : String(e) }); }
        });
        return;
      }
      if (req.url?.startsWith('/api/ack/') && req.method === 'POST') {
        const id = decodeURIComponent(req.url.slice('/api/ack/'.length));
        return send(200, { acked: ackAlert(DEFAULT_DB, id), id });
      }
      // unknown API path -> JSON 404 (never HTML — a typo'd script call should fail loudly)
      if (req.url?.startsWith('/api/')) return send(404, { error: `unknown API route ${req.url}` });
      return send(200, readFileSync(htmlPath, 'utf8'), 'text/html');
    } catch (err) {
      return send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Bind to loopback ONLY: the dashboard exposes full fleet data and an
  // unauthenticated ack/check surface — it must never be reachable off-box.
  server.listen(port, '127.0.0.1', () => console.log(`anveinspect dashboard: http://localhost:${port} (db: ${DEFAULT_DB})`));
  return server;
}
