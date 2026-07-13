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
  scanCodexSessions,
  buildReport,
  computeInsights,
  onboardReport,
  lineageSummary,
  topLineageRoots,
  lineageTree,
  agentGraph,
  subagentHealth,
  computeAnalytics,
  addTag,
  removeTag,
  tagSummary,
} from '@anveinspect/collector';

/**
 * anveinspect MCP server (stdio) — lets any Claude session operate the fleet:
 * inventory, triage, cadence declarations, and silent-failure checks.
 * All numbers come from the same shared query layer as the CLI and dashboard.
 */

const server = new McpServer({ name: 'anveinspect', version: '0.2.0' });

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
    // param is "agent" for consistency with fleet_declare_cadence / fleet_tag — operators guess one name
    inputSchema: { agent: z.string().min(1).describe('Agent display name (e.g. "voice-forms") or fingerprint') },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ agent }) =>
    guard(() => {
      const db = openDb();
      const d = agentDetail(db, agent);
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
      'Pull agent catalogs from configured platforms (Bedrock, AI Foundry, Vertex, Cloudflare) and local frameworks (OpenClaw, Hermes) into the fleet inventory. Read-only + catalog-only by design. Credentials live client-side in ~/.anveinspect/connectors.json — never synced anywhere.',
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
          ? `No connector has synced yet. Configure ${CONNECTORS_PATH} (anveinspect connectors init writes a template) then run fleet_connectors_sync.`
          : rows.map((r) => `${r.vendor}: ${r.agentCount} agents, synced ${r.syncedAt}${r.error ? ` — ERROR: ${r.error}` : ''}`).join('\n'),
      );
    }),
);

server.registerTool(
  'fleet_report',
  {
    title: 'Full fleet report (AI-ready)',
    description:
      'ONE call for the complete fleet picture, formatted for LLM reasoning: pulse, open alerts, 14-day token trend, top agents with economics, watch coverage gaps, inferred cadence suggestions, stale agents, data-quality notes. Use this FIRST when asked for a briefing, summary, analysis, or "how is my fleet doing" — then narrate insights and recommendations from it.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const db = openDb();
      const r = buildReport(db);
      db.close();
      return ok({ insights: r.insights, pulse: r.status.pulse }, r.markdown);
    }),
);

server.registerTool(
  'fleet_insights',
  {
    title: 'Fleet analytics (structured)',
    description:
      'Deterministic analytics as structured data: daily token series (30d), week-over-week delta, per-agent economics (tokens, share, avg duration, failure rate), inferred cadence suggestions (provenance-labeled, never auto-declare), unwatched scheduled agents, data-quality counters. Use when you need exact numbers to reason over or chart; use fleet_report for the narrative bundle.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const db = openDb();
      const insights = computeInsights(db);
      db.close();
      const s = insights;
      return ok(s, `Insights ready: ${s.topAgents.length} agents profiled, ${s.cadenceSuggestions.length} cadence suggestions, ${s.unwatchedRisks.length} unwatched risks, week-over-week ${s.weekOverWeek.deltaPct ?? 'n/a'}%.`);
    }),
);

