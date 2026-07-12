#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  DEFAULT_DB,
  openDb,
  listAgents,
  agentDetail,
  declareCadence,
  runCheck,
  fleetStatus,
  ackAlert,
  scanClaudeProjects,
  machineId,
  machineLabel,
  FleetStore,
  syncConnectors,
  connectorStatus,
  CONNECTORS_PATH,
} from '@fleetdeck/collector';

/**
 * fleetdeck MCP server (stdio) — lets any Claude session operate the fleet:
 * inventory, triage, cadence declarations, and silent-failure checks.
 * All numbers come from the same shared query layer as the CLI and dashboard.
 */

const server = new McpServer({ name: 'fleetdeck', version: '0.2.0' });

function ok(structured: unknown, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured as Record<string, unknown>,
  };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

function guard<T>(fn: () => T) {
  try {
    return fn();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

server.registerTool(
  'fleet_status',
  {
    title: 'Fleet status',
    description:
      'One-glance fleet pulse: agent counts by health, open alerts (missed windows, token spikes), stale agents, machines. Start here when asked "how is my fleet?".',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const db = openDb();
      const s = fleetStatus(db);
      db.close();
      const p = s.pulse;
      return ok(
        s,
        `${p.total} agents · ${p.failed} failed · ${p.stale} stale · ${p.openAlerts} open alerts across ${p.machines} machine(s). ` +
          (s.openAlerts.length
            ? `Open alerts: ${s.openAlerts.map((a: any) => `[${a.kind}] ${a.reason}`).join('; ')}`
            : 'No open alerts.'),
      );
    }),
);

server.registerTool(
  'fleet_attention',
  {
    title: 'Needs attention',
    description:
      'Everything requiring action: open alerts plus stale/failed agents with plain-language reasons and alert ids (for fleet_ack).',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const db = openDb();
      const s = fleetStatus(db);
      db.close();
      const items = [
        ...s.openAlerts.map((a: any) => ({ type: 'alert', id: a.id, kind: a.kind, reason: a.reason })),
        ...s.staleAgents.map((a: any) => ({ type: a.status, name: a.name, lastRunAt: a.lastRunAt, runCount: a.runCount })),
      ];
      return ok(
        { items },
        items.length === 0
          ? 'Nothing needs attention — all agents on schedule.'
          : items.map((i: any) => (i.type === 'alert' ? `[${i.kind}] ${i.reason} (ack id: ${i.id})` : `[${i.type}] ${i.name} — last run ${i.lastRunAt}, ${i.runCount} prior runs`)).join('\n'),
      );
    }),
);

server.registerTool(
  'fleet_agents',
  {
    title: 'List agents',
    description:
      'Inventory of all known agents: name, trigger source (interactive/scheduled/subagent), machine, last run, run count, 30-day tokens, health, declared cadence. Filter with include_subagents=false to see only top-level agents.',
    inputSchema: {
      include_subagents: z.boolean().default(true).describe('Set false to hide Task-tool subagents'),
      status: z.enum(['all', 'healthy', 'stale', 'failed']).default('all').describe('Filter by health status'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ include_subagents, status }) =>
    guard(() => {
      const db = openDb();
      let rows = listAgents(db, { includeSubagents: include_subagents });
      db.close();
      if (status !== 'all') rows = rows.filter((r) => r.status === status);
      return ok(
        { agents: rows },
        rows.length === 0
          ? `No agents match (status=${status}). Run fleet_scan first if the fleet database is empty.`
          : rows.map((r) => `${r.status === 'healthy' ? '·' : r.status.toUpperCase()} ${r.name} [${r.trigger}] last ${r.lastRunAt ?? 'never'}, ${r.runCount} runs, tok30d ${r.tokens30d ?? 'unavailable'}${r.cadence ? `, cadence ${r.cadence}` : ''}`).join('\n'),
      );
    }),
);

server.registerTool(
  'fleet_agent_detail',
  {
    title: 'Agent detail',
    description: 'Deep-dive one agent by display name or fingerprint: recent runs with status and tokens, declared cadence, subagent spawn count.',
    inputSchema: { name: z.string().min(1).describe('Agent display name (e.g. "voice-forms") or fingerprint') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ name }) =>
    guard(() => {
      const db = openDb();
      const d = agentDetail(db, name);
      db.close();
      return ok(
        d,
        `${d.agent.display_name} (${d.agent.trigger_source}): ${d.recentRuns.length} recent runs, ${d.subagentSpawns} spawns, cadence ${d.cadence ? d.cadence.expect : 'none declared'}. Latest: ${d.recentRuns[0]?.startedAt ?? '—'} (${d.recentRuns[0]?.status ?? '—'}).`,
      );
    }),
);

server.registerTool(
  'fleet_scan',
  {
    title: 'Scan this machine',
    description:
      'Ingest/refresh this machine\'s Claude Code history into the fleet database (idempotent — safe to re-run; also captures subagent lineage). Run before other tools if data seems missing or stale.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
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
        agents: result.agents.length,
        runs: result.runs.length,
        spawnEdges: result.spawns.length,
        filesScanned: result.filesScanned,
      };
      return ok(summary, `Scan complete: ${summary.agents} agents, ${summary.runs} runs, ${summary.spawnEdges} lineage edges from ${summary.filesScanned} files.`);
    }),
);

