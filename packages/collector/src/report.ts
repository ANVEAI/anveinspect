import Database from 'better-sqlite3';
import { listAgents, fleetStatus } from './queries.js';
import { computeInsights, type FleetInsights } from './insights.js';

/**
 * AI-ready context bundle: ONE call gives an LLM the entire fleet picture in
 * markdown (token-efficient, sectioned, self-describing) plus the structured
 * form. Served identically via MCP (fleet_report), CLI (report), and the
 * dashboard's /api/ai endpoint — so any AI, not only MCP clients, can pull it.
 */

export interface FleetReport {
  markdown: string;
  status: ReturnType<typeof fleetStatus>;
  insights: FleetInsights;
}

const fmt = (n: number | null) =>
  n === null ? 'unavailable' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

export function buildReport(db: Database.Database, now = new Date()): FleetReport {
  const status = fleetStatus(db);
  const insights = computeInsights(db, now);
  const agents = listAgents(db);
  const p = status.pulse;

  const spark = insights.dailyTokens
    .slice(-14)
    .map((d) => d.tokens)
    .map((t, _, arr) => {
      const max = Math.max(...arr, 1);
      return '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((t / max) * 8))];
    })
    .join('');

  const lines: string[] = [
    `# AnveInspect fleet report`,
    `Generated ${insights.generatedAt} · window ${insights.window} · data quality: ${insights.dataQuality.runs30d} runs, ${insights.dataQuality.tokensUnavailableRuns} with tokens unavailable (unavailable ≠ zero), ${insights.dataQuality.basenameIdentityAgents} agents on basename identity (weaker cross-machine matching)`,
    ``,
    `## Pulse`,
    `${p.total} agents · ${p.failed} failed · ${p.stale} stale · ${p.openAlerts} open alerts · ${p.machines} machine(s) · ${p.platforms} platform(s)`,
    ``,
    `## Open alerts (ack via fleet_ack / anveinspect ack <id>)`,
    ...(status.openAlerts.length
      ? status.openAlerts.map((a: any) => `- [${a.kind}] ${a.reason} (id: ${a.id}, since ${a.created_at})`)
      : ['- none']),
    ``,
    `## Token trend (last 14 days) ${spark}`,
    `This week ${fmt(insights.weekOverWeek.thisWeekTokens)} vs last week ${fmt(insights.weekOverWeek.lastWeekTokens)}` +
      (insights.weekOverWeek.deltaPct === null ? '' : ` (${insights.weekOverWeek.deltaPct >= 0 ? '+' : ''}${insights.weekOverWeek.deltaPct}%)`),
    ``,
    `## Top agents by 30d tokens`,
    `| agent | trigger | runs | tokens | share | avg run | unclean-end rate* |`,
    `|---|---|---|---|---|---|---|`,
    ...insights.topAgents.map(
      (a) =>
        `| ${a.name} | ${a.trigger} | ${a.runs30d} | ${fmt(a.tokens30d)} | ${a.share === null ? '—' : Math.round(a.share * 100) + '%'} | ${a.avgRunMinutes === null ? '—' : a.avgRunMinutes >= 120 ? Math.round(a.avgRunMinutes / 60) + 'h' : a.avgRunMinutes + 'm'} | ${Math.round(a.failureRate * 100)}% |`,
    ),
    ``,
    `## Watch coverage`,
    ...(insights.unwatchedRisks.length
      ? insights.unwatchedRisks.map((r) => `- UNWATCHED: ${r.agent} — ${r.reason}`)
      : ['- all locally-collected scheduled agents have declared cadences (platform-connector agents are catalog-only in v1 — not alertable, so not counted here)']),
    ...(insights.cadenceSuggestions.length
      ? [
          ``,
          `## Inferred cadence suggestions (provenance: inferred — suggest to the user, never auto-declare)`,
          ...insights.cadenceSuggestions.map(
            (s) =>
              `- ${s.agent}: looks like "${s.suggestedExpect}" (median gap ${s.medianGapHours}h over ${s.sampleRuns} runs, ${s.confidence} confidence)`,
          ),
        ]
      : []),
    ``,
    `## Stale/failed agents`,
    ...(status.staleAgents.length
      ? status.staleAgents.map((a: any) => `- [${a.status}] ${a.name} — last run ${a.lastRunAt ?? 'never'} (${a.runCount} runs)`)
      : ['- none']),
    ``,
    `## Inventory summary`,
    `${agents.filter((a) => a.trigger !== 'subagent').length} top-level agents, ${agents.filter((a) => a.trigger === 'subagent').length} subagent types across vendors: ${[...new Set(agents.map((a) => a.vendor))].join(', ')}`,
    ``,
    `_*unclean-end rate counts error AND unknown_end runs — for interactive agents this mostly means sessions closed mid-turn, not real failures. Costs: token counts are facts; dollar estimates require a pricing file and are deliberately not computed here._`,
  ];

  return { markdown: lines.join('\n'), status, insights };
}
