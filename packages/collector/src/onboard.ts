import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Plug-and-play onboarding: detect which agent platforms this machine already
 * has, whether their CLI is authenticated, and — crucially — reuse that CLI
 * login instead of asking the user to paste API keys. For anything not yet
 * signed in, hand back the exact one-line CLI command to run.
 *
 * Philosophy: the user already logged into gcloud / aws / wrangler / claude /
 * codex once. AnveInspect should stand on those sessions, not re-ask for keys.
 */

export type PlatformStatus = 'ready' | 'needs_signin' | 'cli_missing' | 'not_present';

export interface PlatformProbe {
  vendor: string;
  label: string;
  status: PlatformStatus;
  detail: string;
  /** exact command the user runs to become 'ready' (empty when already ready) */
  fixCommand: string;
  /** how this platform's agents get collected once ready */
  collection: 'local-logs' | 'local-dir' | 'cli-auth-api';
}

function run(cmd: string, args: string[], timeoutMs = 5000): { ok: boolean; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { ok: true, out };
  } catch {
    return { ok: false, out: '' };
  }
}

function has(cmd: string): boolean {
  return run('command', ['-v', cmd]).ok || run('which', [cmd]).ok;
}

export function probePlatforms(): PlatformProbe[] {
  const probes: PlatformProbe[] = [];

  // --- Claude Code: local logs, zero config ---
  probes.push({
    vendor: 'claude_code',
    label: 'Claude Code',
    status: existsSync(join(homedir(), '.claude', 'projects')) ? 'ready' : 'not_present',
    detail: existsSync(join(homedir(), '.claude', 'projects'))
      ? 'reads ~/.claude/projects (no signin needed)'
      : 'no ~/.claude/projects found — use Claude Code and it appears automatically',
    fixCommand: '',
    collection: 'local-logs',
  });

  // --- Codex: local logs, zero config ---
  probes.push({
    vendor: 'codex',
    label: 'Codex',
    status: existsSync(join(homedir(), '.codex', 'sessions')) ? 'ready' : 'not_present',
    detail: existsSync(join(homedir(), '.codex', 'sessions'))
      ? 'reads ~/.codex/sessions (no signin needed)'
      : 'no ~/.codex/sessions found — run a codex session and it appears',
    fixCommand: '',
    collection: 'local-logs',
  });

  // --- OpenClaw / Hermes: local agent dirs ---
  for (const [vendor, label, dir] of [
    ['openclaw', 'OpenClaw', '.openclaw'],
    ['hermes', 'Hermes', '.hermes'],
  ] as const) {
    const present = existsSync(join(homedir(), dir));
    probes.push({
      vendor,
      label,
      status: present ? 'ready' : 'not_present',
      detail: present ? `reads ~/${dir} (no signin needed)` : `no ~/${dir} — install ${label} to inventory its agents`,
      fixCommand: '',
      collection: 'local-dir',
    });
  }

  // --- GCP / Vertex: reuse gcloud login ---
  if (!has('gcloud')) {
    probes.push({ vendor: 'vertex', label: 'Google Vertex', status: 'cli_missing', detail: 'gcloud CLI not installed', fixCommand: 'https://cloud.google.com/sdk/docs/install', collection: 'cli-auth-api' });
  } else {
    const tok = run('gcloud', ['auth', 'print-access-token']);
    const proj = run('gcloud', ['config', 'get-value', 'project']);
    if (tok.ok && proj.ok && proj.out && proj.out !== '(unset)') {
      probes.push({ vendor: 'vertex', label: 'Google Vertex', status: 'ready', detail: `gcloud authed, project ${proj.out}`, fixCommand: '', collection: 'cli-auth-api' });
    } else {
      probes.push({ vendor: 'vertex', label: 'Google Vertex', status: 'needs_signin', detail: 'gcloud installed but not authed / no project set', fixCommand: 'gcloud auth login && gcloud config set project <your-project>', collection: 'cli-auth-api' });
    }
  }

  // --- AWS / Bedrock: reuse aws CLI credential chain ---
  if (!has('aws')) {
    probes.push({ vendor: 'bedrock', label: 'Amazon Bedrock', status: 'cli_missing', detail: 'aws CLI not installed', fixCommand: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html', collection: 'cli-auth-api' });
  } else {
    const id = run('aws', ['sts', 'get-caller-identity', '--output', 'text']);
    probes.push(
      id.ok
        ? { vendor: 'bedrock', label: 'Amazon Bedrock', status: 'ready', detail: 'aws CLI authed (credential chain)', fixCommand: '', collection: 'cli-auth-api' }
        : { vendor: 'bedrock', label: 'Amazon Bedrock', status: 'needs_signin', detail: 'aws CLI installed but no valid credentials', fixCommand: 'aws configure   (or aws sso login)', collection: 'cli-auth-api' },
    );
  }

  // --- Cloudflare: reuse wrangler login ---
  if (!has('wrangler') && !has('npx')) {
    probes.push({ vendor: 'cloudflare', label: 'Cloudflare Workers', status: 'cli_missing', detail: 'wrangler not available', fixCommand: 'npm i -g wrangler', collection: 'cli-auth-api' });
  } else {
    const who = has('wrangler') ? run('wrangler', ['whoami'], 8000) : { ok: false, out: '' };
    probes.push(
      who.ok && /email|account/i.test(who.out)
        ? { vendor: 'cloudflare', label: 'Cloudflare Workers', status: 'ready', detail: 'wrangler authed', fixCommand: '', collection: 'cli-auth-api' }
        : { vendor: 'cloudflare', label: 'Cloudflare Workers', status: 'needs_signin', detail: 'wrangler present but not logged in', fixCommand: 'wrangler login', collection: 'cli-auth-api' },
    );
  }

  // --- Microsoft AI Foundry: reuse az login ---
  if (!has('az')) {
    probes.push({ vendor: 'foundry', label: 'Microsoft AI Foundry', status: 'cli_missing', detail: 'az CLI not installed', fixCommand: 'https://learn.microsoft.com/cli/azure/install-azure-cli', collection: 'cli-auth-api' });
  } else {
    const acct = run('az', ['account', 'show', '--output', 'none']);
    probes.push(
      acct.ok
        ? { vendor: 'foundry', label: 'Microsoft AI Foundry', status: 'needs_signin', detail: 'az authed — set your Foundry project endpoint to finish (az can\'t auto-discover it)', fixCommand: 'anveinspect connectors set foundry endpoint <project-endpoint>', collection: 'cli-auth-api' }
        : { vendor: 'foundry', label: 'Microsoft AI Foundry', status: 'needs_signin', detail: 'az CLI installed but not logged in', fixCommand: 'az login', collection: 'cli-auth-api' },
    );
  }

  return probes;
}

export interface OnboardReport {
  probes: PlatformProbe[];
  ready: string[];
  needsAction: PlatformProbe[];
  summary: string;
}

export function onboardReport(): OnboardReport {
  const probes = probePlatforms();
  const ready = probes.filter((p) => p.status === 'ready').map((p) => p.label);
  const needsAction = probes.filter((p) => p.status === 'needs_signin' || p.status === 'cli_missing');
  const summary =
    `${ready.length} platform(s) ready: ${ready.join(', ') || 'none'}. ` +
    (needsAction.length
      ? `${needsAction.length} need a one-time signin (see fixCommand).`
      : 'Everything reachable is connected.');
  return { probes, ready, needsAction, summary };
}
