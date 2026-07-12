/** SQLite DDL — local store on each machine; the hosted D1 schema mirrors this. */
export const DDL = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  last_heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  fingerprint TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local_collector',
  platform_ref TEXT,
  project_identity TEXT NOT NULL,
  project_identity_source TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  trigger_source TEXT NOT NULL,
  display_name TEXT NOT NULL,
  identity_confidence REAL NOT NULL,
  possible_predecessor TEXT,
  first_seen_at TEXT NOT NULL,
  last_run_at TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,              -- vendor session id = idempotency key
  agent_fingerprint TEXT NOT NULL REFERENCES agents(fingerprint),
  machine_id TEXT NOT NULL REFERENCES machines(id),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  tokens_by_model TEXT,             -- JSON; NULL = unavailable (JSONL unparseable), render as such
  tool_call_counts TEXT NOT NULL DEFAULT '{}',
  models TEXT NOT NULL DEFAULT '[]',
  client_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent_time ON runs(agent_fingerprint, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_machine_time ON runs(machine_id, started_at);

CREATE TABLE IF NOT EXISTS spawns (
  parent_run_id TEXT NOT NULL,
  child_run_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  PRIMARY KEY (parent_run_id, child_run_id)
);

CREATE TABLE IF NOT EXISTS cadences (
  agent_fingerprint TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  expect TEXT NOT NULL,
  grace_minutes INTEGER NOT NULL DEFAULT 60,
  declared INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'file',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_fingerprint, machine_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  agent_fingerprint TEXT,
  machine_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked_at TEXT,
  snoozed_until TEXT,
  delivered_at TEXT,                  -- exactly-once webhook delivery marker
  dedup_key TEXT                      -- condition identity; dedup ignores ack state
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_dedup ON alerts(dedup_key);

CREATE TABLE IF NOT EXISTS connector_syncs (
  vendor TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  agent_count INTEGER NOT NULL,
  warnings TEXT NOT NULL DEFAULT '[]',
  error TEXT                          -- last auth/config error, verbatim actionable text
);

CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  payload TEXT NOT NULL,            -- normalized event JSON (data-boundary fields only)
  created_at TEXT NOT NULL,
  sent_at TEXT                      -- NULL = pending; at-least-once drain, server dedupes by run id
);
`;
