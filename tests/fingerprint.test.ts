import { describe, it, expect } from 'vitest';
import { agentFingerprint, normalizeProjectIdentity } from '../packages/schema/src/fingerprint.js';

describe('normalizeProjectIdentity', () => {
  it('matches ssh and https forms of the same repo', () => {
    expect(normalizeProjectIdentity('git@github.com:ANVEAI/fleet.git')).toBe(
      normalizeProjectIdentity('https://github.com/ANVEAI/fleet'),
    );
  });
  it('strips trailing .git and slash, lowercases', () => {
    expect(normalizeProjectIdentity('https://GitHub.com/Org/Repo.git/')).toBe('github.com/org/repo');
  });
});

describe('agentFingerprint', () => {
  const base = {
    vendor: 'claude_code' as const,
    projectIdentity: 'git@github.com:org/repo.git',
    projectIdentitySource: 'git_remote' as const,
    agentName: 'repo',
    triggerSource: 'scheduled' as const,
  };

  it('is machine-independent: same repo via different remote forms -> same fingerprint', () => {
    const a = agentFingerprint(base);
    const b = agentFingerprint({ ...base, projectIdentity: 'https://github.com/org/repo' });
    expect(a).toBe(b);
  });

  it('differs by trigger source (cron agent != interactive agent, by design)', () => {
    expect(agentFingerprint(base)).not.toBe(agentFingerprint({ ...base, triggerSource: 'interactive' }));
  });

  it('differs by vendor', () => {
    expect(agentFingerprint(base)).not.toBe(agentFingerprint({ ...base, vendor: 'codex' }));
  });
});
