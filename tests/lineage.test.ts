import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetStore } from '../packages/collector/src/store.js';
import { lineageTree, topLineageRoots, lineageSummary, agentGraph, subagentHealth, runTimeline } from '../packages/collector/src/lineage.js';

function seed() {
  const path = join(mkdtempSync(join(tmpdir(), 'lin-')), 'fleet.db');
  const s = new FleetStore(path);
  s.db.prepare(`INSERT INTO machines (id,label) VALUES ('m1','mbp')`).run();
  const addAgent = s.db.prepare(
    `INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at,last_run_at)
     VALUES (?,?,?,?,?,?,?,1.0,'2026-07-13T00:00:00Z',?)`);
  addAgent.run('fp-root','claude_code','proj','basename','proj','interactive','root-session','2026-07-13T01:10:00Z');
  addAgent.run('fp-sub','claude_code','proj','basename','sub','subagent','general-purpose','2026-07-13T01:03:00Z');
  const addRun = s.db.prepare(
    `INSERT INTO runs (id,agent_fingerprint,machine_id,started_at,ended_at,status,tokens_by_model,tool_call_counts,models)
     VALUES (?,?,'m1',?,?,?,?,'{}','[]')`);
  const tok = (n:number)=>JSON.stringify({m:{input:n,output:0,cacheCreation:0,cacheRead:0}});
  addRun.run('root','fp-root','2026-07-13T01:00:00Z','2026-07-13T01:10:00Z','completed',tok(1000));
  addRun.run('root/c1','fp-sub','2026-07-13T01:01:00Z','2026-07-13T01:04:00Z','completed',tok(500));
  addRun.run('root/c2','fp-sub','2026-07-13T01:02:00Z',null,'error',tok(300));
  addRun.run('root/c1/g1','fp-sub','2026-07-13T01:03:00Z','2026-07-13T01:03:30Z','completed',tok(200)); // grandchild
  // spawn edges carry the data-sharing payload: prompt chars down, result chars up
  s.db.prepare(`INSERT INTO spawns (parent_run_id,child_run_id,confidence,prompt_chars,result_chars) VALUES
    ('root','root/c1',1.0,100,2000),('root','root/c2',1.0,150,NULL),('root/c1','root/c1/g1',1.0,50,400)`).run();
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

describe('agentGraph', () => {
  it('collapses run-level spawn edges onto agent identities with counts', () => {
    const s = seed();
    const g = agentGraph(s.db);
    s.close();
    expect(g.nodes).toHaveLength(2); // root-session + general-purpose
    expect(g.truncated).toBe(false);
    // root->c1 and root->c2 collapse to ONE agent edge with spawns=2; c1->g1 is sub->sub (self edge)
    const rootToSub = g.edges.find((e) => e.source === 'fp-root' && e.target === 'fp-sub')!;
    expect(rootToSub.spawns).toBe(2);
    const subToSub = g.edges.find((e) => e.source === 'fp-sub' && e.target === 'fp-sub')!;
    expect(subToSub.spawns).toBe(1); // same-agent spawn is a real relationship (self loop)
    const root = g.nodes.find((n) => n.fingerprint === 'fp-root')!;
    expect(root.spawnsOut).toBe(2);
    expect(root.spawnsIn).toBe(0);
    const sub = g.nodes.find((n) => n.fingerprint === 'fp-sub')!;
    expect(sub.spawnsIn).toBe(3); // spawned twice by root + once by itself
  });

  it('caps edges and reports truncation instead of returning a hairball', () => {
    const s = seed();
    const g = agentGraph(s.db, 1); // force the cap below the real edge count
    s.close();
    expect(g.edges).toHaveLength(1);
    expect(g.truncated).toBe(true);
    expect(g.edges[0]!.spawns).toBe(2); // keeps the HEAVIEST relationship
  });

  it('returns an empty graph when there are no spawns', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'nog-')), 'fleet.db');
    const s = new FleetStore(path);
    const g = agentGraph(s.db);
    s.close();
    expect(g).toEqual({ nodes: [], edges: [], truncated: false });
  });

  it('edges carry data-sharing metrics: child tokens, payload down/up', () => {
    const s = seed();
    const g = agentGraph(s.db, 150, new Date('2026-07-13T02:00:00Z'));
    s.close();
    const e = g.edges.find((x) => x.source === 'fp-root' && x.target === 'fp-sub')!;
    expect(e.tokens).toBe(800); // c1 (500) + c2 (300) — the child's consumption across the relationship
    expect(e.dataDown).toBe(250); // 100 + 150 chars sent down
    expect(e.dataUp).toBe(2000); // only c1 returned; NULL result never fakes a 0
    const self = g.edges.find((x) => x.source === 'fp-sub' && x.target === 'fp-sub')!;
    expect(self.dataDown).toBe(50);
    expect(self.dataUp).toBe(400);
  });

  it('nodes carry activity status relative to now', () => {
    const s = seed();
    const fresh = agentGraph(s.db, 150, new Date('2026-07-13T12:00:00Z')); // hours after last run
    const later = agentGraph(s.db, 150, new Date('2026-07-16T12:00:00Z')); // 3 days after
    const muchLater = agentGraph(s.db, 150, new Date('2026-08-01T00:00:00Z')); // weeks after
    s.close();
    expect(fresh.nodes.find((n) => n.fingerprint === 'fp-sub')!.status).toBe('active');
    expect(later.nodes.find((n) => n.fingerprint === 'fp-sub')!.status).toBe('idle');
    expect(muchLater.nodes.find((n) => n.fingerprint === 'fp-sub')!.status).toBe('stale');
  });
});

describe('subagentHealth', () => {
  it('buckets subagent-triggered agents by recency', () => {
    const s = seed();
    const h = subagentHealth(s.db, new Date('2026-07-13T12:00:00Z'));
    s.close();
    // only fp-sub has trigger_source=subagent; it ran 11h ago -> active
    expect(h).toEqual({ total: 1, active: 1, idle: 0, stale: 0 });
  });
});

describe('runTimeline', () => {
  it('returns root first then descendants chronologically, with payloads', () => {
    const s = seed();
    const t = runTimeline(s.db, 'root');
    s.close();
    expect(t).toHaveLength(4); // root + c1 + c2 + g1 (BFS reaches the grandchild)
    expect(t[0]!.isRoot).toBe(true);
    expect(t[0]!.runId).toBe('root');
    expect(t.slice(1).map((r) => r.runId)).toEqual(['root/c1', 'root/c2', 'root/c1/g1']); // start order
    const c1 = t.find((r) => r.runId === 'root/c1')!;
    expect(c1.promptChars).toBe(100);
    expect(c1.resultChars).toBe(2000);
    expect(c1.tokens).toBe(500);
    const c2 = t.find((r) => r.runId === 'root/c2')!;
    expect(c2.endedAt).toBeNull(); // open-ended run stays open — the UI draws it dashed
  });

  it('returns [] for an unknown root', () => {
    const s = seed();
    expect(runTimeline(s.db, 'nope')).toEqual([]);
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
