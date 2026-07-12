import Database from 'better-sqlite3';
import { DDL, type Agent, type Run, type Spawn, type Machine } from '@anveinspect/schema';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class FleetStore {
  readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(DDL);
  }

  upsertMachine(m: Machine): void {
    this.db
      .prepare(
        `INSERT INTO machines (id, label, last_heartbeat_at) VALUES (@id, @label, @hb)
         ON CONFLICT(id) DO UPDATE SET label=@label, last_heartbeat_at=@hb`,
      )
      .run({ id: m.id, label: m.label, hb: m.lastHeartbeatAt });
  }

  upsertAgent(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (fingerprint, vendor, source, platform_ref, project_identity,
           project_identity_source, agent_name, trigger_source, display_name,
           identity_confidence, possible_predecessor, first_seen_at, last_run_at)
         VALUES (@fingerprint, @vendor, @source, @platformRef, @projectIdentity,
           @projectIdentitySource, @agentName, @triggerSource, @displayName,
           @identityConfidence, @possiblePredecessor, @firstSeenAt, @lastRunAt)
         ON CONFLICT(fingerprint) DO UPDATE SET
           last_run_at = CASE
             WHEN excluded.last_run_at IS NOT NULL
              AND (agents.last_run_at IS NULL OR excluded.last_run_at > agents.last_run_at)
             THEN excluded.last_run_at ELSE agents.last_run_at END,
           display_name = excluded.display_name`,
      )
      .run({ ...a, platformRef: a.platformRef ?? null, possiblePredecessor: a.possiblePredecessor ?? null });
  }

  /** Idempotent by run id — re-scans and outbox retries never duplicate (eng review D1). */
  upsertRun(r: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_fingerprint, machine_id, started_at, ended_at, status,
           tokens_by_model, tool_call_counts, models, client_version)
         VALUES (@id, @agentFingerprint, @machineId, @startedAt, @endedAt, @status,
           @tokens, @tools, @models, @clientVersion)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           status = excluded.status,
           tokens_by_model = excluded.tokens_by_model,
           tool_call_counts = excluded.tool_call_counts`,
      )
      .run({
        id: r.id,
        agentFingerprint: r.agentFingerprint,
        machineId: r.machineId,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        status: r.status,
        tokens: r.tokensByModel === null ? null : JSON.stringify(r.tokensByModel),
        tools: JSON.stringify(r.toolCallCounts),
        models: JSON.stringify(r.models),
        clientVersion: r.clientVersion,
      });
  }

  insertSpawn(s: Spawn): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO spawns (parent_run_id, child_run_id, confidence)
         VALUES (@parentRunId, @childRunId, @confidence)`,
      )
      .run(s);
  }

  close(): void {
    this.db.close();
  }
}
