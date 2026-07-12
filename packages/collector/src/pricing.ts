import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Model pricing — USD per MILLION tokens. Estimates, EDITABLE by the user via
 * ~/.anveinspect/pricing.json (same shape). Cost figures are always labeled as
 * estimates in the UI; token counts remain the ground truth. We never invent a
 * dollar number without a rate — unknown models contribute 0 and are listed.
 */

export interface ModelRate {
  input: number;
  output: number;
  cacheRead?: number; // usually ~10% of input
  cacheWrite?: number;
}

/** Conservative 2026 Anthropic-tier estimates (per 1M tokens). Opus > Sonnet > Fable ~ Haiku. */
export const DEFAULT_RATES: Record<string, ModelRate> = {
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-fable-5': { input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0.375 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
};

export const PRICING_PATH = process.env.ANVEINSPECT_PRICING ?? join(homedir(), '.anveinspect', 'pricing.json');

export function loadRates(path = PRICING_PATH): Record<string, ModelRate> {
  if (!existsSync(path)) return DEFAULT_RATES;
  try {
    return { ...DEFAULT_RATES, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return DEFAULT_RATES;
  }
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface CostResult {
  usd: number;
  priced: boolean; // false if the model had no rate (usd stays 0)
}

/** Cost of one run's tokens-by-model. Missing rates → priced:false, never a fake number. */
export function costOf(tokensByModel: Record<string, TokenCounts> | null, rates = DEFAULT_RATES): CostResult {
  if (!tokensByModel) return { usd: 0, priced: false };
  let usd = 0;
  let anyPriced = false;
  for (const [model, t] of Object.entries(tokensByModel)) {
    const rate = rates[model];
    if (!rate) continue; // unknown model: contributes 0, flagged via priced=false below
    anyPriced = true;
    usd +=
      (t.input / 1e6) * rate.input +
      (t.output / 1e6) * rate.output +
      (t.cacheRead / 1e6) * (rate.cacheRead ?? rate.input * 0.1) +
      (t.cacheCreation / 1e6) * (rate.cacheWrite ?? rate.input * 1.25);
  }
  return { usd, priced: anyPriced };
}

export function fmtUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}
