import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Agent, Vendor } from '@fleetdeck/schema';
import { runConnector, CONNECTOR_VENDORS, ConnectorAuthError, type PlatformAgent, type AdapterContext, defaultContext } from '@fleetdeck/adapters';
import { FleetStore } from './store.js';

/**
 * Connector runtime (local mode): credentials live CLIENT-SIDE ONLY in
 * ~/.fleetdeck/connectors.json (0600) and never enter the fleet db or leave
 * the machine. Catalog sync writes platform agents into the same inventory
 * as local agents; staleness for them is metadata-derived (lastModifiedAt).
 */

export const CONNECTORS_PATH = process.env.FLEETDECK_CONNECTORS ?? join(homedir(), '.fleetdeck', 'connectors.json');

export type ConnectorsFile = Partial<Record<Vendor, Record<string, unknown>>>;

export function loadConnectorsFile(path = CONNECTORS_PATH): ConnectorsFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`connectors.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

export function writeConnectorsFile(file: ConnectorsFile, path = CONNECTORS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
}

/** Connector-agent fingerprint: platform-native ids are stable, so no heuristics needed. */
export function connectorFingerprint(vendor: Vendor, platformRef: string): string {
  return createHash('sha256').update(`${vendor} ${platformRef}`).digest('hex').slice(0, 24);
}

function toAgent(p: PlatformAgent, nowIso: string): Agent {
  return {
    vendor: p.vendor,
    projectIdentity: p.platformRef,
    projectIdentitySource: 'git_remote', // platform ids are stable/canonical: full confidence class
    agentName: p.displayName,
    triggerSource: 'scheduled',
    fingerprint: connectorFingerprint(p.vendor, p.platformRef),
    source: 'platform_connector',
    platformRef: p.platformRef,
    displayName: p.displayName,
    identityConfidence: 1.0,
    possiblePredecessor: null,
    firstSeenAt: p.createdAt ?? nowIso,
    lastRunAt: p.lastModifiedAt, // catalog-only: best metadata-derived activity signal
  };
}

export interface SyncOutcome {
  vendor: Vendor;
  configured: boolean;
  agentCount: number;
  warnings: string[];
  error: string | null;
}

/** Resolve config indirections (e.g. vertex serviceAccountKeyFile -> key JSON). */
function resolveConfig(vendor: Vendor, raw: Record<string, unknown>): Record<string, unknown> {
  if (vendor === 'vertex' && typeof raw.serviceAccountKeyFile === 'string' && !raw.serviceAccountKey) {
    const keyPath = raw.serviceAccountKeyFile.replace(/^~(?=\/)/, homedir());
    return { ...raw, serviceAccountKey: JSON.parse(readFileSync(keyPath, 'utf8')) };
  }
  return raw;
}

export async function syncConnectors(
  dbPath: string,
  opts: { only?: Vendor[]; connectorsPath?: string; ctx?: AdapterContext } = {},
): Promise<SyncOutcome[]> {
  const file = loadConnectorsFile(opts.connectorsPath);
  const ctx = opts.ctx ?? defaultContext();
  const store = new FleetStore(dbPath);
  const outcomes: SyncOutcome[] = [];
  const nowIso = new Date().toISOString();

  try {
    for (const vendor of CONNECTOR_VENDORS) {
      if (opts.only && !opts.only.includes(vendor)) continue;
      const isLocal = vendor === 'openclaw' || vendor === 'hermes';
      const raw = file[vendor];
      if (!raw && !isLocal) {
        outcomes.push({ vendor, configured: false, agentCount: 0, warnings: [], error: null });
        continue;
      }
      try {
        const result = await runConnector(vendor, resolveConfig(vendor, raw ?? {}), ctx);
        const tx = store.db.transaction(() => {
          for (const p of result.agents) store.upsertAgent(toAgent(p, nowIso));
          store.db
            .prepare(
              `INSERT INTO connector_syncs (vendor, synced_at, agent_count, warnings, error)
               VALUES (@vendor, @syncedAt, @count, @warnings, NULL)
               ON CONFLICT(vendor) DO UPDATE SET synced_at=@syncedAt, agent_count=@count, warnings=@warnings, error=NULL`,
            )
            .run({ vendor, syncedAt: nowIso, count: result.agents.length, warnings: JSON.stringify(result.warnings) });
        });
        tx();
        outcomes.push({ vendor, configured: true, agentCount: result.agents.length, warnings: result.warnings, error: null });
      } catch (err) {
        // Expired/revoked creds -> clear error state; existing inventory retained, marked stale-as-of
        const msg = err instanceof ConnectorAuthError ? err.message : `${vendor}: ${err instanceof Error ? err.message : err}`;
        store.db
          .prepare(
            `INSERT INTO connector_syncs (vendor, synced_at, agent_count, warnings, error)
             VALUES (@vendor, @syncedAt, 0, '[]', @error)
             ON CONFLICT(vendor) DO UPDATE SET error=@error`,
          )
          .run({ vendor, syncedAt: nowIso, error: msg });
        outcomes.push({ vendor, configured: true, agentCount: 0, warnings: [], error: msg });
      }
    }
  } finally {
    store.close();
  }
  return outcomes;
}

export function connectorStatus(dbPath: string): { vendor: string; syncedAt: string; agentCount: number; warnings: string[]; error: string | null }[] {
  const store = new FleetStore(dbPath);
  try {
    const rows = store.db.prepare(`SELECT * FROM connector_syncs ORDER BY vendor`).all() as any[];
    return rows.map((r) => ({
      vendor: r.vendor,
      syncedAt: r.synced_at,
      agentCount: r.agent_count,
      warnings: JSON.parse(r.warnings),
      error: r.error,
    }));
  } finally {
    store.close();
  }
}
