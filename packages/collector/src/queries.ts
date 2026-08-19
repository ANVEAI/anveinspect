import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Alert, Cadence } from '@anveinspect/schema';
import { checkMissedWindow, checkTokenSpike, parseExpect } from './cadence.js';
import { machineId } from './claude-scanner.js';
import { costOf, loadRates } from './pricing.js';
import { allTags, tagsFor } from './tags.js';

/**
 * Shared read/alert layer — single source of truth for CLI, MCP server, and
 * dashboard. Every consumer sees identical numbers or trust dies.
 */

export const DEFAULT_DB = process.env.ANVEINSPECT_DB ?? join(homedir(), '.anveinspect', 'fleet.db');

/** Parse a JSON blob that came from local transcripts (undocumented format); never crash a read on a corrupt row. */
function safeParse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Sum input+output across a tokens_by_model blob. null (unavailable) stays null; corrupt -> null (never fake 0). */
function sumTokens(raw: string | null): number | null {
  if (raw === null) return null;
  let parsed: Record<string, { input: number; output: number }>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  let sum = 0;
  for (const v of Object.values(parsed)) sum += (v?.input ?? 0) + (v?.output ?? 0);
  return sum;
}

export interface AgentRow {
  fingerprint: string;
  name: string;
  vendor: string;
  machine: string;
  trigger: string;
  identitySource: string;
  confidence: number;
  lastRunAt: string | null;
  runCount: number;
  lastStatus: string | null;
  status: 'failed' | 'stale' | 'healthy';
  tokens30d: number | null;
  cadence: string | null;
  cadenceDeclared: boolean;
  tags: string[];
}

const DAY = 86_400_000;

export function openDb(dbPath = DEFAULT_DB, readonly = true): Database.Database {
  try {
    return new Database(dbPath, { readonly, fileMustExist: true });
  } catch {
    throw new Error(
      `No fleet database at ${dbPath}. Run "anveinspect scan" first (or set ANVEINSPECT_DB to point at one).`,
    );
  }
}

/** Write-mode open with the SAME friendly missing-db guidance (raw SQLite
 *  "cannot open database" errors are useless to a new user). */
export function openDbRw(dbPath = DEFAULT_DB): Database.Database {
  try {
    return new Database(dbPath, { fileMustExist: true });
  } catch {
    throw new Error(
      `No fleet database at ${dbPath}. Run "anveinspect scan" first (or set ANVEINSPECT_DB to point at one).`,
    );
  }
}

export function listAgents(db: Database.Database, opts: { includeSubagents?: boolean } = {}): AgentRow[] {
  const machines = new Map(
    (db.prepare(`SELECT id, label FROM machines`).all() as any[]).map((m) => [m.id, m.label]),
  );
  const rows = db
    .prepare(
      `SELECT a.fingerprint, a.display_name, a.vendor, a.trigger_source, a.project_identity_source,
              a.identity_confidence, a.last_run_at, a.source,
              (SELECT COUNT(*) FROM runs r WHERE r.agent_fingerprint = a.fingerprint) AS run_count,
              (SELECT r.status FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS last_status,
              (SELECT r.machine_id FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS m_id,
              (SELECT c.expect FROM cadences c WHERE c.agent_fingerprint = a.fingerprint ORDER BY c.declared DESC, c.updated_at DESC LIMIT 1) AS cadence,
              (SELECT c.declared FROM cadences c WHERE c.agent_fingerprint = a.fingerprint ORDER BY c.declared DESC, c.updated_at DESC LIMIT 1) AS cadence_declared
       FROM agents a ORDER BY a.last_run_at DESC`,
    )
    .all() as any[];

  const now = Date.now();
  const tagMap = allTags(db);
  return rows
    .filter((r) => opts.includeSubagents !== false || r.trigger_source !== 'subagent')
    .map((r) => {
      const tokenRows = db
        .prepare(
          `SELECT tokens_by_model FROM runs WHERE agent_fingerprint = ? AND started_at > datetime('now','-30 days')`,
        )
        .all(r.fingerprint) as any[];
      let tokens30d: number | null = 0;
      let anyAvailable = false;
      for (const t of tokenRows) {
        if (t.tokens_by_model === null) continue;
        let parsed: any;
        try { parsed = JSON.parse(t.tokens_by_model); } catch { continue; } // corrupt blob -> skip, never 500
        anyAvailable = true;
        for (const v of Object.values(parsed) as any[]) tokens30d += v.input + v.output;
      }
      if (!anyAvailable && tokenRows.length > 0) tokens30d = null;
      // catalog-only connector agents have NO token telemetry by design —
      // "unavailable" is honest; "0" would falsely claim zero usage
      if (r.source === 'platform_connector') tokens30d = null;
      const ageDays = r.last_run_at ? (now - Date.parse(r.last_run_at)) / DAY : Infinity;
      const status: AgentRow['status'] =
        r.last_status === 'error' ? 'failed' : ageDays > 7 && r.run_count > 3 ? 'stale' : 'healthy';
      return {
        fingerprint: r.fingerprint,
        name: r.display_name,
        vendor: r.vendor,
        machine: machines.get(r.m_id) ?? '—',
        trigger: r.trigger_source,
        identitySource: r.project_identity_source,
        confidence: r.identity_confidence,
        lastRunAt: r.last_run_at,
        runCount: r.run_count,
        lastStatus: r.last_status,
        status,
        tokens30d,
        cadence: r.cadence ?? null,
        cadenceDeclared: r.cadence_declared === 1,
        tags: tagMap.get(r.fingerprint) ?? [],
      };
    });
}

