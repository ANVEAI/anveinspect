import Database from 'better-sqlite3';

/**
 * Lineage — turn the recorded spawn edges (parent_run → child_run) into
 * navigable trees and fleet-wide lineage stats. This is what makes AnveInspect
 * an inventory *and* lineage platform: "what spawned what, and why."
 *
 *   run ──spawns──▶ run ──spawns──▶ run
 *    │ (agent)        │ (subagent)     │ (deeper subagent)
 *
 * Runs carry the agent identity + tokens + status; edges carry confidence.
 */

export interface LineageNode {
  runId: string;
  agentName: string;
  vendor: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  tokens: number | null;
  confidence: number; // edge confidence into this node (1.0 for roots)
  children: LineageNode[];
  descendantCount: number;
  subtreeTokens: number | null; // sum over subtree where token data exists
}

export interface LineageSummary {
  totalEdges: number;
  rootsWithChildren: number;
  maxDepth: number;
  widestFanout: { runId: string; agentName: string; children: number } | null;
  byVendor: { vendor: string; spawns: number }[];
}

function tokensOf(json: string | null): number | null {
  if (json === null) return null;
  try {
    let t = 0;
    for (const v of Object.values(JSON.parse(json)) as any[]) t += v.input + v.output;
    return t;
  } catch {
    return null; // malformed token blob -> unavailable, never crash the tree
  }
}

/** Load ALL spawn edges once into a parent→children adjacency map (avoids the
 *  N+1 of building a full tree per root just to count/measure descendants). */
function adjacency(db: Database.Database): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const e of db.prepare(`SELECT parent_run_id, child_run_id FROM spawns`).all() as any[]) {
    const list = m.get(e.parent_run_id);
    if (list) list.push(e.child_run_id);
    else m.set(e.parent_run_id, [e.child_run_id]);
  }
  return m;
}

/** Descendant count + subtree depth for a root, via BFS over the edge map. */
function descendantStats(adj: Map<string, string[]>, root: string): { descendants: number; depth: number } {
  let descendants = 0;
  let depth = 1;
  const seen = new Set<string>([root]);
  let frontier = [root];
  while (frontier.length) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const child of adj.get(node) ?? []) {
        if (seen.has(child)) continue; // cycle guard
        seen.add(child);
        descendants += 1;
        next.push(child);
      }
    }
    if (next.length) depth += 1;
    frontier = next;
  }
  return { descendants, depth };
}

/** Build the lineage tree rooted at a run id (or the parent of any run id). */
export function lineageTree(db: Database.Database, rootRunId: string, maxDepth = 8): LineageNode | null {
  const runStmt = db.prepare(
    `SELECT r.id, r.agent_fingerprint, r.started_at, r.status, r.tokens_by_model,
            a.display_name, a.vendor, a.trigger_source
     FROM runs r JOIN agents a ON a.fingerprint = r.agent_fingerprint WHERE r.id = ?`,
  );
  // LIMIT in SQL so a pathological parent never loads millions of rows before we slice
  const childStmt = db.prepare(`SELECT child_run_id, confidence FROM spawns WHERE parent_run_id = ? LIMIT 500`);

  function build(runId: string, confidence: number, depth: number, seen: Set<string>): LineageNode | null {
    if (seen.has(runId)) return null; // cycle guard (shouldn't happen, but never loop)
    seen.add(runId);
    const r = runStmt.get(runId) as any;
    if (!r) return null;
    const selfTokens = tokensOf(r.tokens_by_model);
    const children: LineageNode[] = [];
    if (depth < maxDepth) {
      const kids = childStmt.all(runId) as any[];
      for (const c of kids) {
        const node = build(c.child_run_id, c.confidence, depth + 1, seen);
        if (node) children.push(node);
      }
    }
    const descendantCount = children.reduce((s, c) => s + 1 + c.descendantCount, 0);
    const childTok = children.reduce<number | null>((s, c) => {
      if (c.subtreeTokens === null) return s;
      return (s ?? 0) + c.subtreeTokens;
    }, null);
    const subtreeTokens =
      selfTokens === null && childTok === null ? null : (selfTokens ?? 0) + (childTok ?? 0);
    return {
      runId,
      agentName: r.display_name,
      vendor: r.vendor,
      trigger: r.trigger_source,
      status: r.status,
      startedAt: r.started_at,
      tokens: selfTokens,
      confidence,
      children: children.sort((a, b) => (b.subtreeTokens ?? -1) - (a.subtreeTokens ?? -1)),
      descendantCount,
      subtreeTokens,
    };
  }
  return build(rootRunId, 1.0, 0, new Set());
}

