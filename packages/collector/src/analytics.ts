import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { costOf, loadRates, PRICING_PATH, type ModelRate } from './pricing.js';

/**
 * Fleet analytics — cost + activity intelligence over the last 30 days.
 * Cost is estimated from an editable pricing file; every cost result carries
 * `pricedRuns`/`unpricedRuns` so the UI can be honest about coverage. Token
 * counts stay the ground truth; dollars are always labeled estimates.
 */

export interface FleetAnalytics {
  window: '30d';
  estimatedCostUsd: number;
  pricedRuns: number;
  unpricedRuns: number;      // runs with tokens but no known model rate
  partiallyPricedRuns: number; // runs mixing known + unknown models — cost is an undercount
  tokenlessRuns: number;     // runs with no token data at all (unavailable)
  costByModel: { model: string; usd: number; tokens: number }[];
  costByVendor: { vendor: string; usd: number }[];
  topCostAgents: { fingerprint: string; name: string; vendor: string; usd: number; runs: number }[];
  busiestHours: { hour: number; runs: number }[]; // 0-23 local
  whyRunning: { trigger: string; runs: number }[]; // "why running": runs grouped by trigger source
  failureBursts: { agent: string; failures: number; windowStart: string }[];
  ratesSource: 'default' | 'custom';
}

const DAY = 86_400_000;

export function computeAnalytics(db: Database.Database, now = new Date()): FleetAnalytics {
  const rates = loadRates();
  const isCustom = existsSync(PRICING_PATH);
  const since = new Date(now.getTime() - 30 * DAY).toISOString();
  const runs = db
    .prepare(
      `SELECT r.started_at, r.status, r.tokens_by_model, a.display_name, a.vendor, a.fingerprint, a.trigger_source
       FROM runs r JOIN agents a ON a.fingerprint = r.agent_fingerprint WHERE r.started_at >= ?`,
    )
    .all(since) as any[];

  let estimatedCostUsd = 0;
  let pricedRuns = 0;
  let unpricedRuns = 0;
  let partiallyPricedRuns = 0;
  let tokenlessRuns = 0;
  const costByModel = new Map<string, { usd: number; tokens: number }>();
  const costByVendor = new Map<string, number>();
  const costByAgent = new Map<string, { fingerprint: string; name: string; vendor: string; usd: number; runs: number }>();
  const hourHist = new Array(24).fill(0);
  const triggerHist = new Map<string, number>();
  const failuresByAgent = new Map<string, { name: string; times: number[] }>();
  const emptyTimes = (): number[] => [];

  for (const r of runs) {
    const trigger = r.trigger_source || 'unknown'; // "why running" — how this run was initiated
    triggerHist.set(trigger, (triggerHist.get(trigger) ?? 0) + 1);
    const startedMs = r.started_at ? Date.parse(r.started_at) : NaN; // invalid timestamps -> NaN, skipped below
    if (!Number.isNaN(startedMs)) hourHist[new Date(startedMs).getHours()]++;
    if (r.status === 'error') {
      const f = failuresByAgent.get(r.fingerprint) ?? { name: r.display_name, times: emptyTimes() };
      if (!Number.isNaN(startedMs)) f.times.push(startedMs); // never push NaN — it poisons new Date(...).toISOString()
      failuresByAgent.set(r.fingerprint, f);
    }
    const tbm = r.tokens_by_model === null ? null : safeParse(r.tokens_by_model);
    if (!tbm) { tokenlessRuns++; continue; }
    const { usd, priced, partial } = costOf(tbm, rates);
    if (!priced) { unpricedRuns++; continue; }
    pricedRuns++;
    if (partial) partiallyPricedRuns++; // some model in this run had no rate — usd undercounts
    estimatedCostUsd += usd;
    costByVendor.set(r.vendor, (costByVendor.get(r.vendor) ?? 0) + usd);
    const ag = costByAgent.get(r.fingerprint) ?? { fingerprint: r.fingerprint, name: r.display_name, vendor: r.vendor, usd: 0, runs: 0 };
    ag.usd += usd; ag.runs++; costByAgent.set(r.fingerprint, ag);
    for (const [model, t] of Object.entries(tbm) as any[]) {
      const rate: ModelRate | undefined = rates[model];
      if (!rate) continue;
      const mc = costByModel.get(model) ?? { usd: 0, tokens: 0 };
      mc.usd += costOf({ [model]: t }, rates).usd;
      mc.tokens += t.input + t.output;
      costByModel.set(model, mc);
    }
  }

  // failure bursts: >=3 failures within any 1h window for one agent
  const failureBursts: FleetAnalytics['failureBursts'] = [];
  for (const [, f] of failuresByAgent) {
    const times = f.times.sort((a, b) => a - b);
    for (let i = 0; i < times.length; i++) {
      const windowEnd = times[i]! + 3_600_000;
      const inWindow = times.filter((t) => t >= times[i]! && t <= windowEnd).length;
      if (inWindow >= 3) {
        failureBursts.push({ agent: f.name, failures: inWindow, windowStart: new Date(times[i]!).toISOString() });
        break; // one burst report per agent
      }
    }
  }

  return {
    window: '30d',
    estimatedCostUsd,
    pricedRuns,
    unpricedRuns,
    partiallyPricedRuns,
    tokenlessRuns,
    costByModel: [...costByModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.usd - a.usd),
    costByVendor: [...costByVendor.entries()].map(([vendor, usd]) => ({ vendor, usd })).sort((a, b) => b.usd - a.usd),
    topCostAgents: [...costByAgent.values()].sort((a, b) => b.usd - a.usd).slice(0, 10),
    busiestHours: hourHist.map((runs, hour) => ({ hour, runs })),
    whyRunning: [...triggerHist.entries()].map(([trigger, runs]) => ({ trigger, runs })).sort((a, b) => b.runs - a.runs),
    failureBursts: failureBursts.sort((a, b) => b.failures - a.failures).slice(0, 10),
    ratesSource: isCustom ? 'custom' : 'default',
  };
}

function safeParse(s: string): Record<string, any> | null {
  try { return JSON.parse(s); } catch { return null; }
}
