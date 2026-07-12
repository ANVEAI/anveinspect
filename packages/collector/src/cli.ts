import { FleetStore } from './store.js';
import { scanClaudeProjects, machineId, machineLabel } from './claude-scanner.js';
import { DEFAULT_DB, openDb, listAgents, agentDetail, declareCadence, runCheck, fleetStatus, ackAlert } from './queries.js';
import { syncConnectors, connectorStatus, loadConnectorsFile, writeConnectorsFile, CONNECTORS_PATH } from './connectors.js';

/**
 * anveinspect CLI — the surface Claude's plugin skills operate.
 *   scan                       ingest this machine's Claude Code history
 *   status [--json]            fleet pulse + open alerts + stale agents
 *   agents [--json]            inventory table
 *   agent <name> [--json]      one agent: runs, cadence, spawns
 *   check [--json]             evaluate cadences + token spikes, persist alerts
 *   cadence declare <agent> <expect> [--grace <min>]
 *   ack <alert-id>
 * All commands exit 0 on success, 1 with a one-line actionable error otherwise.
 */

const args = process.argv.slice(2);
const cmd = args[0] ?? 'status';
const json = args.includes('--json');

function out(obj: unknown, text: () => string): void {
  console.log(json ? JSON.stringify(obj, null, 2) : text());
}

