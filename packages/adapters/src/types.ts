import type { Vendor } from '@anveinspect/schema';

/**
 * Isomorphic connector contract (eng review D3): each adapter is a PURE
 * function of (config, ctx) -> catalog. No SDKs, no ambient credentials,
 * fetch-compatible HTTP only — the same code runs in Node and Workers.
 *
 * Catalog-only + read-only by design (design doc D10 rules): adapters may
 * only LIST/GET. Setup docs must show the minimal read-only role per vendor.
 */

export interface PlatformAgent {
  vendor: Vendor;
  /** platform-native stable id (+ scope), e.g. "us-east-1/AGENT123" */
  platformRef: string;
  displayName: string;
  /** platform-reported status string, verbatim (e.g. PREPARED, ACTIVE) */
  platformStatus: string | null;
  /** best metadata-derived activity signal the catalog exposes */
  lastModifiedAt: string | null;
  createdAt: string | null;
  /** small, data-boundary-safe extras (model id, version count) — never configs/prompts */
  meta: Record<string, string>;
}

export interface AdapterContext {
  fetch: typeof fetch;
  now: () => Date;
}

export interface ConnectorResult {
  vendor: Vendor;
  agents: PlatformAgent[];
  /** partial-failure surface: pages/scopes that errored, with actionable text */
  warnings: string[];
}

export type Adapter<C> = (config: C, ctx: AdapterContext) => Promise<ConnectorResult>;

export class ConnectorAuthError extends Error {
  constructor(vendor: string, detail: string, fix: string) {
    super(`${vendor}: ${detail} — ${fix}`);
    this.name = 'ConnectorAuthError';
  }
}
