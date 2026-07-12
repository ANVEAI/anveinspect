import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import {
  agentFingerprint,
  BASENAME_CONFIDENCE,
  GIT_REMOTE_CONFIDENCE,
  type Agent,
  type Run,
} from '@anveinspect/schema';
import { machineId, resolveProjectIdentity } from './claude-scanner.js';

/**
 * Codex session scanner (enrichment-grade, format verified 2026-07-13).
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   line = { timestamp, type, payload }; first line type "session_meta":
 *   payload = { session_id, cwd, cli_version, source, ... }
 *
 * Same defensive posture as the Claude scanner: undocumented format, per-line
 * try/catch, unknown shapes skipped, tokens reported null (unavailable) —
 * Codex rollouts don't expose per-model usage in a stable documented shape.
 */

export interface CodexScanResult {
  agents: Agent[];
  runs: Run[];
  filesScanned: number;
}

export function scanCodexSessions(root = join(homedir(), '.codex', 'sessions')): CodexScanResult {
  const agents = new Map<string, Agent>();
  const runs: Run[] = [];
  let filesScanned = 0;
  if (!existsSync(root)) return { agents: [], runs: [], filesScanned: 0 };

  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) {
          if (depth < 4) walk(p, depth + 1);
        } else if (e.startsWith('rollout-') && e.endsWith('.jsonl')) {
          files.push(p);
        }
      } catch { /* vanished mid-walk */ }
    }
  };
  walk(root, 0);

  for (const path of files) {
    filesScanned += 1;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    let sessionId: string | null = null;
    let cwd: string | null = null;
    let cliVersion: string | null = null;
    let firstTs: string | null = null;
    let lastTs: string | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof obj.timestamp === 'string') {
        if (!firstTs) firstTs = obj.timestamp;
        lastTs = obj.timestamp;
      }
      if (obj.type === 'session_meta' && obj.payload) {
        sessionId = obj.payload.session_id ?? obj.payload.id ?? null;
        cwd = obj.payload.cwd ?? null;
        cliVersion = obj.payload.cli_version ?? null;
      }
    }
    if (!firstTs) continue;
    const runId = `codex:${sessionId ?? basename(path, '.jsonl')}`;
    const project = resolveProjectIdentity(cwd, basename(path));
    const identity = {
      vendor: 'codex' as const,
      projectIdentity: project.identity,
      projectIdentitySource: project.source,
      agentName: basename(cwd ?? 'codex'),
      triggerSource: 'interactive' as const,
    };
    const fp = agentFingerprint(identity);
    const existing = agents.get(fp);
    const lastRun = lastTs ?? firstTs;
    if (!existing) {
      agents.set(fp, {
        ...identity,
        fingerprint: fp,
        source: 'local_collector',
        platformRef: null,
        displayName: identity.agentName,
        identityConfidence: project.source === 'git_remote' ? GIT_REMOTE_CONFIDENCE : BASENAME_CONFIDENCE,
        possiblePredecessor: null,
        firstSeenAt: firstTs,
        lastRunAt: lastRun,
      });
    } else if (existing.lastRunAt === null || lastRun > existing.lastRunAt) {
      existing.lastRunAt = lastRun;
    }
    runs.push({
      id: runId,
      agentFingerprint: fp,
      machineId: machineId(),
      startedAt: firstTs,
      endedAt: lastTs,
      status: 'completed', // codex exec sessions close with the process; no crash marker in the format
      tokensByModel: null, // honest: usage not exposed in a stable shape -> "unavailable", never 0
      toolCallCounts: {},
      models: [],
      clientVersion: cliVersion,
    });
  }
  return { agents: [...agents.values()], runs, filesScanned };
}
