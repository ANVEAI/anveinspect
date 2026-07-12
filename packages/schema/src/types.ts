/**
 * Vendor-neutral fleet schema.
 *
 *   machines 1──* runs *──1 agents          spawns: parent_run ──▶ child_run
 *   agents  1──* cadences (per machine!)    alerts: agent × machine × window
 *
 * Cadences bind to (agent, machine) pairs, never the fleet-wide agent —
 * machine A's runs must not mask machine B's dead copy of the same agent.
 */

export type Vendor =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'foundry'
  | 'bedrock'
  | 'vertex'
  | 'cloudflare'
  | 'openclaw'
  | 'hermes';

export type AgentSource = 'local_collector' | 'platform_connector';

export type TriggerSource = 'interactive' | 'scheduled' | 'hook' | 'ci' | 'subagent' | 'unknown';

export type RunStatus = 'running' | 'completed' | 'error' | 'interrupted' | 'unknown_end';

export interface Machine {
  id: string;            // stable machine id (hash of hostname + user, user-renameable label)
  label: string;
  lastHeartbeatAt: string | null; // ISO
}

export interface AgentIdentity {
  vendor: Vendor;
  /** git remote URL when available (machine-independent), else project dir basename */
  projectIdentity: string;
  /** 'git_remote' fingerprints match cross-machine at confidence 1.0; 'basename' carries a penalty */
  projectIdentitySource: 'git_remote' | 'basename';
  /** agent name, slash-command, or session-title heuristic */
  agentName: string;
  triggerSource: TriggerSource;
}

export interface Agent extends AgentIdentity {
  /** hash of (vendor, projectIdentity, agentName, triggerSource) — computed client-side, only digest syncs */
  fingerprint: string;
  source: AgentSource;
  /** platform-native id + scope for connector agents; null for local */
  platformRef: string | null;
  displayName: string;
  /** 0..1 — basename fallback and heuristic matches score < 1 */
  identityConfidence: number;
  possiblePredecessor: string | null; // fingerprint of probable pre-rename agent
  firstSeenAt: string;
  lastRunAt: string | null;
}

export interface Run {
  id: string;              // vendor-native run/session id — idempotency key for ingest
  agentFingerprint: string;
  machineId: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  /** null when JSONL was unparseable — render as "unavailable", never 0 */
  tokensByModel: Record<string, TokenCounts> | null;
  toolCallCounts: Record<string, number>; // tool name -> count (names only, never arguments)
  models: string[];
  clientVersion: string | null;           // for parser-version-per-CC-version strategy
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface Spawn {
  parentRunId: string;
  childRunId: string;
  /** within-session subagent trees ≈ 1.0; heuristic cross-session links < 1.0 */
  confidence: number;
}

export type CadenceOrigin = 'file' | 'ui';

export interface Cadence {
  agentFingerprint: string;
  machineId: string;
  /** 'daily 03:00' | cron expr | 'weekdays 09:00' */
  expect: string;
  graceMinutes: number;
  declared: boolean;       // false = inferred suggestion (never pages until confirmed)
  origin: CadenceOrigin;   // LWW with visible conflict banner — never silent (eng review D4)
  updatedAt: string;
}

export type AlertKind = 'missed_window' | 'run_error' | 'token_spike' | 'machine_silent';

export interface Alert {
  id: string;
  kind: AlertKind;
  agentFingerprint: string | null; // null for machine_silent
  machineId: string;
  reason: string;          // plain language: "missed 03:00 window — 2h 14m overdue · machine is up"
  createdAt: string;
  ackedAt: string | null;
  snoozedUntil: string | null;
}
