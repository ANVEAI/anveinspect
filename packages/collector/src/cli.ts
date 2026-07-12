import { join } from 'node:path';
import { FleetStore } from './store.js';
import { scanClaudeProjects, machineId, machineLabel } from './claude-scanner.js';

const DB_PATH = process.env.FLEETDECK_DB ?? join(process.cwd(), 'fleet-data', 'fleet.db');

function cmdScan(): void {
  const started = Date.now();
  const result = scanClaudeProjects();
  const store = new FleetStore(DB_PATH);
  store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
  const tx = store.db.transaction(() => {
    for (const a of result.agents) store.upsertAgent(a);
    for (const r of result.runs) store.upsertRun(r);
    for (const s of result.spawns) store.insertSpawn(s);
  });
  tx();

  const totalTokens = result.runs.reduce((sum, r) => {
    if (!r.tokensByModel) return sum;
    return sum + Object.values(r.tokensByModel).reduce((s, t) => s + t.input + t.output, 0);
  }, 0);
  const unavailable = result.runs.filter((r) => r.tokensByModel === null).length;

  console.log(`fleetdeck scan — ${machineLabel()} (${machineId()})`);
  console.log(`  files scanned:   ${result.filesScanned}`);
  console.log(`  agents:          ${result.agents.length}`);
  console.log(`  runs:            ${result.runs.length} (${unavailable} with tokens unavailable)`);
  console.log(`  spawn edges:     ${result.spawns.length} (subagent lineage)`);
  console.log(`  tokens (in+out): ${totalTokens.toLocaleString()}`);
  console.log(`  parse failures:  ${result.parseFailures} (degraded gracefully, runs still tracked)`);
  console.log(`  db:              ${DB_PATH}`);
  console.log(`  took:            ${Date.now() - started}ms`);
  store.close();
}

const cmd = process.argv[2] ?? 'scan';
if (cmd === 'scan') cmdScan();
else {
  console.error(`unknown command: ${cmd} (available: scan)`);
  process.exit(1);
}
