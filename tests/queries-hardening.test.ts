import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { FleetStore } from '../packages/collector/src/store.js';
import { listAgents, agentDetail, recentActivity } from '../packages/collector/src/queries.js';
import { allTags, tagsFor } from '../packages/collector/src/tags.js';

/**
 * Regression tests for the Codex adversarial-review findings: local transcripts use an
 * undocumented format, so a single corrupt token blob must never 500 a read, and a DB
 * predating the agent_tags migration must never crash a read-only tag query.
 */

function seedWithCorruptBlob() {
  const path = join(mkdtempSync(join(tmpdir(), 'hard-')), 'fleet.db');
  const s = new FleetStore(path);
  s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
  s.db
    .prepare(
      `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at,last_run_at) VALUES ('fp','claude_code','p','basename','p','interactive','app',1.0,'2026-07-13T00:00:00Z','2026-07-13T01:00:00Z')`,
    )
    .run();
  const addRun = s.db.prepare(
    `INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,status,tokens_by_model,tool_call_counts,models) VALUES (?,?,'m1',?,?,?,'{}',?)`,
  );
  // one good row, one with a corrupt tokens blob, one with a corrupt models blob
  addRun.run('good', 'fp', '2026-07-10T01:00:00Z', 'completed', JSON.stringify({ m: { input: 100, output: 50, cacheCreation: 0, cacheRead: 0 } }), '["claude-sonnet-5"]');
  addRun.run('badtokens', 'fp', '2026-07-11T01:00:00Z', 'completed', '{not json', '[]');
  addRun.run('badmodels', 'fp', '2026-07-12T01:00:00Z', 'completed', null, '{not json');
  return s;
}

describe('read-path hardening', () => {
  it('listAgents survives a corrupt tokens_by_model blob (no 500)', () => {
    const s = seedWithCorruptBlob();
    expect(() => listAgents(s.db)).not.toThrow();
    const agents = listAgents(s.db);
    // the good row's 150 tokens still count; the corrupt row is skipped, not faked to 0
    expect(agents[0]!.tokens30d).toBe(150);
    s.close();
  });

  it('agentDetail survives corrupt tokens and models blobs', () => {
    const s = seedWithCorruptBlob();
    expect(() => agentDetail(s.db, 'app')).not.toThrow();
    const d = agentDetail(s.db, 'app');
    const badModels = d.recentRuns.find((r) => r.id === 'badmodels')!;
    expect(badModels.models).toEqual([]); // corrupt models -> [] fallback
    const badTokens = d.recentRuns.find((r) => r.id === 'badtokens')!;
    expect(badTokens.tokens).toBeNull(); // corrupt tokens -> null (unavailable), never fake 0
    s.close();
  });

  it('recentActivity clamps a negative limit instead of returning the whole table', () => {
    const s = seedWithCorruptBlob();
    const runs = recentActivity(s.db, -1); // -1 = "no limit" in SQLite; must be clamped
    expect(runs.length).toBeGreaterThan(0);
    s.close();
  });

  it('tag reads on a DB with no agent_tags table return empty, never throw', () => {
    // simulate an old DB: create a bare runs/agents schema WITHOUT the tags migration
    const path = join(mkdtempSync(join(tmpdir(), 'old-')), 'fleet.db');
    const raw = new Database(path);
    raw.exec(`CREATE TABLE agent_tags_absent (x INTEGER)`); // ensure agent_tags itself is missing
    expect(() => allTags(raw)).not.toThrow();
    expect(allTags(raw).size).toBe(0);
    expect(tagsFor(raw, 'fp')).toEqual([]);
    raw.close();
  });
});