export function agentDetail(db: Database.Database, nameOrFingerprint: string) {
  const agent = (db
    .prepare(`SELECT * FROM agents WHERE fingerprint = ? OR display_name = ? ORDER BY last_run_at DESC LIMIT 1`)
    .get(nameOrFingerprint, nameOrFingerprint) ?? null) as any;
  if (!agent) {
    const names = (db.prepare(`SELECT DISTINCT display_name FROM agents LIMIT 20`).all() as any[])
      .map((r) => r.display_name)
      .join(', ');
    throw new Error(`No agent named "${nameOrFingerprint}". Known agents include: ${names}`);
  }
  const runs = db
    .prepare(
      `SELECT id, started_at, ended_at, status, tokens_by_model, models
       FROM runs WHERE agent_fingerprint = ? ORDER BY started_at DESC LIMIT 30`,
    )
    .all(agent.fingerprint) as any[];
  const spawnsOut = db
    .prepare(
      `SELECT COUNT(*) AS n FROM spawns s JOIN runs r ON r.id = s.parent_run_id WHERE r.agent_fingerprint = ?`,
    )
    .get(agent.fingerprint) as any;
  const cadence = db
    .prepare(`SELECT expect, grace_minutes, declared, origin, updated_at FROM cadences WHERE agent_fingerprint = ?`)
    .get(agent.fingerprint) as any;
  // Everything below is scoped to a fixed window so cost and tool figures are
  // comparable between agents. `recentRuns` stays capped at 30 for display; these
  // aggregates deliberately read wider.
  const windowDays = 30;
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const windowRuns = db
    .prepare(
      `SELECT tokens_by_model, models, tool_call_counts
       FROM runs WHERE agent_fingerprint = ? AND started_at >= ?`,
    )
    .all(agent.fingerprint, since) as any[];

  // Tool usage. tool_call_counts is collected on most runs but was never read by
  // anything until now. MCP tools follow the `mcp__<server>__<tool>` convention,
  // which is the only way to attribute a call back to a server.
  const toolTally = new Map<string, number>();
  const mcpTally = new Map<string, number>();
  let runsWithTools = 0;
  for (const r of windowRuns) {
    const counts = safeParse<Record<string, number>>(r.tool_call_counts, {});
    let any = false;
    for (const [tool, n] of Object.entries(counts)) {
      if (typeof n !== 'number' || n <= 0) continue;
      any = true;
      toolTally.set(tool, (toolTally.get(tool) ?? 0) + n);
      if (tool.startsWith('mcp__')) {
        const server = tool.split('__')[1];
        if (server) mcpTally.set(server, (mcpTally.get(server) ?? 0) + n);
      }
    }
    if (any) runsWithTools += 1;
  }

  // Cost. costOf needs the per-model blob, not the pre-summed number, and reports
  // whether a model in the run lacked a rate — an unpriced model contributes 0, so
  // a `partial` total is an undercount and must never be presented as exact.
  const rates = loadRates();
  const modelRuns = new Map<string, number>();
  const unpriced = new Map<string, { runs: number; tokens: number }>();
  let usd = 0;
  let pricedRuns = 0;
  let partialRuns = 0;
  let tokensTotal: number | null = null;
  for (const r of windowRuns) {
    for (const m of safeParse<string[]>(r.models, [])) {
      modelRuns.set(m, (modelRuns.get(m) ?? 0) + 1);
    }
    const t = sumTokens(r.tokens_by_model);
    if (t !== null) tokensTotal = (tokensTotal ?? 0) + t;
    const blob = safeParse<Record<string, any> | null>(r.tokens_by_model, null);
    if (!blob) continue;
    for (const [m, v] of Object.entries(blob)) {
      if (rates[m]) continue;
      const u = unpriced.get(m) ?? { runs: 0, tokens: 0 };
      u.runs += 1;
      u.tokens += ((v as any)?.input ?? 0) + ((v as any)?.output ?? 0);
      unpriced.set(m, u);
    }
    const c = costOf(blob as any, rates);
    if (!c.priced) continue;
    usd += c.usd;
    pricedRuns += 1;
    if (c.partial) partialRuns += 1;
  }

  return {
    agent,
    tags: tagsFor(db, agent.fingerprint),
    cadence: cadence ?? null,
    subagentSpawns: spawnsOut?.n ?? 0,
    recentRuns: runs.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      models: safeParse(r.models, []), // corrupt models blob -> [], never crash the detail view
      tokens: sumTokens(r.tokens_by_model),
    })),
    // ── additive: existing consumers are unaffected ──
    windowDays,
    windowRunCount: windowRuns.length,
    tokensTotal,
    cost: {
      usd: pricedRuns > 0 ? usd : null,
      pricedRuns,
      partialRuns, // > 0 means usd is an undercount
      unpricedRuns: windowRuns.length - pricedRuns,
      ratesSource: process.env.ANVEINSPECT_PRICING ? 'custom' : 'default',
      unpricedModels: [...unpriced.entries()]
        .sort((a, b) => b[1].tokens - a[1].tokens)
        .map(([model, u]) => ({ model, ...u })),
    },
    models: [...modelRuns.entries()].sort((a, b) => b[1] - a[1]).map(([model, runs]) => ({ model, runs })),
    toolCalls: [...toolTally.entries()].sort((a, b) => b[1] - a[1]).map(([name, calls]) => ({ name, calls })),
    mcpServers: [...mcpTally.entries()].sort((a, b) => b[1] - a[1]).map(([server, calls]) => ({ server, calls })),
    runsWithTools,
  };
}

