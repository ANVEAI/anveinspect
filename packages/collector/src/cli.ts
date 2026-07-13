import { FleetStore } from './store.js';
import { scanClaudeProjects, machineId, machineLabel } from './claude-scanner.js';
import { scanCodexSessions } from './codex-scanner.js';
import { DEFAULT_DB, openDb, listAgents, agentDetail, declareCadence, runCheck, fleetStatus, ackAlert } from './queries.js';
import { syncConnectors, connectorStatus, loadConnectorsFile, writeConnectorsFile, CONNECTORS_PATH } from './connectors.js';
import { deliverAlerts, loadNotifyConfig, NOTIFY_PATH } from './notify.js';
import { buildReport } from './report.js';
import { computeInsights } from './insights.js';
import { onboardReport } from './onboard.js';
import { lineageSummary, topLineageRoots, lineageTree } from './lineage.js';
import { computeAnalytics } from './analytics.js';
import { fmtUsd } from './pricing.js';
import { addTag, removeTag, tagSummary } from './tags.js';
import { startDashboard } from './dashboard.js';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', 'com.anveinspect.tick.plist');
const CLI_PATH = fileURLToPath(import.meta.url);
// Bundled install: cli.mjs sits in dist/ next to index.html; package root is one up.
// Dev checkout: cli.ts sits in packages/collector/src; repo root is three up.
const IS_BUNDLED = existsSync(join(dirname(CLI_PATH), 'index.html'));
const REPO_ROOT = IS_BUNDLED ? resolve(dirname(CLI_PATH), '..') : resolve(dirname(CLI_PATH), '..', '..', '..');

