import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Vendor } from '@fleetdeck/schema';
import { sigv4Headers, entraToken, gcpToken, type AwsCreds, type GcpServiceAccountKey } from './auth.js';
import { ConnectorAuthError, type Adapter, type ConnectorResult, type PlatformAgent } from './types.js';

/**
 * Catalog-only, read-only adapters. Every adapter:
 *  - issues only LIST/GET-semantics calls
 *  - paginates to completion (partial pages surface as warnings, never silent)
 *  - throws ConnectorAuthError with the minimal-role fix on 401/403
 */

const MAX_PAGES = 50; // hard backstop; hitting it emits a warning (no silent caps)

// ---------- Amazon Bedrock Agents ----------
export interface BedrockConfig extends AwsCreds {
  region: string;
}

export const bedrockAdapter: Adapter<BedrockConfig> = async (config, ctx) => {
  const host = `bedrock-agent.${config.region}.amazonaws.com`;
  const agents: PlatformAgent[] = [];
  const warnings: string[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = JSON.stringify(nextToken ? { maxResults: 100, nextToken } : { maxResults: 100 });
    const headers = sigv4Headers({
      creds: config, method: 'POST', host, path: '/agents/', body,
      region: config.region, service: 'bedrock', now: ctx.now(),
    });
    const res = await ctx.fetch(`https://${host}/agents/`, { method: 'POST', headers, body });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError('bedrock', `authentication failed (${res.status})`,
        'grant the IAM policy action "bedrock:ListAgents" (read-only) to this access key and check the region');
    }
    if (!res.ok) {
      warnings.push(`bedrock page ${page + 1} failed with HTTP ${res.status}; catalog may be incomplete`);
      break;
    }
    const json: any = await res.json();
    for (const s of json.agentSummaries ?? []) {
      agents.push({
        vendor: 'bedrock',
        platformRef: `${config.region}/${s.agentId}`,
        displayName: s.agentName ?? s.agentId,
        platformStatus: s.agentStatus ?? null,
        lastModifiedAt: s.updatedAt ?? null,
        createdAt: null,
        meta: { latestVersion: s.latestAgentVersion ?? '' },
      });
    }
    nextToken = json.nextToken;
    if (!nextToken) break;
    if (page === MAX_PAGES - 1) warnings.push(`bedrock pagination stopped at ${MAX_PAGES} pages (backstop)`);
  }
  return { vendor: 'bedrock', agents, warnings };
};

// ---------- Microsoft AI Foundry (agents REST, assistants-compatible surface) ----------
export interface FoundryConfig {
  /** project endpoint, e.g. https://<res>.services.ai.azure.com/api/projects/<project> */
  endpoint: string;
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  apiVersion?: string;
}

