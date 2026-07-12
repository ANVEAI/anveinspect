import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetStore } from '../packages/collector/src/store.js';
import { recentActivity } from '../packages/collector/src/queries.js';

describe('recentActivity', () => {
  it('returns runs newest-first with agent context and safe token parsing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'act-')), 'fleet.db');
    const s = new FleetStore(path);
    s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
    s.db.prepare(`INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at) VALUES ('fp','claude_code','p','basename','p','interactive','app',1.0,'2026-07-13T00:00:00Z')`).run();
    const addRun = s.db.prepare(`INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,status,tokens_by_model,tool_call_counts,models) VALUES (?,?,'m1',?,?,?,'{}','[]')`);
    addRun.run('old','fp','2026-07-10T01:00:00Z','completed',JSON.stringify({m:{input:100,output:50,cacheCreation:0,cacheRead:0}}));
    addRun.run('new','fp','2026-07-13T01:00:00Z','error','{bad json');  // malformed -> tokens null, no crash
    const runs = recentActivity(s.db, 10);
    s.close();
    expect(runs[0]!.runId).toBe('new');          // newest first
    expect(runs[0]!.tokens).toBeNull();          // malformed parsed safely
    expect(runs[1]!.tokens).toBe(150);           // 100 + 50
    expect(runs[0]!.machine).toBe('mbp');
  });
});
