import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import {
  agentFingerprint,
  BASENAME_CONFIDENCE,
  GIT_REMOTE_CONFIDENCE,
  type Agent,
  type Run,
  type Spawn,
  type TokenCounts,
  type TriggerSource,
} from '@anveinspect/schema';

/**
 * Claude Code JSONL scanner (enrichment channel).
 *
 *   ~/.claude/projects/<munged-path>/<session>.jsonl
 *        │ stream line-by-line, per-line try/catch (format is undocumented:
 *        │ unknown shapes are SKIPPED, never fatal — tokens degrade to null)
 *        ▼
 *   SessionAccumulator ──▶ { Run, Agent } upserted idempotently by session id
 *
 * Hooks are the primary signal in live mode; this scanner backfills history
 * and is the sole source for machines without the plugin installed yet.
 */

export interface ScanResult {
  agents: Agent[];
  runs: Run[];
  spawns: Spawn[];
  filesScanned: number;
  linesSkipped: number;
  parseFailures: number; // whole files where token extraction failed -> tokens null
}

interface SessionAcc {
  sessionId: string;
  firstTs: string | null;
  lastTs: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  tokens: Record<string, TokenCounts>;
  tokensSeen: boolean;
  tokenExtractFailed: boolean;
  toolCounts: Record<string, number>;
  models: Set<string>;
  sawSummaryOnly: boolean;
  lineCount: number;
  endedCleanly: boolean;
}

export function machineId(): string {
  return createHash('sha256').update(`${hostname()}::${userInfo().username}`).digest('hex').slice(0, 16);
}

export function machineLabel(): string {
  return hostname().replace(/\.local$/, '');
}

export function scanClaudeProjects(root = join(homedir(), '.claude', 'projects')): ScanResult {
  const result: ScanResultBuilder = new ScanResultBuilder();
  if (!existsSync(root)) return result.finish();
  for (const projectDir of readdirSync(root)) {
    const dir = join(root, projectDir);
    let entries: string[];
    try {
      if (!statSync(dir).isDirectory()) continue;
      entries = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of entries) {
      result.pending.push({ path: join(dir, file), projectDir });
    }
    // Subagent transcripts: <sessionId>/subagents/agent-*.jsonl (+ workflows/wf_*/)
    // Their usage is REAL billed usage (distinct message ids); the parent's
    // toolUseResult.usage duplicates it and is deliberately never summed.
    for (const entry of readdirSync(dir)) {
      const subDir = join(dir, entry, 'subagents');
      if (!existsSync(subDir)) continue;
      collectAgentFiles(subDir, entry, projectDir, result);
      const wfRoot = join(subDir, 'workflows');
      if (existsSync(wfRoot)) {
        for (const wf of readdirSync(wfRoot)) {
          collectAgentFiles(join(wfRoot, wf), entry, projectDir, result);
        }
      }
    }
  }
  return result.finish();
}

function collectAgentFiles(dir: string, parentSessionId: string, projectDir: string, result: ScanResultBuilder): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch {
    return;
  }
  for (const f of files) {
    const agentId = f.slice('agent-'.length, -'.jsonl'.length);
    let agentType = 'subagent';
    try {
      const meta = JSON.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, '.meta.json')), 'utf8'));
      if (typeof meta.agentType === 'string') agentType = meta.agentType;
    } catch { /* meta.json optional */ }
    result.pending.push({ path: join(dir, f), projectDir, parentSessionId, agentId, agentType });
  }
}

interface PendingFile {
  path: string;
  projectDir: string;
  parentSessionId?: string;
  agentId?: string;
  agentType?: string;
}

class ScanResultBuilder {
  pending: PendingFile[] = [];

  finish(): ScanResult {
    // Synchronous streaming keeps the CLI dependency-free; files are small (<50MB).
    const agents = new Map<string, Agent>();
    const runs: Run[] = [];
    const spawns: Spawn[] = [];
    let linesSkipped = 0;
    let parseFailures = 0;
    // Cross-FILE usage dedup: sidechain/subagent files re-log parent usage lines
    // (ccusage issue #913 class — up to 75x cost inflation). Key: message.id+requestId.
    const seenUsage = new Set<string>();

    for (const { path, projectDir, parentSessionId, agentId, agentType } of this.pending) {
      const acc = accumulateFileSync(path, seenUsage);
      if (!acc || acc.lineCount === 0 || acc.sawSummaryOnly) continue;
      linesSkipped += 0;

      const isSubagent = parentSessionId !== undefined;
      const project = resolveProjectIdentity(acc.cwd, projectDir);
      const trigger: TriggerSource = isSubagent ? 'subagent' : classifyTrigger(acc);
      const identity = {
        vendor: 'claude_code' as const,
        projectIdentity: project.identity,
        projectIdentitySource: project.source,
        agentName: isSubagent ? (agentType ?? 'subagent') : basename(acc.cwd ?? mungedToPath(projectDir)),
        triggerSource: trigger,
      };
      const fp = agentFingerprint(identity);
      const startedAt = acc.firstTs ?? new Date(statSync(path).mtime).toISOString();
      const endedAt = acc.lastTs;
      const existing = agents.get(fp);
      const lastRun = endedAt ?? startedAt;
      if (!existing) {
        agents.set(fp, {
          ...identity,
          fingerprint: fp,
          source: 'local_collector',
          platformRef: null,
          displayName: identity.agentName,
          identityConfidence: project.source === 'git_remote' ? GIT_REMOTE_CONFIDENCE : BASENAME_CONFIDENCE,
          possiblePredecessor: null,
          firstSeenAt: startedAt,
          lastRunAt: lastRun,
        });
      } else if (existing.lastRunAt === null || lastRun > existing.lastRunAt) {
        existing.lastRunAt = lastRun;
      }

      if (acc.tokenExtractFailed) parseFailures += 1;
      // Subagent files carry the PARENT's sessionId inside — run id must be the
      // agent's own composite id, and the containment gives the spawn edge.
      const runId = isSubagent ? `${parentSessionId}/${agentId}` : acc.sessionId;
      if (isSubagent) {
        spawns.push({ parentRunId: parentSessionId!, childRunId: runId, confidence: 1.0 });
      }
      runs.push({
        id: runId,
        agentFingerprint: fp,
        machineId: machineId(),
        startedAt,
        endedAt,
        status: acc.endedCleanly ? 'completed' : 'unknown_end',
        // null = "unavailable" in the UI (never zero): extraction failed OR no usage lines existed
        tokensByModel: acc.tokenExtractFailed ? null : acc.tokensSeen ? acc.tokens : null,
        toolCallCounts: acc.toolCounts,
        models: [...acc.models],
        clientVersion: acc.version,
      });
    }

    return { agents: [...agents.values()], runs, spawns, filesScanned: this.pending.length, linesSkipped, parseFailures };
  }
}

