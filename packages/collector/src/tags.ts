import Database from 'better-sqlite3';

/**
 * Agent tags — LOCAL control metadata (cohorts, tiers, ownership, "retire?").
 * Write-only to the local fleet db; never calls any platform API or changes
 * agent behavior. This is the safe first slice of "control from the dashboard":
 * organize and annotate the fleet, don't mutate remote systems.
 */

/** Write-mode open with friendly missing-db guidance (kept local — queries.ts imports this module). */
function openTagsDb(dbPath: string): Database.Database {
  try {
    return new Database(dbPath, { fileMustExist: true });
  } catch {
    throw new Error(
      `No fleet database at ${dbPath}. Run "anveinspect scan" first (or set ANVEINSPECT_DB to point at one).`,
    );
  }
}

const TAGS_DDL = `CREATE TABLE IF NOT EXISTS agent_tags (
  agent_fingerprint TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_fingerprint, tag)
)`;

/** Ensure the tags table exists on a writable handle (old DBs created before this migration). */
function ensureTagsTable(db: Database.Database): void {
  db.exec(TAGS_DDL);
}

function resolveFingerprint(db: Database.Database, nameOrFp: string): string {
  const a = db
    .prepare(`SELECT fingerprint FROM agents WHERE fingerprint = ? OR display_name = ? ORDER BY last_run_at DESC LIMIT 1`)
    .get(nameOrFp, nameOrFp) as any;
  if (!a) throw new Error(`No agent named "${nameOrFp}". Check the name with the agents list.`);
  return a.fingerprint;
}

export function addTag(dbPath: string, agentNameOrFp: string, tag: string): { agent: string; tag: string } {
  const clean = tag.trim().toLowerCase().replace(/\s+/g, '-');
  if (!clean) throw new Error('tag cannot be empty');
  const db = openTagsDb(dbPath);
  try {
    ensureTagsTable(db);
    const fp = resolveFingerprint(db, agentNameOrFp);
    db.prepare(`INSERT OR IGNORE INTO agent_tags (agent_fingerprint, tag, created_at) VALUES (?, ?, datetime('now'))`).run(fp, clean);
    return { agent: agentNameOrFp, tag: clean };
  } finally {
    db.close();
  }
}

export function removeTag(dbPath: string, agentNameOrFp: string, tag: string): boolean {
  const db = openTagsDb(dbPath);
  try {
    ensureTagsTable(db);
    const fp = resolveFingerprint(db, agentNameOrFp);
    const res = db.prepare(`DELETE FROM agent_tags WHERE agent_fingerprint = ? AND tag = ?`).run(fp, tag.trim().toLowerCase());
    return res.changes > 0;
  } finally {
    db.close();
  }
}

/** True if agent_tags exists — a read-only handle on a DB predating the migration won't have it. */
function tagsTableExists(db: Database.Database): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_tags'`).get();
}

export function tagsFor(db: Database.Database, fingerprint: string): string[] {
  if (!tagsTableExists(db)) return [];
  return (db.prepare(`SELECT tag FROM agent_tags WHERE agent_fingerprint = ? ORDER BY tag`).all(fingerprint) as any[]).map((r) => r.tag);
}

/** fingerprint -> tags map for the whole fleet (one query; used to decorate lists). */
export function allTags(db: Database.Database): Map<string, string[]> {
  const m = new Map<string, string[]>();
  if (!tagsTableExists(db)) return m;
  for (const r of db.prepare(`SELECT agent_fingerprint, tag FROM agent_tags ORDER BY tag`).all() as any[]) {
    const list = m.get(r.agent_fingerprint);
    if (list) list.push(r.tag);
    else m.set(r.agent_fingerprint, [r.tag]);
  }
  return m;
}

/** Distinct tags across the fleet with usage counts (for filter chips). */
export function tagSummary(db: Database.Database): { tag: string; count: number }[] {
  if (!tagsTableExists(db)) return [];
  return (db.prepare(`SELECT tag, COUNT(*) AS count FROM agent_tags GROUP BY tag ORDER BY count DESC, tag`).all() as any[])
    .map((r) => ({ tag: r.tag, count: r.count }));
}