export function declareCadence(
  dbPath: string,
  agentName: string,
  expect: string,
  graceMinutes: number,
  origin: 'file' | 'ui' = 'ui',
): Cadence {
  parseExpect(expect); // validate before touching the db — throws with supported grammar
  const db = openDbRw(dbPath);
  try {
    const agent = db
      .prepare(`SELECT fingerprint FROM agents WHERE display_name = ? OR fingerprint = ? ORDER BY last_run_at DESC LIMIT 1`)
      .get(agentName, agentName) as any;
    if (!agent) throw new Error(`No agent named "${agentName}" — run "anveinspect scan" first or check the name with fleet_agents.`);
    const cadence: Cadence = {
      agentFingerprint: agent.fingerprint,
      machineId: machineId(),
      expect,
      graceMinutes,
      declared: true,
      origin,
      updatedAt: new Date().toISOString(),
    };
    // LWW with (updated_at, origin) tracking — conflicts surface in the UI, never silent
    db.prepare(
      `INSERT INTO cadences (agent_fingerprint, machine_id, expect, grace_minutes, declared, origin, updated_at)
       VALUES (@agentFingerprint, @machineId, @expect, @graceMinutes, 1, @origin, @updatedAt)
       ON CONFLICT(agent_fingerprint, machine_id) DO UPDATE SET
         expect=@expect, grace_minutes=@graceMinutes, declared=1, origin=@origin, updated_at=@updatedAt`,
    ).run(cadence as any);
    return cadence;
  } finally {
    db.close();
  }
}