function accumulateFileSync(path: string, seenUsage: Set<string>): SessionAcc | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const acc: SessionAcc = {
    sessionId: basename(path, '.jsonl'),
    firstTs: null,
    lastTs: null,
    cwd: null,
    gitBranch: null,
    version: null,
    tokens: {},
    tokensSeen: false,
    tokenExtractFailed: false,
    toolCounts: {},
    models: new Set(),
    sawSummaryOnly: true,
    lineCount: 0,
    endedCleanly: false,
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    acc.lineCount += 1;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      // truncated/corrupt line (crash mid-write) — skip, and if it's the last
      // content we saw, the run stays 'unknown_end'
      continue;
    }
    try {
      ingestLine(obj, acc, seenUsage);
    } catch {
      acc.tokenExtractFailed = true; // unknown schema shape: degrade tokens, keep run tracked
    }
  }
  return acc;
}

function ingestLine(obj: any, acc: SessionAcc, seenUsage: Set<string>): void {
  if (obj.type && obj.type !== 'summary') acc.sawSummaryOnly = false;
  if (typeof obj.sessionId === 'string') acc.sessionId = obj.sessionId;
  if (typeof obj.timestamp === 'string') {
    if (!acc.firstTs) acc.firstTs = obj.timestamp;
    acc.lastTs = obj.timestamp;
  }
  if (typeof obj.cwd === 'string') acc.cwd = obj.cwd;
  if (typeof obj.gitBranch === 'string') acc.gitBranch = obj.gitBranch;
  if (typeof obj.version === 'string') acc.version = obj.version;

  if (obj.type === 'assistant' && obj.message) {
    // API-error placeholder lines carry model "<synthetic>" and zero usage — exclude
    if (obj.isApiErrorMessage === true || obj.message.model === '<synthetic>') {
      acc.endedCleanly = false;
      return;
    }
    const model: string | undefined = obj.message.model;
    if (model) acc.models.add(model);
    const usage = obj.message.usage;
    if (usage && model) {
      // Dedup key across ALL files: sidechains re-log the same API responses.
      const dedupKey = `${obj.message.id ?? ''}::${obj.requestId ?? ''}`;
      const isDuplicate = dedupKey !== '::' && seenUsage.has(dedupKey);
      if (dedupKey !== '::') seenUsage.add(dedupKey);
      if (!isDuplicate) {
        acc.tokensSeen = true;
        const t = (acc.tokens[model] ??= { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 });
        t.input += usage.input_tokens ?? 0;
        t.output += usage.output_tokens ?? 0;
        t.cacheCreation += usage.cache_creation_input_tokens ?? 0;
        t.cacheRead += usage.cache_read_input_tokens ?? 0;
      }
    }
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          acc.toolCounts[block.name] = (acc.toolCounts[block.name] ?? 0) + 1;
        }
      }
    }
    // stop_reason end_turn = the model finished a turn cleanly (research finding E)
    acc.endedCleanly = obj.message.stop_reason === 'end_turn';
  }
  if (obj.type === 'user') acc.endedCleanly = false;
}

function resolveProjectIdentity(
  cwd: string | null,
  projectDir: string,
): { identity: string; source: 'git_remote' | 'basename' } {
  if (cwd && existsSync(join(cwd, '.git'))) {
    try {
      const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
      if (remote) return { identity: remote, source: 'git_remote' };
    } catch {
      /* no remote — fall through to basename */
    }
  }
  return { identity: basename(cwd ?? mungedToPath(projectDir)), source: 'basename' };
}

/** ~/.claude/projects dir names are paths with '/' replaced by '-'. Best-effort reversal for display. */
function mungedToPath(munged: string): string {
  return munged.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Trigger classification (v1 heuristic; hooks provide the authoritative signal live):
 * JSONL alone can't reliably distinguish cron from interactive historically —
 * classify 'interactive' unless the session shape says otherwise. Confidence
 * semantics live on the agent, so later reclassification creates a new agent
 * with a possible_predecessor link rather than corrupting history.
 */
function classifyTrigger(acc: SessionAcc): TriggerSource {
  void acc;
  return 'interactive';
}