/** The top lineage roots (runs that spawned children and are not themselves children).
 *  Uses the edge map + BFS (no per-root tree build), then hydrates only the top-N. */
export function topLineageRoots(db: Database.Database, limit = 20): { runId: string; agentName: string; vendor: string; startedAt: string | null; directChildren: number; descendantCount: number }[] {
  const adj = adjacency(db);
  const childSet = new Set<string>();
  for (const kids of adj.values()) for (const c of kids) childSet.add(c);
  const rootIds = [...adj.keys()].filter((id) => !childSet.has(id));
  const ranked = rootIds
    .map((runId) => ({ runId, directChildren: (adj.get(runId) ?? []).length, ...descendantStats(adj, runId) }))
    .sort((a, b) => b.descendants - a.descendants)
    .slice(0, limit); // hydrate names only for the top-N (cheap)
  const nameStmt = db.prepare(`SELECT a.display_name, a.vendor, r.started_at FROM runs r JOIN agents a ON a.fingerprint=r.agent_fingerprint WHERE r.id = ?`);
  return ranked.map((x) => {
    const r = nameStmt.get(x.runId) as any;
    return {
      runId: x.runId,
      agentName: r?.display_name ?? x.runId,
      vendor: r?.vendor ?? 'unknown',
      startedAt: r?.started_at ?? null,
      directChildren: x.directChildren,
      descendantCount: x.descendants,
    };
  });
}

export type ActivityStatus = 'active' | 'idle' | 'stale';

export interface AgentGraphNode {
  fingerprint: string;
  name: string;
  vendor: string;
  runs: number; // total recorded runs for this agent
  spawnsOut: number; // times this agent spawned another agent
  spawnsIn: number; // times this agent was spawned by another agent
  lastRunAt: string | null;
  status: ActivityStatus; // active = ran <24h ago · idle = 1-7d · stale = >7d / never
}

export interface AgentGraphEdge {
  source: string; // parent agent fingerprint
  target: string; // child agent fingerprint
  spawns: number; // how many parent-run -> child-run edges collapse into this pair
  lastSpawnAt: string | null;
  tokens: number | null; // total tokens the child consumed across this relationship (null = unavailable)
  dataDown: number | null; // total chars the parent sent down (null = no payload data captured yet)
  dataUp: number | null; // total chars the child returned up
}

export interface AgentGraph {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  truncated: boolean; // true if edges were capped — the graph shows the heaviest relationships
}

function activityStatus(lastRunAt: string | null, now: number): ActivityStatus {
  if (!lastRunAt) return 'stale';
  const age = now - Date.parse(lastRunAt);
  if (Number.isNaN(age)) return 'stale';
  if (age <= 24 * 3_600_000) return 'active';
  if (age <= 7 * 86_400_000) return 'idle';
  return 'stale';
}

/** Agent-to-agent relationship graph: collapse run-level spawn edges onto agent
 *  identities. This is the "who works with whom" view — run trees show one
 *  execution; this shows the standing relationships across ALL executions.
 *  Edges carry HOW the pair shares work: spawn count, tokens the child burned,
 *  and payload volume in both directions (parent prompt down / child result up). */
