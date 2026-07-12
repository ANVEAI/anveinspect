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
  let t = 0;
  for (const v of Object.values(JSON.parse(json)) as any[]) t += v.input + v.output;
  return t;
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
      for (const c of childStmt.all(runId) as any[]) {
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

/** The top lineage roots (runs that spawned children and are not themselves children). */
export function topLineageRoots(db: Database.Database, limit = 20): { runId: string; agentName: string; vendor: string; startedAt: string | null; directChildren: number; descendantCount: number }[] {
  const roots = db
    .prepare(
      `SELECT DISTINCT s.parent_run_id AS run_id FROM spawns s
       WHERE s.parent_run_id NOT IN (SELECT child_run_id FROM spawns)`,
    )
    .all() as any[];
  const out = roots.map((row) => {
    const tree = lineageTree(db, row.run_id, 8);
    const r = db
      .prepare(`SELECT a.display_name, a.vendor, r.started_at FROM runs r JOIN agents a ON a.fingerprint=r.agent_fingerprint WHERE r.id = ?`)
      .get(row.run_id) as any;
    return {
      runId: row.run_id,
      agentName: r?.display_name ?? row.run_id,
      vendor: r?.vendor ?? 'unknown',
      startedAt: r?.started_at ?? null,
      directChildren: tree?.children.length ?? 0,
      descendantCount: tree?.descendantCount ?? 0,
    };
  });
  return out.sort((a, b) => b.descendantCount - a.descendantCount).slice(0, limit);
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
  // depth via bounded sampling of roots (avoids a recursive CTE for portability)
  for (const root of roots.slice(0, 50)) {
    const tree = lineageTree(db, root.parent_run_id, 12);
    const d = depthOf(tree);
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

function depthOf(n: LineageNode | null): number {
  if (!n || !n.children.length) return 1;
  return 1 + Math.max(...n.children.map(depthOf));
}