/** Evaluate all declared cadences + token spikes; persist NEW alerts; return open ones. */
export function runCheck(dbPath: string, now = new Date()): { newAlerts: Alert[]; openAlerts: any[] } {
  const db = openDbRw(dbPath);
  try {
    const cadences = db.prepare(`SELECT * FROM cadences WHERE declared = 1`).all() as any[];
    const newAlerts: Alert[] = [];
    for (const c of cadences) {
      const agent = db.prepare(`SELECT display_name FROM agents WHERE fingerprint = ?`).get(c.agent_fingerprint) as any;
      const runStarts = (db
        .prepare(`SELECT started_at FROM runs WHERE agent_fingerprint = ? AND machine_id = ? ORDER BY started_at DESC LIMIT 100`)
        .all(c.agent_fingerprint, c.machine_id) as any[]).map((r) => r.started_at);
      const alert = checkMissedWindow({
        cadence: {
          agentFingerprint: c.agent_fingerprint,
          machineId: c.machine_id,
          expect: c.expect,
          graceMinutes: c.grace_minutes,
          declared: c.declared === 1,
          origin: c.origin,
          updatedAt: c.updated_at,
        },
        agentDisplayName: agent?.display_name ?? c.agent_fingerprint,
        runStarts,
        now,
      });
      if (alert) newAlerts.push(alert);
    }
    // token spikes across all agents with enough history
    const agents = db.prepare(`SELECT fingerprint, display_name FROM agents`).all() as any[];
    for (const a of agents) {
      const runs = (db
        .prepare(`SELECT started_at, tokens_by_model, machine_id FROM runs WHERE agent_fingerprint = ? ORDER BY started_at DESC LIMIT 40`)
        .all(a.fingerprint) as any[]).map((r) => ({
        startedAt: r.started_at,
        machineId: r.machine_id,
        tokensByModel: r.tokens_by_model === null ? null : JSON.parse(r.tokens_by_model),
      }));
      if (runs.length === 0) continue;
      const spike = checkTokenSpike(a.fingerprint, runs[0]!.machineId, a.display_name, runs, now);
      if (spike) newAlerts.push(spike);
    }
    // Dedup on the condition's identity (dedup_key), IGNORING ack state: the same
    // missed window / spiking run never re-fires after ack; a new window or new
    // spike has a different key and does fire. ON CONFLICT DO NOTHING = exactly-once.
    const insert = db.prepare(
      `INSERT INTO alerts (id, kind, agent_fingerprint, machine_id, reason, dedup_key, created_at, acked_at, snoozed_until)
       VALUES (@id, @kind, @agentFingerprint, @machineId, @reason, @dedupKey, @createdAt, NULL, NULL)
       ON CONFLICT(dedup_key) DO NOTHING`,
    );
    const persisted: Alert[] = [];
    for (const alert of newAlerts) {
      const res = insert.run(alert as any);
      if (res.changes > 0) persisted.push(alert);
    }
    const openAlerts = db
      .prepare(
        `SELECT al.*, a.display_name FROM alerts al LEFT JOIN agents a ON a.fingerprint = al.agent_fingerprint
         WHERE al.acked_at IS NULL AND (al.snoozed_until IS NULL OR julianday(al.snoozed_until) <= julianday('now'))
         ORDER BY al.created_at DESC`,
      )
      .all() as any[];
    return { newAlerts: persisted, openAlerts };
  } finally {
    db.close();
  }
}

export function ackAlert(dbPath: string, alertId: string): boolean {
  const db = openDbRw(dbPath);
  try {
    const res = db
      .prepare(`UPDATE alerts SET acked_at = datetime('now') WHERE id = ? AND acked_at IS NULL`)
      .run(alertId);
    return res.changes > 0;
  } finally {
    db.close();
  }
}

/** Recent runs across the whole fleet, newest first — the activity feed. */
export function recentActivity(db: Database.Database, limit = 60): {
  runId: string; fingerprint: string; agentName: string; vendor: string; trigger: string; machine: string;
  startedAt: string; endedAt: string | null; status: string; tokens: number | null; isSubagent: boolean;
}[] {
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit) || 60)); // clamp: -1 means "no limit" in SQLite
  const machines = new Map((db.prepare(`SELECT id,label FROM machines`).all() as any[]).map((m) => [m.id, m.label]));
  const rows = db
    .prepare(
      `SELECT r.id, r.agent_fingerprint, r.started_at, r.ended_at, r.status, r.tokens_by_model, r.machine_id,
              a.display_name, a.vendor, a.trigger_source
       FROM runs r JOIN agents a ON a.fingerprint = r.agent_fingerprint
       WHERE r.started_at IS NOT NULL ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(safeLimit) as any[];
  return rows.map((r) => {
    const tokens = sumTokens(r.tokens_by_model);
    return {
      runId: r.id, fingerprint: r.agent_fingerprint, agentName: r.display_name, vendor: r.vendor, trigger: r.trigger_source,
      machine: machines.get(r.machine_id) ?? '—', startedAt: r.started_at, endedAt: r.ended_at,
      status: r.status, tokens, isSubagent: r.trigger_source === 'subagent',
    };
  });
}

export function fleetStatus(db: Database.Database) {
  const agents = listAgents(db);
  const machines = db.prepare(`SELECT id, label, last_heartbeat_at FROM machines`).all() as any[];
  const openAlerts = db
    .prepare(
      `SELECT al.id, al.kind, al.reason, al.created_at, a.display_name
       FROM alerts al LEFT JOIN agents a ON a.fingerprint = al.agent_fingerprint
       WHERE al.acked_at IS NULL AND (al.snoozed_until IS NULL OR julianday(al.snoozed_until) <= julianday('now'))
       ORDER BY al.created_at DESC`,
    )
    .all() as any[];
  return {
    generatedAt: new Date().toISOString(),
    pulse: {
      total: agents.length,
      failed: agents.filter((a) => a.status === 'failed').length,
      stale: agents.filter((a) => a.status === 'stale').length,
      openAlerts: openAlerts.length,
      machines: machines.length,
      platforms: new Set(agents.map((a) => a.vendor)).size,
    },
    openAlerts,
    staleAgents: agents.filter((a) => a.status !== 'healthy').map((a) => ({
      name: a.name,
      status: a.status,
      lastRunAt: a.lastRunAt,
      runCount: a.runCount,
    })),
    machines,
  };
}
