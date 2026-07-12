import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetStore } from '../packages/collector/src/store.js';
import { lineageTree, topLineageRoots, lineageSummary } from '../packages/collector/src/lineage.js';

function seed() {
  const path = join(mkdtempSync(join(tmpdir(), 'lin-')), 'fleet.db');
  const s = new FleetStore(path);
  s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
  const addAgent = s.db.prepare(
    `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at)
     VALUES (?,?,?,?,?,?,?,1.0,'2026-07-13T00:00:00Z')`);
  addAgent.run('fp-root','claude_code','proj','basename','proj','interactive','root-session');
  addAgent.run('fp-sub','claude_code','proj','basename','sub','subagent','general-purpose');
  const addRun = s.db.prepare(
    `INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,status,tokens_by_model,tool_call_counts,models)
     VALUES (?,?,'m1',?,?,?,'{}','[]')`);
  const tok = (n:number)=>JSON.stringify({m:{input:n,output:0,cacheCreation:0,cacheRead:0}});
  addRun.run('root','fp-root','2026-07-13T01:00:00Z','completed',tok(1000));
  addRun.run('root/c1','fp-sub','2026-07-13T01:01:00Z','completed',tok(500));
  addRun.run('root/c2','fp-sub','2026-07-13T01:02:00Z','error',tok(300));
  addRun.run('root/c1/g1','fp-sub','2026-07-13T01:03:00Z','completed',tok(200)); // grandchild
  s.db.prepare(`INSERT INTO spawns VALUES ('root','root/c1',1.0),('root','root/c2',1.0),('root/c1','root/c1/g1',1.0)`).run();
  return s;
}

describe('lineageTree', () => {
  it('builds a nested tree with subtree token rollup and descendant counts', () => {
    const s = seed();
    const tree = lineageTree(s.db, 'root', 8)!;
    s.close();
    expect(tree.agentName).toBe('root-session');
    expect(tree.children).toHaveLength(2);
    expect(tree.descendantCount).toBe(3); // c1, c2, g1
    expect(tree.subtreeTokens).toBe(2000); // 1000 + 500 + 300 + 200
    const c1 = tree.children.find(c=>c.runId==='root/c1')!;
    expect(c1.children).toHaveLength(1);
    expect(c1.subtreeTokens).toBe(700); // 500 + 200
  });

  it('children sort by subtree tokens desc (biggest cost first)', () => {
    const s = seed();
    const tree = lineageTree(s.db, 'root', 8)!;
    s.close();
    expect(tree.children[0]!.runId).toBe('root/c1'); // 700 > 300
  });

  it('returns null for an unknown run', () => {
    const s = seed();
    expect(lineageTree(s.db, 'nope', 8)).toBeNull();
    s.close();
  });
});

describe('topLineageRoots + summary', () => {
  it('finds roots (parents that are not children) ranked by descendants', () => {
    const s = seed();
    const roots = topLineageRoots(s.db, 10);
    const summary = lineageSummary(s.db);
    s.close();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.runId).toBe('root');
    expect(roots[0]!.descendantCount).toBe(3);
    expect(summary.totalEdges).toBe(3);
    expect(summary.rootsWithChildren).toBe(1);
    expect(summary.maxDepth).toBe(3); // root -> c1 -> g1
    expect(summary.widestFanout?.children).toBe(2);
  });
});
