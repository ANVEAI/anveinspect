import type { Vendor } from '@anveinspect/schema';
import type { Adapter, ConnectorResult, AdapterContext } from './types.js';
import {
  bedrockAdapter, foundryAdapter, vertexAdapter, cloudflareAdapter,
  openclawAdapter, hermesAdapter,
} from './adapters.js';

export * from './types.js';
export * from './adapters.js';
export * from './auth.js';

export const ADAPTERS: Partial<Record<Vendor, Adapter<any>>> = {
  bedrock: bedrockAdapter,
  foundry: foundryAdapter,
  vertex: vertexAdapter,
  cloudflare: cloudflareAdapter,
  openclaw: openclawAdapter,
  hermes: hermesAdapter,
};

export const CONNECTOR_VENDORS = Object.keys(ADAPTERS) as Vendor[];

export function defaultContext(): AdapterContext {
  return { fetch: globalThis.fetch, now: () => new Date() };
}

/** Run one connector; auth errors throw, partial failures return warnings. */
export async function runConnector(vendor: Vendor, config: unknown, ctx = defaultContext()): Promise<ConnectorResult> {
  const adapter = ADAPTERS[vendor];
  if (!adapter) throw new Error(`No adapter for vendor "${vendor}". Available: ${CONNECTOR_VENDORS.join(', ')}`);
  return adapter(config, ctx);
}
