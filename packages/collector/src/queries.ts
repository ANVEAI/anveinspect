import Database from 'better-sqlite3';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Alert, Cadence } from '@anveinspect/schema';
import { checkMissedWindow, checkTokenSpike, parseExpect } from './cadence.js';
import { machineId } from './claude-scanner.js';

/**
 * Shared read/alert layer — single source of truth for CLI, MCP server, and
 * dashboard. Every consumer sees identical numbers or trust dies.
 */

export const DEFAULT_DB = process.env.ANVEINSPECT_DB ?? join(homedir(), '.anveinspect', 'fleet.db');

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

export function listAgents(db: Database.Database, opts: { includeSubagents?: boolean } = {}): AgentRow[] {
  const machines = new Map(
    (db.prepare(`SELECT id, label FROM machines`).all() as any[]).map((m) => [m.id, m.label]),
  );
  const rows = db
    .prepare(
      `SELECT a.fingerprint, a.display_name, a.vendor, a.trigger_source, a.project_identity_source,
              a.identity_confidence, a.last_run_at,
              (SELECT COUNT(*) FROM runs r WHERE r.agent_fingerprint = a.fingerprint) AS run_count,
              (SELECT r.status FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS last_status,
              (SELECT r.machine_id FROM runs r WHERE r.agent_fingerprint = a.fingerprint ORDER BY r.started_at DESC LIMIT 1) AS m_id,
              (SELECT c.expect FROM cadences c WHERE c.agent_fingerprint = a.fingerprint LIMIT 1) AS cadence,
              (SELECT c.declared FROM cadences c WHERE c.agent_fingerprint = a.fingerprint LIMIT 1) AS cadence_declared
       FROM agents a ORDER BY a.last_run_at DESC`,
    )
    .all() as any[];

  const now = Date.now();
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
        anyAvailable = true;
        for (const v of Object.values(JSON.parse(t.tokens_by_model)) as any[]) {
          tokens30d += v.input + v.output;
        }
      }
      if (!anyAvailable && tokenRows.length > 0) tokens30d = null;
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
  return {
    agent,
    cadence: cadence ?? null,
    subagentSpawns: spawnsOut?.n ?? 0,
    recentRuns: runs.map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      status: r.status,
      models: JSON.parse(r.models),
      tokens:
        r.tokens_by_model === null
          ? null
          : (Object.values(JSON.parse(r.tokens_by_model)) as any[]).reduce((s, t) => s + t.input + t.output, 0),
    })),
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
  const db = new Database(dbPath);
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
  const db = new Database(dbPath);
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
         WHERE al.acked_at IS NULL AND (al.snoozed_until IS NULL OR al.snoozed_until > datetime('now'))
         ORDER BY al.created_at DESC`,
      )
      .all() as any[];
    return { newAlerts: persisted, openAlerts };
  } finally {
    db.close();
  }
}

export function ackAlert(dbPath: string, alertId: string): boolean {
  const db = new Database(dbPath);
  try {
    const res = db
      .prepare(`UPDATE alerts SET acked_at = datetime('now') WHERE id = ? AND acked_at IS NULL`)
      .run(alertId);
    return res.changes > 0;
  } finally {
    db.close();
  }
}

export function fleetStatus(db: Database.Database) {
  const agents = listAgents(db);
  const machines = db.prepare(`SELECT id, label, last_heartbeat_at FROM machines`).all() as any[];
  const openAlerts = db
    .prepare(
      `SELECT al.id, al.kind, al.reason, al.created_at, a.display_name
       FROM alerts al LEFT JOIN agents a ON a.fingerprint = al.agent_fingerprint
       WHERE al.acked_at IS NULL AND (al.snoozed_until IS NULL OR al.snoozed_until > datetime('now'))
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
