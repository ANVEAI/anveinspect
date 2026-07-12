import { describe, it, expect } from 'vitest';
import { probePlatforms, onboardReport, type CliRunner } from '../packages/collector/src/onboard.js';
import { resolveViaCli } from '../packages/collector/src/cli-credentials.js';

/**
 * Deterministic onboarding tests: inject a fake CLI runner + fs probe so the
 * result never depends on this machine's live CLI auth state (which is slow and
 * flaky under concurrency). The real-machine path is exercised by `doctor`.
 */

// nothing installed, nothing signed in, no local dirs
const bareRun: CliRunner = () => ({ ok: false, out: '' });
const bareDeps = { run: bareRun, exists: () => false };

// everything installed + authed + local dirs present
const fullRun: CliRunner = (cmd, args) => {
  if (cmd === 'command' || cmd === 'which') return { ok: true, out: '/usr/bin/x' }; // has(...)
  if (cmd === 'gcloud' && args.includes('project')) return { ok: true, out: 'my-project' };
  if (cmd === 'wrangler') return { ok: true, out: 'account email test@x.com' };
  return { ok: true, out: 'ok' };
};
const fullDeps = { run: fullRun, exists: () => true };

describe('probePlatforms', () => {
  it('covers all 8 vendors with valid enums (bare machine)', () => {
    const probes = probePlatforms(bareDeps);
    expect(probes.map((p) => p.vendor).sort()).toEqual(
      ['bedrock', 'claude_code', 'cloudflare', 'codex', 'foundry', 'hermes', 'openclaw', 'vertex'],
    );
    for (const p of probes) {
      expect(['ready', 'needs_signin', 'cli_missing', 'not_present']).toContain(p.status);
      expect(['local-logs', 'local-dir', 'cli-auth-api']).toContain(p.collection);
    }
  });

  it('INVARIANT: every needs_signin / cli_missing probe carries a non-empty fix command', () => {
    for (const deps of [bareDeps, fullDeps, { run: bareRun, exists: () => true }]) {
      for (const p of probePlatforms(deps)) {
        if (p.status === 'needs_signin' || p.status === 'cli_missing') {
          expect(p.fixCommand.length, `${p.vendor} needs a fix command`).toBeGreaterThan(0);
        }
        if (p.status === 'ready') expect(p.fixCommand).toBe('');
      }
    }
  });

  it('bare machine: cloud vendors are cli_missing with install links; locals not_present', () => {
    const probes = probePlatforms(bareDeps);
    const byV = Object.fromEntries(probes.map((p) => [p.vendor, p]));
    expect(byV.claude_code!.status).toBe('not_present');
    expect(byV.vertex!.status).toBe('cli_missing');
    expect(byV.vertex!.fixCommand).toMatch(/cloud.google.com/);
  });

  it('fully-authed machine: locals ready, gcloud->vertex ready, wrangler->cloudflare ready', () => {
    const probes = probePlatforms(fullDeps);
    const byV = Object.fromEntries(probes.map((p) => [p.vendor, p]));
    expect(byV.claude_code!.status).toBe('ready');
    expect(byV.vertex!.status).toBe('ready');
    expect(byV.vertex!.detail).toContain('my-project');
    expect(byV.cloudflare!.status).toBe('ready');
  });

  it('report summarizes ready vs needs-action', () => {
    const r = onboardReport(fullDeps);
    expect(typeof r.summary).toBe('string');
    expect(r.ready).toContain('Claude Code');
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