export function agentGraph(db: Database.Database, maxEdges = 150, now = new Date()): AgentGraph {
  // per-spawn rows (not GROUP BY): child token blobs are JSON, so aggregate in JS
  const rows = db
    .prepare(
      `SELECT pr.agent_fingerprint AS pfp, cr.agent_fingerprint AS cfp,
              cr.started_at AS child_started_at, cr.tokens_by_model AS child_tokens,
              s.prompt_chars, s.result_chars
       FROM spawns s
       JOIN runs pr ON pr.id = s.parent_run_id
       JOIN runs cr ON cr.id = s.child_run_id`,
    )
    .all() as any[];
  type Pair = { pfp: string; cfp: string; spawns: number; lastSpawnAt: string | null; tokens: number | null; dataDown: number | null; dataUp: number | null };
  const pairs = new Map<string, Pair>();
  for (const r of rows) {
    const key = `${r.pfp} ${r.cfp}`;
    const p = pairs.get(key) ?? { pfp: r.pfp, cfp: r.cfp, spawns: 0, lastSpawnAt: null, tokens: null, dataDown: null, dataUp: null };
    p.spawns += 1;
    if (r.child_started_at && (!p.lastSpawnAt || r.child_started_at > p.lastSpawnAt)) p.lastSpawnAt = r.child_started_at;
    const tok = tokensOf(r.child_tokens);
    if (tok !== null) p.tokens = (p.tokens ?? 0) + tok; // unavailable stays null, never fake 0
    if (typeof r.prompt_chars === 'number') p.dataDown = (p.dataDown ?? 0) + r.prompt_chars;
    if (typeof r.result_chars === 'number') p.dataUp = (p.dataUp ?? 0) + r.result_chars;
    pairs.set(key, p);
  }
  const ranked = [...pairs.values()].sort((a, b) => b.spawns - a.spawns);
  const truncated = ranked.length > maxEdges;
  const kept = ranked.slice(0, maxEdges); // keep the heaviest relationships, never an unrenderable hairball
  const fps = new Set<string>();
  for (const e of kept) { fps.add(e.pfp); fps.add(e.cfp); }
  if (fps.size === 0) return { nodes: [], edges: [], truncated: false };
  const placeholders = [...fps].map(() => '?').join(',');
  const agentRows = db
    .prepare(
      `SELECT a.fingerprint, a.display_name, a.vendor, a.last_run_at,
              (SELECT COUNT(*) FROM runs r WHERE r.agent_fingerprint = a.fingerprint) AS runs
       FROM agents a WHERE a.fingerprint IN (${placeholders})`,
    )
    .all(...fps) as any[];
  const nowMs = now.getTime();
  const nodes = new Map<string, AgentGraphNode>(
    agentRows.map((a) => [a.fingerprint, {
      fingerprint: a.fingerprint, name: a.display_name, vendor: a.vendor, runs: a.runs,
      spawnsOut: 0, spawnsIn: 0, lastRunAt: a.last_run_at ?? null,
      status: activityStatus(a.last_run_at ?? null, nowMs),
    }]),
  );
  const edges: AgentGraphEdge[] = [];
  for (const e of kept) {
    const p = nodes.get(e.pfp);
    const c = nodes.get(e.cfp);
    if (!p || !c) continue; // agent row vanished mid-read — skip the edge, never crash
    p.spawnsOut += e.spawns;
    c.spawnsIn += e.spawns;
    edges.push({ source: e.pfp, target: e.cfp, spawns: e.spawns, lastSpawnAt: e.lastSpawnAt, tokens: e.tokens, dataDown: e.dataDown, dataUp: e.dataUp });
  }
  return { nodes: [...nodes.values()], edges, truncated };
}

export interface SubagentHealth {
  total: number; // agents that exist because another agent spawned them
  active: number; // ran within the last 24h
  idle: number; // 1-7 days quiet
  stale: number; // >7 days quiet (or never ran)
}

/** Health of the subagent population — "how alive is the delegated workforce". */
export function subagentHealth(db: Database.Database, now = new Date()): SubagentHealth {
  const rows = db
    .prepare(`SELECT last_run_at FROM agents WHERE trigger_source = 'subagent'`)
    .all() as any[];
  const nowMs = now.getTime();
  const out: SubagentHealth = { total: rows.length, active: 0, idle: 0, stale: 0 };
  for (const r of rows) out[activityStatus(r.last_run_at ?? null, nowMs)] += 1;
  return out;
}

export interface TimelineRow {
  runId: string;
  agentName: string;
  vendor: string;
  isRoot: boolean;
  startedAt: string | null;
  endedAt: string | null;
  status: string;
  tokens: number | null;
  promptChars: number | null; // payload the parent sent this run (null for the root / unknown)
  resultChars: number | null; // payload this run returned to its parent
}