export const foundryAdapter: Adapter<FoundryConfig> = async (config, ctx) => {
  const token = await entraToken(
    ctx.fetch, config.tenantId, config.clientId, config.clientSecret,
    config.scope ?? 'https://ai.azure.com/.default',
  ).catch((e) => {
    throw new ConnectorAuthError('foundry', e.message,
      'verify tenantId/clientId/clientSecret and that the app registration has Reader access to the Foundry project');
  });
  const agents: PlatformAgent[] = [];
  const warnings: string[] = [];
  const apiVersion = config.apiVersion ?? 'v1';
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${config.endpoint.replace(/\/$/, '')}/assistants?api-version=${apiVersion}&limit=100${after ? `&after=${after}` : ''}`;
    const res = await ctx.fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError('foundry', `authentication failed (${res.status})`,
        'the service principal needs the "Azure AI User" (reader) role on the project');
    }
    if (!res.ok) {
      warnings.push(`foundry page ${page + 1} failed with HTTP ${res.status}; catalog may be incomplete`);
      break;
    }
    const json: any = await res.json();
    for (const a of json.data ?? []) {
      agents.push({
        vendor: 'foundry',
        platformRef: a.id,
        displayName: a.name ?? a.id,
        platformStatus: null,
        lastModifiedAt: a.created_at ? new Date(a.created_at * 1000).toISOString() : null,
        createdAt: a.created_at ? new Date(a.created_at * 1000).toISOString() : null,
        meta: { model: a.model ?? '' },
      });
    }
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return { vendor: 'foundry', agents, warnings };
};

// ---------- Google Vertex / Gemini Enterprise (reasoning engines) ----------
export interface VertexConfig {
  projectId: string;
  location: string;
  serviceAccountKey: GcpServiceAccountKey;
}

export const vertexAdapter: Adapter<VertexConfig> = async (config, ctx) => {
  const token = await gcpToken(ctx.fetch, config.serviceAccountKey, ctx.now()).catch((e) => {
    throw new ConnectorAuthError('vertex', e.message,
      'check the service-account key JSON; the account needs roles/aiplatform.viewer (read-only)');
  });
  const agents: PlatformAgent[] = [];
  const warnings: string[] = [];
  const base = `https://${config.location}-aiplatform.googleapis.com/v1beta1/projects/${config.projectId}/locations/${config.location}/reasoningEngines`;
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.fetch(`${base}?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorAuthError('vertex', `authentication failed (${res.status})`,
        'grant roles/aiplatform.viewer to the service account and confirm project/location');
    }
    if (!res.ok) {
      warnings.push(`vertex page ${page + 1} failed with HTTP ${res.status}; catalog may be incomplete`);
      break;
    }
    const json: any = await res.json();
    for (const e of json.reasoningEngines ?? []) {
      const id = String(e.name ?? '').split('/').pop() ?? '';
      agents.push({
        vendor: 'vertex',
        platformRef: `${config.location}/${id}`,
        displayName: e.displayName ?? id,
        platformStatus: null,
        lastModifiedAt: e.updateTime ?? null,
        createdAt: e.createTime ?? null,
        meta: {},
      });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return { vendor: 'vertex', agents, warnings };
};

// ---------- Cloudflare (Workers scripts — agents run on Workers/DO; best-effort) ----------
export interface CloudflareConfig {
  accountId: string;
  apiToken: string;
}

export const cloudflareAdapter: Adapter<CloudflareConfig> = async (config, ctx) => {
  const res = await ctx.fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts`,
    { headers: { authorization: `Bearer ${config.apiToken}` } },
  );
  if (res.status === 401 || res.status === 403) {
    throw new ConnectorAuthError('cloudflare', `authentication failed (${res.status})`,
      'create an API token with the "Workers Scripts:Read" permission only');
  }
  if (!res.ok) {
    return { vendor: 'cloudflare', agents: [], warnings: [`cloudflare list failed with HTTP ${res.status}`] };
  }
  const json: any = await res.json();
  const agents: PlatformAgent[] = (json.result ?? []).map((s: any): PlatformAgent => ({
    vendor: 'cloudflare',
    platformRef: `${config.accountId}/${s.id}`,
    displayName: s.id,
    platformStatus: null,
    lastModifiedAt: s.modified_on ?? null,
    createdAt: s.created_on ?? null,
    meta: {},
  }));
  return {
    vendor: 'cloudflare', agents,
    warnings: ['cloudflare coverage is best-effort: Workers scripts listed; Durable-Object agent instances are not enumerable via the catalog API'],
  };
};

// ---------- OpenClaw & Hermes (self-hosted frameworks -> local directory collectors) ----------
export interface LocalDirConfig {
  path?: string;
}

function localDirAdapter(vendor: Vendor, defaultDir: string, agentsSubdirs: string[]): Adapter<LocalDirConfig> {
  return async (config) => {
    const root = (config.path ?? defaultDir).replace(/^~(?=\/)/, homedir());
    if (!existsSync(root)) {
      return {
        vendor, agents: [],
        warnings: [`${vendor} not found at ${root} — set "path" in connectors.json if it lives elsewhere`],
      };
    }
    const agents: PlatformAgent[] = [];
    for (const sub of agentsSubdirs) {
      const dir = join(root, sub);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        try {
          const st = statSync(join(dir, entry));
          agents.push({
            vendor,
            platformRef: `${sub}/${entry}`,
            displayName: entry.replace(/\.(json|ya?ml|md|py|ts)$/, ''),
            platformStatus: null,
            lastModifiedAt: st.mtime.toISOString(),
            createdAt: st.birthtime.toISOString(),
            meta: { kind: st.isDirectory() ? 'dir' : 'file' },
          });
        } catch { /* unreadable entry — skip */ }
      }
    }
    return {
      vendor, agents,
      warnings: agents.length === 0 ? [`${vendor}: install found at ${root} but no agents in ${agentsSubdirs.join('/, ')}`] : [],
    };
  };
}

// Layouts are best-effort defaults for the frameworks' standard installs;
// both are overridable via "path" + future "subdirs" config.
export const openclawAdapter = localDirAdapter('openclaw', '~/.openclaw', ['agents', 'skills']);
export const hermesAdapter = localDirAdapter('hermes', '~/.hermes', ['agents', 'skills']);
