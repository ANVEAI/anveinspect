import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FleetStore } from '../packages/collector/src/store.js';
import { addTag, removeTag, tagsFor, tagSummary, allTags } from '../packages/collector/src/tags.js';

function seed() {
  const path = join(mkdtempSync(join(tmpdir(), 'tag-')), 'fleet.db');
  const s = new FleetStore(path);
  s.db.prepare(`INSERT INTO agents (fingerprint,vendor,project_identity,project_identity_source,agent_name,trigger_source,display_name,identity_confidence,first_seen_at) VALUES ('fp1','claude_code','p','basename','p','interactive','alpha',1.0,'2026-07-13T00:00:00Z'),('fp2','codex','q','basename','q','interactive','beta',1.0,'2026-07-13T00:00:00Z')`).run();
  s.close();
  return path;
}

describe('agent tags (local control metadata)', () => {
  it('adds, normalizes, dedups, and lists tags', () => {
    const path = seed();
    addTag(path, 'alpha', 'Production'); // normalized to lowercase
    addTag(path, 'alpha', 'production'); // dedup
    addTag(path, 'alpha', 'critical tier'); // spaces -> dashes
    const s = new FleetStore(path);
    expect(tagsFor(s.db, 'fp1').sort()).toEqual(['critical-tier', 'production']);
    s.close();
  });
  it('removes tags and reports whether anything changed', () => {
    const path = seed();
    addTag(path, 'alpha', 'x');
    expect(removeTag(path, 'alpha', 'x')).toBe(true);
    expect(removeTag(path, 'alpha', 'x')).toBe(false);
  });
  it('summary counts across the fleet; allTags maps fingerprints', () => {
    const path = seed();
    addTag(path, 'alpha', 'prod'); addTag(path, 'beta', 'prod'); addTag(path, 'beta', 'exp');
    const s = new FleetStore(path);
    expect(tagSummary(s.db)).toEqual([{ tag: 'prod', count: 2 }, { tag: 'exp', count: 1 }]);
    expect(allTags(s.db).get('fp2')!.sort()).toEqual(['exp', 'prod']);
    s.close();
  });
  it('rejects unknown agent + empty tag', () => {
    const path = seed();
    expect(() => addTag(path, 'nope', 'x')).toThrow(/No agent/);
    expect(() => addTag(path, 'alpha', '  ')).toThrow(/empty/);
  });
});