/** Temporal view of one execution: WHEN the main agent was active and when each
 *  subagent was active, with tokens + payload sizes. Rows are Gantt-ready. */
export function runTimeline(db: Database.Database, rootRunId: string, maxRows = 80): TimelineRow[] {
  const runStmt = db.prepare(
    `SELECT r.id, r.started_at, r.ended_at, r.status, r.tokens_by_model, a.display_name, a.vendor
     FROM runs r JOIN agents a ON a.fingerprint = r.agent_fingerprint WHERE r.id = ?`,
  );
  const childStmt = db.prepare(
    `SELECT child_run_id, prompt_chars, result_chars FROM spawns WHERE parent_run_id = ? LIMIT 500`,
  );
  const root = runStmt.get(rootRunId) as any;
  if (!root) return [];
  const rows: TimelineRow[] = [];
  const seen = new Set<string>();
  const push = (r: any, isRoot: boolean, promptChars: number | null, resultChars: number | null) => {
    rows.push({
      runId: r.id, agentName: r.display_name, vendor: r.vendor, isRoot,
      startedAt: r.started_at, endedAt: r.ended_at, status: r.status,
      tokens: tokensOf(r.tokens_by_model), promptChars, resultChars,
    });
  };
  push(root, true, null, null);
  seen.add(rootRunId);
  // BFS the spawn tree so nested subagents land on the timeline too
  let frontier = [rootRunId];
  while (frontier.length && rows.length < maxRows) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const c of childStmt.all(id) as any[]) {
        if (seen.has(c.child_run_id) || rows.length >= maxRows) continue;
        seen.add(c.child_run_id);
        const r = runStmt.get(c.child_run_id) as any;
        if (!r) continue;
        push(r, false, c.prompt_chars ?? null, c.result_chars ?? null);
        next.push(c.child_run_id);
      }
    }
    frontier = next;
  }
  // chronological: the Gantt reads top-down in start order, root pinned first
  const [first, ...rest] = rows;
  rest.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  return [first!, ...rest];
}

export function lineageSummary(db: Database.Database): LineageSummary {
  const totalEdges = (db.prepare(`SELECT COUNT(*) AS n FROM spawns`).get() as any).n;
  const roots = db
    .prepare(`SELECT DISTINCT parent_run_id FROM spawns WHERE parent_run_id NOT IN (SELECT child_run_id FROM spawns)`)
    .all() as any[];
  let maxDepth = 0;
  let widest: { runId: string; agentName: string; children: number } | null = null;
  const fanout = db
    .prepare(`SELECT parent_run_id, COUNT(*) AS n FROM spawns GROUP BY parent_run_id ORDER BY n DESC LIMIT 1`)
    .get() as any;
  if (fanout) {
    const r = db.prepare(`SELECT a.display_name FROM runs r JOIN agents a ON a.fingerprint=r.agent_fingerprint WHERE r.id=?`).get(fanout.parent_run_id) as any;
    widest = { runId: fanout.parent_run_id, agentName: r?.display_name ?? fanout.parent_run_id, children: fanout.n };
  }
  // depth via edge-map BFS over ALL roots (cheap; no per-root tree build)
  const adj = adjacency(db);
  const childSet = new Set<string>();
  for (const kids of adj.values()) for (const c of kids) childSet.add(c);
  for (const id of adj.keys()) {
    if (childSet.has(id)) continue; // only true roots
    const d = descendantStats(adj, id).depth;
    if (d > maxDepth) maxDepth = d;
  }
  const byVendor = (db
    .prepare(
      `SELECT a.vendor AS vendor, COUNT(*) AS spawns FROM spawns s
       JOIN runs r ON r.id = s.parent_run_id JOIN agents a ON a.fingerprint = r.agent_fingerprint
       GROUP BY a.vendor ORDER BY spawns DESC`,
    )
    .all() as any[]).map((r) => ({ vendor: r.vendor, spawns: r.spawns }));
  return { totalEdges, rootsWithChildren: roots.length, maxDepth, widestFanout: widest, byVendor };
}

