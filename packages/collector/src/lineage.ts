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
  const childStmt = db.prepare(`SELECT child_run_id, confidence FROM spawns WHERE parent_run_id = ?`);

  function build(runId: string, confidence: number, depth: number, seen: Set<string>): LineageNode | null {
    if (seen.has(runId)) return null; // cycle guard (shouldn't happen, but never loop)
    seen.add(runId);
    const r = runStmt.get(runId) as any;
    if (!r) return null;
    const selfTokens = tokensOf(r.tokens_by_model);
    const children: LineageNode[] = [];
    if (depth < maxDepth) {
      // cap children per node so a pathological fan-out can't build an unbounded tree
      const kids = (childStmt.all(runId) as any[]).slice(0, 500);
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

