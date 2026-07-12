import { describe, it, expect } from 'vitest';
import { probePlatforms, onboardReport } from '../packages/collector/src/onboard.js';
import { resolveViaCli } from '../packages/collector/src/cli-credentials.js';

describe('probePlatforms', () => {
  it('covers all 8 vendors with a valid status and actionable fix when not ready', () => {
    const probes = probePlatforms();
    const vendors = probes.map((p) => p.vendor).sort();
    expect(vendors).toEqual(['bedrock', 'claude_code', 'cloudflare', 'codex', 'foundry', 'hermes', 'openclaw', 'vertex']);
    for (const p of probes) {
      expect(['ready', 'needs_signin', 'cli_missing', 'not_present']).toContain(p.status);
      // anything not ready and not merely absent must tell the user how to fix it
      if (p.status === 'needs_signin' || p.status === 'cli_missing') {
        expect(p.fixCommand.length).toBeGreaterThan(0);
      }
      expect(['local-logs', 'local-dir', 'cli-auth-api']).toContain(p.collection);
    }
  });

  it('report summarizes ready vs needs-action without throwing', () => {
    const r = onboardReport();
    expect(typeof r.summary).toBe('string');
    expect(Array.isArray(r.ready)).toBe(true);
    expect(r.needsAction.every((p) => p.fixCommand.length > 0)).toBe(true);
  });
});

describe('resolveViaCli', () => {
  it('passes explicit config through untouched (no CLI call)', () => {
    const explicit = { region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 's' };
    const r = resolveViaCli('bedrock', explicit);
    expect(r.config).toEqual(explicit);
    expect(r.error).toBeNull();
  });

  it('returns an actionable error for an unknown-CLI vendor', () => {
    const r = resolveViaCli('foundry', undefined);
    expect(r.config).toBeNull();
    expect(r.error).toMatch(/explicit config|no CLI-auth/i);
  });
});