function rel(iso: string | null): string {
  if (!iso) return '—';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function fmtTok(n: number | null): string {
  if (n === null) return 'unavailable';
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

try {
  switch (cmd) {
    case 'scan': {
      const started = Date.now();
      const result = scanClaudeProjects();
      const store = new FleetStore(DEFAULT_DB);
      store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
      const tx = store.db.transaction(() => {
        for (const a of result.agents) store.upsertAgent(a);
        for (const r of result.runs) store.upsertRun(r);
        for (const s of result.spawns) store.insertSpawn(s);
      });
      tx();
      store.close();
      const summary = {
        machine: machineLabel(),
        filesScanned: result.filesScanned,
        agents: result.agents.length,
        runs: result.runs.length,
        spawnEdges: result.spawns.length,
        tokensUnavailable: result.runs.filter((r) => r.tokensByModel === null).length,
        db: DEFAULT_DB,
        ms: Date.now() - started,
      };
      out(summary, () =>
        [
          `anveinspect scan — ${summary.machine}`,
          `  files: ${summary.filesScanned}  agents: ${summary.agents}  runs: ${summary.runs}`,
          `  spawn edges: ${summary.spawnEdges}  tokens-unavailable runs: ${summary.tokensUnavailable}`,
          `  db: ${summary.db}  (${summary.ms}ms)`,
        ].join('\n'),
      );
      break;
    }
    case 'status': {
      const db = openDb();
      const s = fleetStatus(db);
      db.close();
      out(s, () => {
        const p = s.pulse;
        const lines = [
          `${p.total} agents · ${p.failed} failed · ${p.stale} stale · ${p.openAlerts} open alerts · ${p.machines} machine(s)`,
        ];
        for (const a of s.openAlerts) lines.push(`  [ALERT ${a.kind}] ${a.reason}  (id: ${a.id})`);
        for (const a of s.staleAgents) lines.push(`  [${a.status.toUpperCase()}] ${a.name} — last run ${rel(a.lastRunAt)} (${a.runCount} runs)`);
        return lines.join('\n');
      });
      break;
    }
    case 'agents': {
      const db = openDb();
      const rows = listAgents(db);
      db.close();
      out(rows, () =>
        rows
          .map(
            (r) =>
              `${r.status === 'healthy' ? '·' : r.status === 'stale' ? '!' : 'X'} ${r.name.padEnd(28)} ${r.trigger.padEnd(12)} ${rel(r.lastRunAt).padEnd(9)} runs:${String(r.runCount).padEnd(6)} tok30d:${fmtTok(r.tokens30d)}${r.cadence ? `  cadence:${r.cadence}` : ''}`,
          )
          .join('\n'),
      );
      break;
    }
    case 'agent': {
      const name = args[1];
      if (!name) throw new Error('usage: anveinspect agent <name>');
      const db = openDb();
      const d = agentDetail(db, name);
      db.close();
      out(d, () =>
        [
          `${d.agent.display_name} (${d.agent.vendor}, ${d.agent.trigger_source}) — ${d.recentRuns.length} recent runs, ${d.subagentSpawns} subagent spawns`,
          d.cadence ? `cadence: ${d.cadence.expect} (grace ${d.cadence.grace_minutes}m, ${d.cadence.origin}, ${d.cadence.updated_at})` : 'cadence: none declared',
          ...d.recentRuns.slice(0, 10).map((r) => `  ${r.startedAt}  ${r.status.padEnd(12)} tok:${fmtTok(r.tokens)}`),
        ].join('\n'),
      );
      break;
    }
    case 'check': {
      const { newAlerts, openAlerts } = runCheck(DEFAULT_DB);
      out({ newAlerts, openAlerts }, () =>
        [
          `check complete — ${newAlerts.length} new alert(s), ${openAlerts.length} open total`,
          ...openAlerts.map((a) => `  [${a.kind}] ${a.reason}  (id: ${a.id})`),
        ].join('\n'),
      );
      break;
    }
    case 'cadence': {
      if (args[1] !== 'declare') throw new Error('usage: anveinspect cadence declare <agent> "<expect>" [--grace <min>]');
      const agent = args[2];
      const expect = args[3];
      if (!agent || !expect) throw new Error('usage: anveinspect cadence declare <agent> "<expect>" [--grace <min>]');
      const graceIdx = args.indexOf('--grace');
      const grace = graceIdx > -1 ? Number(args[graceIdx + 1]) : 60;
      const c = declareCadence(DEFAULT_DB, agent, expect, grace);
      out(c, () => `declared: ${agent} expects "${expect}" (grace ${grace}m). Run "anveinspect check" to evaluate.`);
      break;
    }
    case 'ack': {
      const id = args[1];
      if (!id) throw new Error('usage: anveinspect ack <alert-id>');
      const ok = ackAlert(DEFAULT_DB, id);
      out({ acked: ok, id }, () => (ok ? `acked ${id}` : `no open alert with id ${id}`));
      break;
    }
    case 'connectors': {
      const sub = args[1] ?? 'status';
      if (sub === 'sync') {
        const outcomes = await syncConnectors(DEFAULT_DB);
        out(outcomes, () =>
          outcomes
            .map((o) =>
              !o.configured
                ? `- ${o.vendor}: not configured (add credentials to ${CONNECTORS_PATH})`
                : o.error
                  ? `X ${o.vendor}: ${o.error}`
                  : `· ${o.vendor}: ${o.agentCount} agents${o.warnings.length ? `  [${o.warnings.join(' | ')}]` : ''}`,
            )
            .join('\n'),
        );
      } else if (sub === 'status') {
        const rows = connectorStatus(DEFAULT_DB);
        out(rows, () =>
          rows.length === 0
            ? `no connector has synced yet — run "anveinspect connectors sync" (config: ${CONNECTORS_PATH})`
            : rows.map((r) => `${r.error ? 'X' : '·'} ${r.vendor}: ${r.agentCount} agents, synced ${r.syncedAt}${r.error ? `  ERROR: ${r.error}` : ''}`).join('\n'),
        );
      } else if (sub === 'init') {
        const existing = loadConnectorsFile();
        const template = {
          bedrock: existing.bedrock ?? { region: 'us-east-1', accessKeyId: '', secretAccessKey: '' },
          foundry: existing.foundry ?? { endpoint: 'https://<resource>.services.ai.azure.com/api/projects/<project>', tenantId: '', clientId: '', clientSecret: '' },
          vertex: existing.vertex ?? { projectId: '', location: 'us-central1', serviceAccountKeyFile: '~/keys/vertex-viewer.json' },
          cloudflare: existing.cloudflare ?? { accountId: '', apiToken: '' },
          openclaw: existing.openclaw ?? { path: '~/.openclaw' },
          hermes: existing.hermes ?? { path: '~/.hermes' },
        };
        writeConnectorsFile(template as any);
        out({ path: CONNECTORS_PATH }, () => `template written to ${CONNECTORS_PATH} (mode 0600). Fill in READ-ONLY credentials only, then "anveinspect connectors sync".`);
      } else {
        throw new Error('usage: anveinspect connectors <sync|status|init>');
      }
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd} (available: scan, status, agents, agent, check, cadence, ack, connectors)`);
  }
} catch (err) {
  console.error(`anveinspect: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
