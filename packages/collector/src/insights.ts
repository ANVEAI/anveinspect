import Database from 'better-sqlite3';

/**
 * Deterministic analytics layer — the numbers Claude's AI layer reasons over.
 * Everything here is arithmetic on the fleet db: no model calls, no guesses.
 * Claude narrates and recommends; this module never does. Inferred values
 * carry provenance ("inferred") and never trigger alerts (design rule).
 */

export interface DailyTokens {
  day: string; // YYYY-MM-DD
  tokens: number;
  runs: number;
}

export interface AgentEconomics {
  name: string;
  trigger: string;
  runs30d: number;
  tokens30d: number | null;
  share: number | null; // fraction of fleet tokens, null when unavailable
  avgRunMinutes: number | null;
  failureRate: number; // error+unknown_end / runs, 0..1
}

export interface CadenceSuggestion {
  agent: string;
  fingerprint: string;
  suggestedExpect: string;
  medianGapHours: number;
  sampleRuns: number;
  confidence: 'high' | 'medium';
  provenance: 'inferred';
}

export interface FleetInsights {
  generatedAt: string;
  window: '30d';
  dailyTokens: DailyTokens[];
  weekOverWeek: { thisWeekTokens: number; lastWeekTokens: number; deltaPct: number | null };
  topAgents: AgentEconomics[];
  cadenceSuggestions: CadenceSuggestion[];
  unwatchedRisks: { agent: string; reason: string }[];
  dataQuality: { runs30d: number; tokensUnavailableRuns: number; basenameIdentityAgents: number };
}

const DAY_MS = 86_400_000;

export function computeInsights(db: Database.Database, now = new Date()): FleetInsights {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const runs = db
    .prepare(
      `SELECT r.agent_fingerprint, r.started_at, r.ended_at, r.status, r.tokens_by_model,
              a.display_name, a.trigger_source, a.project_identity_source
       FROM runs r JOIN agents a ON a.fingerprint = r.agent_fingerprint
       WHERE r.started_at >= ?`,
    )
    .all(since) as any[];

  // daily series
  const byDay = new Map<string, { tokens: number; runs: number }>();
  for (let i = 29; i >= 0; i--) {
    byDay.set(new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10), { tokens: 0, runs: 0 });
  }
  const tokensOf = (r: any): number | null => {
    if (r.tokens_by_model === null) return null;
    let t = 0;
    for (const v of Object.values(JSON.parse(r.tokens_by_model)) as any[]) t += v.input + v.output;
    return t;
  };
  for (const r of runs) {
    const day = String(r.started_at).slice(0, 10);
    const bucket = byDay.get(day);
    if (!bucket) continue;
    bucket.runs += 1;
    const t = tokensOf(r);
    if (t !== null) bucket.tokens += t;
  }
  const dailyTokens = [...byDay.entries()].map(([day, v]) => ({ day, ...v }));

  // week over week
  const weekTokens = (offsetDays: number) =>
    dailyTokens.slice(30 - offsetDays, 37 - offsetDays).reduce((s, d) => s + d.tokens, 0);
  const thisWeekTokens = dailyTokens.slice(23).reduce((s, d) => s + d.tokens, 0);
  const lastWeekTokens = dailyTokens.slice(16, 23).reduce((s, d) => s + d.tokens, 0);
  void weekTokens;

  // per-agent economics
  const byAgent = new Map<string, any[]>();
  for (const r of runs) {
    const list = byAgent.get(r.agent_fingerprint) ?? [];
    list.push(r);
    byAgent.set(r.agent_fingerprint, list);
  }
  const fleetTokens = dailyTokens.reduce((s, d) => s + d.tokens, 0);
  const topAgents: AgentEconomics[] = [...byAgent.values()]
    .map((list) => {
      const first = list[0];
      let tokens: number | null = 0;
      let anyTokens = false;
      let durTotal = 0;
      let durCount = 0;
      let failures = 0;
      for (const r of list) {
        const t = tokensOf(r);
        if (t !== null) { tokens! += t; anyTokens = true; }
        if (r.ended_at) { durTotal += Date.parse(r.ended_at) - Date.parse(r.started_at); durCount += 1; }
        if (r.status === 'error' || r.status === 'unknown_end') failures += 1;
      }
      if (!anyTokens) tokens = null;
      return {
        name: first.display_name,
        trigger: first.trigger_source,
        runs30d: list.length,
        tokens30d: tokens,
        share: tokens !== null && fleetTokens > 0 ? tokens / fleetTokens : null,
        avgRunMinutes: durCount > 0 ? Math.round(durTotal / durCount / 60_000) : null,
        failureRate: list.length ? failures / list.length : 0,
      };
    })
    .sort((a, b) => (b.tokens30d ?? -1) - (a.tokens30d ?? -1))
    .slice(0, 12);

  // inferred cadence suggestions: >=5 runs, stable inter-run gap (CV < 0.5)
  const declared = new Set(
    (db.prepare(`SELECT agent_fingerprint FROM cadences WHERE declared = 1`).all() as any[]).map(
      (r) => r.agent_fingerprint,
    ),
  );
  const cadenceSuggestions: CadenceSuggestion[] = [];
  for (const [fp, list] of byAgent) {
    if (declared.has(fp) || list.length < 5) continue;
    const starts = list.map((r) => Date.parse(r.started_at)).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++) gaps.push(starts[i]! - starts[i - 1]!);
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median < 30 * 60_000) continue; // sub-30min gaps = bursty interactive use, not a schedule
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length) / mean;
    if (cv >= 0.5) continue;
    const hours = median / 3_600_000;
    const suggestedExpect =
      hours >= 20 && hours <= 28
        ? `daily ${new Date(starts[starts.length - 1]!).toTimeString().slice(0, 5)}`
        : `every ${Math.max(1, Math.round(hours))}h`;
    cadenceSuggestions.push({
      agent: list[0].display_name,
      fingerprint: fp,
      suggestedExpect,
      medianGapHours: Math.round(hours * 10) / 10,
      sampleRuns: list.length,
      confidence: cv < 0.25 ? 'high' : 'medium',
      provenance: 'inferred',
    });
  }

  // unwatched risks: scheduled-trigger agents with no declared cadence
  const unwatchedRisks = (db
    .prepare(
      `SELECT a.display_name FROM agents a
       WHERE a.trigger_source = 'scheduled' AND a.source = 'local_collector'
         AND a.fingerprint NOT IN (SELECT agent_fingerprint FROM cadences WHERE declared = 1)`,
    )
    .all() as any[]).map((r) => ({
    agent: r.display_name,
    reason: 'runs on a schedule but has no declared cadence — silent failure would go unnoticed',
  }));

  return {
    generatedAt: now.toISOString(),
    window: '30d',
    dailyTokens,
    weekOverWeek: {
      thisWeekTokens,
      lastWeekTokens,
      deltaPct: lastWeekTokens > 0 ? Math.round(((thisWeekTokens - lastWeekTokens) / lastWeekTokens) * 100) : null,
    },
    topAgents,
    cadenceSuggestions,
    unwatchedRisks,
    dataQuality: {
      runs30d: runs.length,
      tokensUnavailableRuns: runs.filter((r) => r.tokens_by_model === null).length,
      basenameIdentityAgents: (db
        .prepare(`SELECT COUNT(DISTINCT fingerprint) AS n FROM agents WHERE project_identity_source = 'basename'`)
        .get() as any).n,
    },
  };
}
