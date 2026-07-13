import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The product's core trust promise: the CLI, the dashboard HTTP API, and the MCP
 * server report the SAME numbers. They share a query layer, but each has its own
 * glue (CLI --json, dashboard snapshot(), MCP tool handler) that could drift.
 * This drives all three against ONE seeded db through their real boundaries.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(REPO, 'packages', 'collector', 'src', 'cli.ts');
const MCP = join(REPO, 'packages', 'mcp', 'src', 'server.ts');

const dbPath = join(mkdtempSync(join(tmpdir(), 'consist-')), 'fleet.db');
process.env.ANVEINSPECT_DB = dbPath;
const env = { ...process.env, ANVEINSPECT_DB: dbPath };

const { FleetStore } = await import('../packages/collector/src/store.js');
const { startDashboard } = await import('../packages/collector/src/dashboard.js');
const { runCheck } = await import('../packages/collector/src/queries.js');
const { declareCadence } = await import('../packages/collector/src/queries.js');

// Seed: 3 agents (one stale >7d), runs, and a declared+missed cadence -> 1 open alert.
const now = Date.now();
const s = new FleetStore(dbPath);
s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','box')`).run();
const addAgent = s.db.prepare(
  `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at,last_run_at)
   VALUES (?,?,?,'basename',?,?,?,1.0,?,?)`,
);
addAgent.run('fpFresh', 'claude_code', 'p', 'p', 'interactive', 'fresh', new Date(now - 30 * 86400000).toISOString(), new Date(now - 3600000).toISOString());
addAgent.run('fpStale', 'codex', 'p', 'p', 'interactive', 'stale-one', new Date(now - 40 * 86400000).toISOString(), new Date(now - 9 * 86400000).toISOString());
addAgent.run('fpNightly', 'claude_code', 'p', 'p', 'scheduled', 'nightly', new Date(now - 40 * 86400000).toISOString(), new Date(now - 2 * 86400000).toISOString());
const addRun = s.db.prepare(`INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,ended_at,status,tokens_by_model,tool_call_counts,models) VALUES (?,?,'m1',?,?,?,?,'{}','[]')`);
addRun.run('r1', 'fpFresh', new Date(now - 3600000).toISOString(), new Date(now - 3500000).toISOString(), 'completed', JSON.stringify({ 'claude-sonnet-5': { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 } }));
addRun.run('r2', 'fpNightly', new Date(now - 2 * 86400000).toISOString(), new Date(now - 2 * 86400000 + 60000).toISOString(), 'completed', null);
// stale requires ageDays>7 AND run_count>3 (don't nag barely-used agents) — give it 4 old runs
for (let i = 0; i < 4; i++) {
  const t = new Date(now - (9 + i) * 86400000);
  addRun.run(`rs${i}`, 'fpStale', t.toISOString(), new Date(t.getTime() + 60000).toISOString(), 'completed', null);
}
s.close();

// a declared daily cadence the nightly agent has now missed -> 1 open alert
declareCadence(dbPath, 'nightly', 'daily 03:00', 60, 'ui');
runCheck(dbPath, new Date());

const PORT = 4994;
const server = startDashboard(PORT);
await new Promise((r) => setTimeout(r, 300));

afterAll(() => { server?.close(); delete process.env.ANVEINSPECT_DB; });

function cliPulse() {
  const raw = execFileSync('npx', ['tsx', CLI, 'status', '--json'], { env, encoding: 'utf8' });
  return JSON.parse(raw).pulse;
}
async function dashPulse() {
  const j: any = await fetch(`http://127.0.0.1:${PORT}/api/fleet`).then((r) => r.json());
  return j.pulse;
}
function mcpPulse() {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fleet_status', arguments: {} } },
  ].map((m) => JSON.stringify(m)).join('\n') + '\n';
  const out = spawnSync('npx', ['tsx', MCP], { env, input: msgs, encoding: 'utf8' }).stdout;
  for (const line of out.trim().split('\n')) {
    try { const j = JSON.parse(line); if (j.id === 2) return j.result.structuredContent.pulse; } catch { /* skip */ }
  }
  throw new Error('no MCP fleet_status response');
}

describe('cross-surface consistency', () => {
  it('CLI, dashboard, and MCP report identical pulse', async () => {
    const cli = cliPulse();
    const dash = await dashPulse();
    const mcp = mcpPulse();
    // unambiguous from the seed: 3 agents, and the missed nightly cadence fired >=1 alert
    expect(cli.total).toBe(3);
    expect(cli.openAlerts).toBeGreaterThanOrEqual(1);
    expect(cli.stale).toBeGreaterThanOrEqual(1); // the 9-day-old agent
    // the actual guarantee under test: every surface agrees with the CLI, field by field
    for (const key of ['total', 'stale', 'openAlerts', 'platforms', 'machines'] as const) {
      expect(dash[key], `dashboard.${key} vs cli.${key}`).toBe(cli[key]);
      expect(mcp[key], `mcp.${key} vs cli.${key}`).toBe(cli[key]);
    }
  }, 60_000);
});