server.registerTool(
  'fleet_declare_cadence',
  {
    title: 'Declare cadence',
    description:
      'Declare when an agent is EXPECTED to run so missed windows can page. Grammar: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "every Nh". Declared cadences are the alerting contract — only declare what genuinely should be on a schedule.',
    inputSchema: {
      agent: z.string().min(1).describe('Agent display name, e.g. "zapmind-autopilot"'),
      expect: z.string().min(1).describe('Cadence expression, e.g. "daily 03:00"'),
      grace_minutes: z.number().int().min(1).max(1440).default(60).describe('Minutes past the window before alerting'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ agent, expect, grace_minutes }) =>
    guard(() => {
      const c = declareCadence(DEFAULT_DB, agent, expect, grace_minutes);
      return ok(c, `Declared: "${agent}" expects "${expect}" with ${grace_minutes}m grace. Run fleet_check to evaluate now.`);
    }),
);

server.registerTool(
  'fleet_check',
  {
    title: 'Run silent-failure check',
    description:
      'Evaluate all declared cadences (missed windows) and token-spike heuristics NOW; persists new alerts (deduped against open ones) and returns everything currently open.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const { newAlerts, openAlerts } = runCheck(DEFAULT_DB);
      return ok(
        { newAlerts, openAlerts },
        `${newAlerts.length} new alert(s); ${openAlerts.length} open. ` +
          (openAlerts.length ? openAlerts.map((a: any) => `[${a.kind}] ${a.reason} (ack id: ${a.id})`).join('; ') : 'Fleet clean.'),
      );
    }),
);

server.registerTool(
  'fleet_ack',
  {
    title: 'Acknowledge alert',
    description: 'Acknowledge an open alert by id (from fleet_attention / fleet_check). Acked alerts stop appearing and allow re-fire on recurrence.',
    inputSchema: { alert_id: z.string().min(1).describe('Alert id') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ alert_id }) =>
    guard(() => {
      const acked = ackAlert(DEFAULT_DB, alert_id);
      if (!acked) return fail(`No open alert with id "${alert_id}". List open alerts with fleet_attention.`);
      return ok({ acked: true, id: alert_id }, `Acked ${alert_id}.`);
    }),
);

server.registerTool(
  'fleet_connectors_sync',
  {
    title: 'Sync platform connectors',
    description:
      'Pull agent catalogs from configured platforms (Bedrock, AI Foundry, Vertex, Cloudflare) and local frameworks (OpenClaw, Hermes) into the fleet inventory. Read-only + catalog-only by design. Credentials live client-side in ~/.fleetdeck/connectors.json — never synced anywhere.',
    inputSchema: {
      only: z.array(z.enum(['bedrock', 'foundry', 'vertex', 'cloudflare', 'openclaw', 'hermes'])).optional()
        .describe('Limit to specific vendors; omit for all'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ only }) => {
    try {
      const outcomes = await syncConnectors(DEFAULT_DB, { only: only as any });
      return ok(
        { outcomes },
        outcomes
          .map((o) =>
            !o.configured
              ? `${o.vendor}: not configured (credentials go in ${CONNECTORS_PATH})`
              : o.error
                ? `${o.vendor}: ERROR — ${o.error}`
                : `${o.vendor}: ${o.agentCount} agents synced${o.warnings.length ? ` (${o.warnings.join('; ')})` : ''}`,
          )
          .join('\n'),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'fleet_connectors_status',
  {
    title: 'Connector status',
    description: 'Per-platform sync freshness: last sync time, agent counts, warnings, and any credential errors (with the minimal read-only role fix).',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const rows = connectorStatus(DEFAULT_DB);
      return ok(
        { connectors: rows },
        rows.length === 0
          ? `No connector has synced yet. Configure ${CONNECTORS_PATH} (fleetdeck connectors init writes a template) then run fleet_connectors_sync.`
          : rows.map((r) => `${r.vendor}: ${r.agentCount} agents, synced ${r.syncedAt}${r.error ? ` — ERROR: ${r.error}` : ''}`).join('\n'),
      );
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
