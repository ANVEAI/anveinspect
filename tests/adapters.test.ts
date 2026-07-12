import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bedrockAdapter, foundryAdapter, cloudflareAdapter, openclawAdapter,
  ConnectorAuthError, type AdapterContext,
} from '../packages/adapters/src/index.js';

const NOW = new Date('2026-07-13T10:00:00Z');

function fakeFetch(routes: (url: string, init?: any) => { status: number; json: unknown }): AdapterContext {
  const fetchImpl = (async (url: any, init?: any) => {
    const r = routes(String(url), init);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
  return { fetch: fetchImpl, now: () => NOW };
}

const AWS = { region: 'us-east-1', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };

describe('bedrockAdapter', () => {
  it('paginates to completion and normalizes agents', async () => {
    let call = 0;
    const ctx = fakeFetch((url, init) => {
      expect(url).toBe('https://bedrock-agent.us-east-1.amazonaws.com/agents/');
      expect(init.headers.authorization).toContain('AWS4-HMAC-SHA256');
      call += 1;
      return call === 1
        ? { status: 200, json: { agentSummaries: [{ agentId: 'A1', agentName: 'router', agentStatus: 'PREPARED', updatedAt: '2026-07-01T00:00:00Z' }], nextToken: 't2' } }
        : { status: 200, json: { agentSummaries: [{ agentId: 'A2', agentName: 'triage', agentStatus: 'PREPARED' }] } };
    });
    const r = await bedrockAdapter(AWS, ctx);
    expect(r.agents.map((a) => a.platformRef)).toEqual(['us-east-1/A1', 'us-east-1/A2']);
    expect(r.agents[0]!.lastModifiedAt).toBe('2026-07-01T00:00:00Z');
    expect(r.warnings).toEqual([]);
  });

  it('403 throws ConnectorAuthError naming the read-only IAM action', async () => {
    const ctx = fakeFetch(() => ({ status: 403, json: {} }));
    await expect(bedrockAdapter(AWS, ctx)).rejects.toThrow(ConnectorAuthError);
    await expect(bedrockAdapter(AWS, ctx)).rejects.toThrow(/bedrock:ListAgents/);
  });

  it('mid-pagination failure degrades to warning, keeps page 1 agents', async () => {
    let call = 0;
    const ctx = fakeFetch(() => {
      call += 1;
      return call === 1
        ? { status: 200, json: { agentSummaries: [{ agentId: 'A1', agentName: 'router' }], nextToken: 't2' } }
        : { status: 500, json: {} };
    });
    const r = await bedrockAdapter(AWS, ctx);
    expect(r.agents).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/incomplete/);
  });
});

describe('foundryAdapter', () => {
  const CFG = { endpoint: 'https://res.services.ai.azure.com/api/projects/p1', tenantId: 't', clientId: 'c', clientSecret: 's' };
  it('exchanges Entra token then lists assistants', async () => {
    const ctx = fakeFetch((url) => {
      if (url.includes('login.microsoftonline.com')) return { status: 200, json: { access_token: 'tok' } };
      expect(url).toContain('/assistants?api-version=v1');
      return { status: 200, json: { data: [{ id: 'asst_1', name: 'support-bot', model: 'gpt-x', created_at: 1750000000 }], has_more: false } };
    });
    const r = await foundryAdapter(CFG, ctx);
    expect(r.agents).toHaveLength(1);
    expect(r.agents[0]!.meta.model).toBe('gpt-x');
  });
  it('token failure -> ConnectorAuthError with role fix', async () => {
    const ctx = fakeFetch(() => ({ status: 400, json: { error_description: 'bad client secret' } }));
    await expect(foundryAdapter(CFG, ctx)).rejects.toThrow(/Reader access/);
  });
});

describe('cloudflareAdapter', () => {
  it('lists workers scripts and always carries the best-effort warning', async () => {
    const ctx = fakeFetch((url) => {
      expect(url).toContain('/accounts/acc1/workers/scripts');
      return { status: 200, json: { result: [{ id: 'zap-autopilot', modified_on: '2026-07-10T00:00:00Z' }] } };
    });
    const r = await cloudflareAdapter({ accountId: 'acc1', apiToken: 'tok' }, ctx);
    expect(r.agents[0]!.platformRef).toBe('acc1/zap-autopilot');
    expect(r.warnings[0]).toMatch(/best-effort/);
  });
  it('401 names the exact minimal token permission', async () => {
    const ctx = fakeFetch(() => ({ status: 401, json: {} }));
    await expect(cloudflareAdapter({ accountId: 'a', apiToken: 'bad' }, ctx))
      .rejects.toThrow(/Workers Scripts:Read/);
  });
});

describe('openclawAdapter (local collector)', () => {
  it('missing install returns warning, never throws', async () => {
    const r = await openclawAdapter({ path: '/nonexistent/openclaw' }, { fetch, now: () => NOW });
    expect(r.agents).toEqual([]);
    expect(r.warnings[0]).toMatch(/not found/);
  });
  it('scans agents/ and skills/ entries with mtime as activity signal', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-'));
    mkdirSync(join(root, 'agents'));
    writeFileSync(join(root, 'agents', 'nightly-poster.yaml'), 'name: nightly');
    mkdirSync(join(root, 'skills', 'research'), { recursive: true });
    const r = await openclawAdapter({ path: root }, { fetch, now: () => NOW });
    expect(r.agents.map((a) => a.displayName).sort()).toEqual(['nightly-poster', 'research']);
    expect(r.agents.every((a) => a.lastModifiedAt !== null)).toBe(true);
  });
});