async function notifyAndReport(): Promise<string[]> {
  const outcome = await deliverAlerts(DEFAULT_DB);
  if (outcome.skipped === 'no_webhook') {
    return [`delivery skipped — no slackWebhookUrl in ${NOTIFY_PATH} and desktop notifications unavailable`];
  }
  const via = outcome.channel === 'desktop' ? 'macOS Notification Center (set slackWebhookUrl for Slack)' : 'Slack';
  const lines = [`delivered ${outcome.delivered.length} alert(s) via ${via}`];
  for (const f of outcome.failed) lines.push(`  delivery FAILED for ${f.id}: ${f.error} (will retry next tick)`);
  return lines;
}

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
      const codex = scanCodexSessions();
      const store = new FleetStore(DEFAULT_DB);
      store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
      const tx = store.db.transaction(() => {
        for (const a of result.agents) store.upsertAgent(a);
        for (const r of result.runs) store.upsertRun(r);
        for (const s of result.spawns) store.insertSpawn(s);
        for (const a of codex.agents) store.upsertAgent(a);
        for (const r of codex.runs) store.upsertRun(r);
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
          `  files: ${summary.filesScanned}  agents touched: ${summary.agents}  runs: ${summary.runs}  (fleet totals: see status)`,
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
      // a typo'd id must not look like success — exit non-zero so scripts catch it too
      if (!ok) throw new Error(`no open alert with id "${id}". List open alerts with: anveinspect status`);
      out({ acked: true, id }, () => `acked ${id}`);
      break;
    }
    case 'dash': {
      // blocks intentionally — the server handle keeps the event loop alive
      startDashboard(args[1] ? Number(args[1]) : undefined);
      break;
    }
    case 'setup': {
      const target = args[1];
      const usage = 'usage: anveinspect setup <claude|codex|cursor> — prints the exact binding for that tool';
      if (!target) throw new Error(usage);
      // resolve the MCP entrypoint for THIS install: bundled dist/mcp.mjs beside the
      // installed cli, else the repo's TypeScript server (dev checkout)
      const distMcp = resolve(dirname(CLI_PATH), 'mcp.mjs');
      const repoMcp = join(REPO_ROOT, 'packages', 'mcp', 'src', 'server.ts');
      const mcpCmd = existsSync(distMcp) ? ['node', distMcp] : ['npx', 'tsx', repoMcp];
      const lines: string[] = [];
      if (target === 'claude') {
        lines.push(
          'Claude Code — two options:',
          '',
          '1. Full plugin (MCP tools + /anveinspect:* commands + hooks):',
          `   claude --plugin-dir ${join(REPO_ROOT, 'packages', 'plugin')}`,
          '',
          '2. MCP server only:',
          `   claude mcp add anveinspect -- ${mcpCmd.join(' ')}`,
          '',
          'Then ask Claude: "how\'s my fleet?"',
        );
      } else if (target === 'codex') {
        lines.push(
          'Codex — add to ~/.codex/config.toml:',
          '',
          '[mcp_servers.anveinspect]',
          `command = "${mcpCmd[0]}"`,
          `args = [${mcpCmd.slice(1).map((a) => `"${a}"`).join(', ')}]`,
          '',
          'Then ask Codex: "call fleet_status"',
        );
      } else if (target === 'cursor') {
        lines.push(
          'Cursor — add to .cursor/mcp.json (project) or ~/.cursor/mcp.json (global):',
          '',
          JSON.stringify({ mcpServers: { anveinspect: { command: mcpCmd[0], args: mcpCmd.slice(1) } } }, null, 2),
          '',
          'Then ask Cursor: "call fleet_status"',
        );
      } else {
        throw new Error(usage);
      }
      out({ target, command: mcpCmd }, () => lines.join('\n'));
      break;
    }
    case 'report': {
      const db = openDb();
      const r = buildReport(db);
      db.close();
      out({ insights: r.insights, pulse: r.status.pulse }, () => r.markdown);
      break;
    }
    case 'insights': {
      const db = openDb();
      const ins = computeInsights(db);
      db.close();
      out(ins, () => JSON.stringify(ins, null, 2));
      break;
    }
    case 'tick': {
      // scheduled entrypoint: refresh, evaluate, deliver — one command for launchd
      const result = scanClaudeProjects();
      const codex = scanCodexSessions();
      const store = new FleetStore(DEFAULT_DB);
      store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
      const tx = store.db.transaction(() => {
        for (const a of result.agents) store.upsertAgent(a);
        for (const r of result.runs) store.upsertRun(r);
        for (const s of result.spawns) store.insertSpawn(s);
        for (const a of codex.agents) store.upsertAgent(a);
        for (const r of codex.runs) store.upsertRun(r);
      });
      tx();
      store.close();
      const { newAlerts, openAlerts } = runCheck(DEFAULT_DB);
      const deliveryLines = await notifyAndReport();
      out({ scanned: result.runs.length, newAlerts: newAlerts.length, openAlerts: openAlerts.length, delivery: deliveryLines }, () =>
        [`tick @ ${new Date().toISOString()} — ${result.runs.length} runs scanned, ${newAlerts.length} new / ${openAlerts.length} open alerts`, ...deliveryLines].join('\n'),
      );
      break;
    }
    case 'notify': {
      if (args[1] !== 'deliver') throw new Error('usage: anveinspect notify deliver');
      const lines = await notifyAndReport();
      out({ lines }, () => lines.join('\n'));
      break;
    }
    case 'schedule': {
      const sub = args[1] ?? 'status';
      if (sub === 'install') {
        mkdirSync(dirname(PLIST_PATH), { recursive: true });
        // Single-quote the paths for the shell (handles spaces/&/backticks) THEN
        // XML-escape the whole command string. A silently-dead scheduler is the
        // worst failure mode for a watchdog, so both layers must be correct.
        const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
        const xml = (s: string) =>
          s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const command = IS_BUNDLED
          ? `node ${sh(CLI_PATH)} tick >> ${sh(join(homedir(), '.anveinspect', 'tick.log'))} 2>&1`
          : `cd ${sh(REPO_ROOT)} && npx tsx packages/collector/src/cli.ts tick >> ${sh(join(homedir(), '.anveinspect', 'tick.log'))} 2>&1`;
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.anveinspect.tick</string>
  <key>ProgramArguments</key><array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>${xml(command)}</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
        writeFileSync(PLIST_PATH, plist);
        out({ plist: PLIST_PATH }, () =>
          [
            `wrote ${PLIST_PATH} (every 15 minutes: scan -> check -> deliver)`,
            `activate with:   launchctl load ${PLIST_PATH}`,
            `logs:            ~/.anveinspect/tick.log`,
          ].join('\n'),
        );
      } else if (sub === 'uninstall') {
        if (existsSync(PLIST_PATH)) unlinkSync(PLIST_PATH);
        out({ removed: PLIST_PATH }, () => `removed ${PLIST_PATH}. If it was loaded: launchctl unload ${PLIST_PATH}`);
      } else {
        const installed = existsSync(PLIST_PATH);
        const cfg = loadNotifyConfig();
        out({ installed, plist: PLIST_PATH, webhookConfigured: Boolean(cfg.slackWebhookUrl) }, () =>
          [
            installed ? `schedule installed at ${PLIST_PATH}` : `schedule not installed — run "anveinspect schedule install"`,
            cfg.slackWebhookUrl ? 'Slack webhook: configured' : `Slack webhook: NOT configured — add {"slackWebhookUrl":"https://hooks.slack.com/..."} to ${NOTIFY_PATH}`,
          ].join('\n'),
        );
      }
      break;
    }
    case 'doctor':
    case 'init': {
      // Plug-and-play front door: detect platforms, reuse their CLI logins,
      // tell the user the exact one-line signin for anything not connected,
      // then do a first scan + sync so they see results immediately.
      const report = onboardReport();
      const icon = (s: string) => (s === 'ready' ? '✓' : s === 'not_present' ? '·' : '→');
      if (!json) {
        console.log('AnveInspect — platform check\n');
        for (const p of report.probes) {
          console.log(`  ${icon(p.status)} ${p.label.padEnd(22)} ${p.detail}`);
          if (p.fixCommand) console.log(`      sign in:  ${p.fixCommand}`);
        }
        console.log(`\n${report.summary}\n`);
      }
      // first scan + sync so `doctor` ends with live results, not just a checklist
      const scanResult = scanClaudeProjects();
      const codexResult = scanCodexSessions();
      const store = new FleetStore(DEFAULT_DB);
      store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
      store.db.transaction(() => {
        for (const a of scanResult.agents) store.upsertAgent(a);
        for (const r of scanResult.runs) store.upsertRun(r);
        for (const s of scanResult.spawns) store.insertSpawn(s);
        for (const a of codexResult.agents) store.upsertAgent(a);
        for (const r of codexResult.runs) store.upsertRun(r);
      })();
      store.close();
      const syncOutcomes = await syncConnectors(DEFAULT_DB);
      const db = openDb();
      const st = fleetStatus(db);
      db.close();
      if (!json) {
        const connected = syncOutcomes.filter((o) => o.configured && !o.error).length;
        console.log(`Fleet ready: ${st.pulse.total} agents across ${st.pulse.platforms} platform(s), ${connected} connector(s) synced.`);
        console.log(`Next: "anveinspect status" for the pulse, "anveinspect report" for the full picture.`);
      }
      if (json) console.log(JSON.stringify({ onboarding: report, pulse: st.pulse, connectors: syncOutcomes }, null, 2));
      break;
    }
    case 'tag': {
      const [, action, agent, tag] = args;
      if (action === 'add' && agent && tag) { const r = addTag(DEFAULT_DB, agent, tag); out(r, () => `tagged ${r.agent} #${r.tag}`); }
      else if (action === 'remove' && agent && tag) { const ok = removeTag(DEFAULT_DB, agent, tag); out({ removed: ok }, () => ok ? `removed #${tag} from ${agent}` : `${agent} had no #${tag}`); }
      else if (action === 'list' || !action) { const db = openDb(); const ts = tagSummary(db); db.close(); out(ts, () => ts.length ? ts.map((t) => `#${t.tag} (${t.count})`).join('  ') : 'no tags yet — try: anveinspect tag add <agent> <tag>'); }
      else throw new Error('usage: anveinspect tag <add|remove|list> [agent] [tag]');
      break;
    }
    case 'costs': {
      const db = openDb();
      const a = computeAnalytics(db);
      db.close();
      out(a, () =>
        [
          `estimated 30d cost: ${fmtUsd(a.estimatedCostUsd)} (${a.ratesSource} rates; ${a.pricedRuns} priced${a.partiallyPricedRuns ? ` (${a.partiallyPricedRuns} undercounted — mixed unknown model)` : ''}, ${a.unpricedRuns} unknown-model, ${a.tokenlessRuns} tokens-unavailable)`,
          'by model:',
          ...a.costByModel.map((m) => `  ${m.model.padEnd(30)} ${fmtUsd(m.usd)}`),
          'most expensive agents:',
          ...a.topCostAgents.slice(0, 8).map((x) => `  ${x.name.padEnd(28)} ${fmtUsd(x.usd)} (${x.runs} runs)`),
          `busiest hours (local): ${a.busiestHours.slice().sort((x, y) => y.runs - x.runs).slice(0, 3).map((h) => `${h.hour}:00 (${h.runs})`).join(', ')}`,
          a.failureBursts.length ? `failure bursts: ${a.failureBursts.map((b) => `${b.agent} ×${b.failures}`).join(', ')}` : 'no failure bursts',
          '(dollars are estimates from editable ~/.anveinspect/pricing.json; token counts are exact)',
        ].join('\n'),
      );
      break;
    }
    case 'lineage': {
      const db = openDb();
      if (args[1] === 'tree' && args[2]) {
        const tree = lineageTree(db, args[2], 8);
        db.close();
        if (!tree) throw new Error(`no lineage for run "${args[2]}"`);
        out(tree, () => {
          const lines: string[] = [];
          const walk = (n: any, depth: number) => {
            lines.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${n.agentName} [${n.vendor}/${n.trigger}] ${n.status} · ${n.tokens==null?'unavail':fmtTok(n.tokens)} tok${n.children.length?` · ${n.descendantCount} descendants`:''}`);
            n.children.forEach((c: any) => walk(c, depth + 1));
          };
          walk(tree, 0);
          return lines.join('\n');
        });
      } else {
        const summary = lineageSummary(db);
        const roots = topLineageRoots(db, 15);
        db.close();
        out({ summary, roots }, () =>
          [
            `lineage: ${summary.totalEdges} spawn edges · ${summary.rootsWithChildren} roots · max depth ${summary.maxDepth}`,
            summary.widestFanout ? `widest fanout: ${summary.widestFanout.agentName} (${summary.widestFanout.children} children)` : '',
            'top roots by descendants:',
            ...roots.slice(0, 10).map((r) => `  ${r.agentName} [${r.vendor}] — ${r.directChildren} direct, ${r.descendantCount} total  (run ${r.runId.slice(0, 20)}…)`),
          ].filter(Boolean).join('\n'),
        );
      }
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
                ? `- ${o.vendor}: not connected${o.hint ? ` — ${o.hint}` : ` (run: anveinspect connectors init)`}`
                : o.error
                  ? `X ${o.vendor}: ${o.error}`
                  : `· ${o.vendor}: ${o.agentCount} agents${o.warnings.length ? `  [${o.warnings.join(' | ')}]` : ''}`,
            )
            .join('\n'),
        );
      } else if (sub === 'set') {
        // anveinspect connectors set <vendor> <key> <value>  — no hand-editing JSON
        const [, , vendor, key, ...rest] = args;
        const value = rest.join(' ');
        if (!vendor || !key || !value) throw new Error('usage: anveinspect connectors set <vendor> <key> <value>');
        const file = loadConnectorsFile();
        (file as any)[vendor] = { ...(file as any)[vendor], [key]: value };
        writeConnectorsFile(file);
        out({ vendor, key, set: true }, () => `set ${vendor}.${key} in ${CONNECTORS_PATH} (0600). Run "anveinspect connectors sync".`);
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
          // vertex/bedrock connect via your CLI logins automatically (gcloud/aws) — no entries needed.
          // cloudflare needs a one-time Workers Scripts:Read token; foundry needs its project endpoint.
          cloudflare: existing.cloudflare ?? { apiToken: '' },
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
      throw new Error(`unknown command: ${cmd} (available: doctor, setup, dash, scan, status, agents, agent, lineage, costs, tag, check, cadence, ack, connectors, tick, notify, schedule, report, insights)`);
  }
} catch (err) {
  console.error(`anveinspect: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