server.registerTool(
  'fleet_setup',
  {
    title: 'Setup / onboarding',
    description:
      'Plug-and-play onboarding: detect every agent platform on this machine, reuse the CLIs the user already signed into (gcloud/aws/wrangler/az — no API keys), scan local logs, and report what is connected plus the exact one-line signin command for anything that is not. Use this FIRST when a user installs AnveInspect or asks how to connect their platforms.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const report = onboardReport();
      // first scan so setup ends with live inventory
      const scan = scanClaudeProjects();
      const codex = scanCodexSessions();
      const store = new FleetStore(DEFAULT_DB);
      store.upsertMachine({ id: machineId(), label: machineLabel(), lastHeartbeatAt: new Date().toISOString() });
      store.db.transaction(() => {
        for (const a of scan.agents) store.upsertAgent(a);
        for (const r of scan.runs) store.upsertRun(r);
        for (const s of scan.spawns) store.insertSpawn(s);
        for (const a of codex.agents) store.upsertAgent(a);
        for (const r of codex.runs) store.upsertRun(r);
      })();
      store.close();
      const connectors = await syncConnectors(DEFAULT_DB);
      const db = openDb();
      const st = fleetStatus(db);
      db.close();
      const needs = report.needsAction.map((p: any) => `${p.label}: ${p.fixCommand}`);
      return ok(
        { onboarding: report, pulse: st.pulse, connectors },
        `Fleet live: ${st.pulse.total} agents across ${st.pulse.platforms} platform(s). ` +
          `Ready: ${report.ready.join(', ') || 'none'}. ` +
          (needs.length ? `One-time signin to add more:\n${needs.map((n: string) => '  ' + n).join('\n')}` : 'Everything reachable is connected.'),
      );
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
);

server.registerTool(
  'fleet_lineage',
  {
    title: 'Agent lineage',
    description:
      'Spawn lineage + agent relationships. With no argument: fleet lineage summary, top roots, the agent-to-agent relationship graph (who spawns whom, with per-relationship tokens and data volume sent down / returned up), and subagent health (active/idle/stale). With run_id: the full spawn tree rooted at that run (parent → children with tokens/status). Use to answer "why is this running / who works with whom / how do agents share data / which subagents are stale".',
    inputSchema: {
      run_id: z.string().optional().describe('A run id (from fleet_lineage roots or fleet_agent_detail) to expand its spawn tree; omit for the fleet summary'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ run_id }) =>
    guard(() => {
      const db = openDb();
      if (run_id) {
        const tree = lineageTree(db, run_id, 8);
        db.close();
        if (!tree) return fail(`No lineage for run "${run_id}". List roots by calling fleet_lineage with no argument.`);
        return ok(tree, `${tree.agentName}: ${tree.children.length} direct children, ${tree.descendantCount} total descendants, subtree tokens ${tree.subtreeTokens ?? 'unavailable'}.`);
      }
      const summary = lineageSummary(db);
      const roots = topLineageRoots(db, 20);
      const relationships = agentGraph(db, 50);
      const subagents = subagentHealth(db);
      db.close();
      const names = new Map(relationships.nodes.map((n) => [n.fingerprint, n.name]));
      const topRel = relationships.edges
        .slice(0, 3)
        .map((e) => `${names.get(e.source) ?? '?'}→${names.get(e.target) ?? '?'} (${e.spawns}x${e.tokens === null ? '' : `, ${Math.round(e.tokens / 1000)}k tok`})`)
        .join(', ');
      return ok(
        { summary, roots, relationships, subagents },
        `${summary.totalEdges} spawn edges across ${summary.rootsWithChildren} roots (max depth ${summary.maxDepth}). ` +
          `Subagents: ${subagents.active} active / ${subagents.idle} idle / ${subagents.stale} stale of ${subagents.total}. ` +
          (topRel ? `Heaviest relationships: ${topRel}. ` : '') +
          `Top roots: ${roots.slice(0, 5).map((r) => `${r.agentName} (${r.descendantCount})`).join(', ')}.`,
      );
    }),
);

server.registerTool(
  'fleet_analytics',
  {
    title: 'Cost & activity analytics',
    description:
      'Estimated 30-day cost (from an editable pricing file) broken down by model, by platform, and by agent, plus busiest hours and failure bursts. Token counts are exact; dollars are estimates and every result reports priced/unpriced/tokenless run coverage. Use for "what is my fleet costing / what is most expensive / when is it busiest".',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () =>
    guard(() => {
      const db = openDb();
      const a = computeAnalytics(db);
      db.close();
      const top = a.topCostAgents.slice(0, 3).map((x) => `${x.name} $${x.usd.toFixed(2)}`).join(', ');
      return ok(a, `Estimated 30d cost $${a.estimatedCostUsd.toFixed(2)} (${a.ratesSource} rates; ${a.tokenlessRuns} runs unpriced). Top: ${top}. Busiest hour: ${a.busiestHours.slice().sort((x,y)=>y.runs-x.runs)[0]?.hour}:00.`);
    }),
);

server.registerTool(
  'fleet_tag',
  {
    title: 'Tag / group agents',
    description:
      'Organize the fleet with LOCAL tags (cohort, tier, owner, "retire"). Purely local metadata — never touches any platform or changes agent behavior. action add/remove attaches/detaches a tag; action list shows all tags with counts. This is the safe control primitive for grouping agents in the dashboard.',
    inputSchema: {
      action: z.enum(['add', 'remove', 'list']).describe('add or remove a tag on an agent, or list all tags'),
      agent: z.string().optional().describe('agent display name (required for add/remove)'),
      tag: z.string().optional().describe('tag text (required for add/remove)'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ action, agent, tag }) =>
    guard(() => {
      if (action === 'list') {
        const db = openDb();
        const ts = tagSummary(db);
        db.close();
        return ok({ tags: ts }, ts.length ? ts.map((t) => `#${t.tag} (${t.count})`).join(', ') : 'No tags yet.');
      }
      if (!agent || !tag) return fail('add/remove require both agent and tag');
      if (action === 'add') { const r = addTag(DEFAULT_DB, agent, tag); return ok(r, `Tagged ${r.agent} #${r.tag}.`); }
      const removed = removeTag(DEFAULT_DB, agent, tag);
      return ok({ removed, agent, tag }, removed ? `Removed #${tag} from ${agent}.` : `${agent} had no #${tag}.`);
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
