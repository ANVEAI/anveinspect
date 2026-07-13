import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { DDL } from '@anveinspect/schema';
import { FleetStore } from '../packages/collector/src/store.js';
import { agentGraph } from '../packages/collector/src/lineage.js';
import { addTag, tagsFor } from '../packages/collector/src/tags.js';

/**
 * The real-world UPGRADE path: an existing user's fleet.db predates the agent_tags
 * table and the spawn payload columns (prompt_chars / result_chars). Opening it with
 * the current code must run the additive migrations, keep every old row, and light
 * up the new features — never a manual "delete your db" step.
 */

function legacyDb(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'migrate-')), 'fleet.db');
  const raw = new Database(path);
  raw.exec(DDL); // base schema only — no migrations have ever run against this file
  raw.prepare(`INSERT INTO machines (id,label) VALUES ('m1','old-box')`).run();
  raw.prepare(
    `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at,last_run_at)
     VALUES ('fpA','claude_code','p','basename','p','interactive','legacy-parent',1.0,'2026-01-01T00:00:00Z','2026-07-13T01:00:00Z'),
            ('fpB','claude_code','p','basename','p','subagent','legacy-child',1.0,'2026-01-01T00:00:00Z','2026-07-13T01:00:00Z')`,
  ).run();
  const addRun = raw.prepare(`INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,ended_at,status,tokens_by_model,tool_call_counts,models)
    VALUES (?,?,'m1',?,?,?,?,'{}','["claude-sonnet-5"]')`);
  addRun.run('rP', 'fpA', '2026-07-13T01:00:00Z', '2026-07-13T01:05:00Z', 'completed', JSON.stringify({ 'claude-sonnet-5': { input: 500, output: 100, cacheCreation: 0, cacheRead: 0 } }));
  addRun.run('rC', 'fpB', '2026-07-13T01:01:00Z', '2026-07-13T01:02:00Z', 'completed', JSON.stringify({ 'claude-sonnet-5': { input: 200, output: 50, cacheCreation: 0, cacheRead: 0 } }));
  // legacy spawn row: base DDL has NO prompt_chars / result_chars columns
  raw.prepare(`INSERT INTO spawns (parent_run_id,child_run_id,confidence) VALUES ('rP','rC',1.0)`).run();
  raw.close();
  return path;
}

describe('legacy db upgrade', () => {
  it('additive migrations run on open, preserving all existing rows', () => {
    const path = legacyDb();
    // sanity: the legacy file really lacks the new schema
    const pre = new Database(path);
    expect(pre.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_tags'`).get()).toBeUndefined();
    const preSpawnCols = (pre.prepare(`PRAGMA table_info(spawns)`).all() as any[]).map((c) => c.name);
    expect(preSpawnCols).not.toContain('prompt_chars');
    pre.close();

    // open with the current code — constructor runs the migrations
    const store = new FleetStore(path);
    const cols = (store.db.prepare(`PRAGMA table_info(spawns)`).all() as any[]).map((c) => c.name);
    expect(cols).toContain('prompt_chars');
    expect(cols).toContain('result_chars');
    expect(store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_tags'`).get()).toBeTruthy();

    // old data intact
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as any).n).toBe(2);
    expect((store.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as any).n).toBe(2);
    const spawn = store.db.prepare(`SELECT prompt_chars, result_chars FROM spawns WHERE parent_run_id='rP'`).get() as any;
    expect(spawn.prompt_chars).toBeNull(); // legacy edge: payload unknown, not faked to 0
    expect(spawn.result_chars).toBeNull();
    store.close();
  });

  it('new features work against the upgraded db (graph + tags)', () => {
    const path = legacyDb();
    new FleetStore(path).close(); // migrate

    // agentGraph reads the just-added payload columns without crashing
    const readDb = new Database(path, { readonly: true });
    const g = agentGraph(readDb);
    expect(g.edges.length).toBe(1);
    expect(g.edges[0]!.dataDown).toBeNull(); // legacy edge has no payload
    expect(g.edges[0]!.spawns).toBe(1);
    readDb.close();

    // tagging (new feature) works on the upgraded db
    addTag(path, 'legacy-parent', 'migrated');
    const rw = new Database(path);
    expect(tagsFor(rw, 'fpA')).toContain('migrated');
    rw.close();
  });

  it('re-opening an already-migrated db is a no-op (idempotent)', () => {
    const path = legacyDb();
    new FleetStore(path).close();
    // second open must not throw on the ALTER/CREATE-again
    expect(() => { new FleetStore(path).close(); }).not.toThrow();
  });
});
