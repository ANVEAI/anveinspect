import { execFileSync } from 'node:child_process';
import type { Vendor } from '@anveinspect/schema';

/**
 * Resolve connector credentials from the platform's OWN CLI session, so the
 * user never pastes an API key. connectors.json may set `"auth": "cli"` (or
 * omit config entirely) for a vendor to opt into this path; explicit config
 * always wins. Credentials are fetched at sync time and never persisted.
 */

function run(cmd: string, args: string[], timeoutMs = 8000): string {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

export interface ResolvedCredResult {
  config: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Given the user's connectors.json entry for a vendor, return a fully-resolved
 * config. If the entry says auth:cli (or is empty for a cloud vendor), pull
 * live credentials from the platform CLI.
 */
export function resolveViaCli(vendor: Vendor, entry: Record<string, unknown> | undefined): ResolvedCredResult {
  const wantsCli = !entry || entry.auth === 'cli' || Object.keys(entry).filter((k) => k !== 'auth').length === 0;
  // explicit config present -> caller uses it directly
  if (entry && !wantsCli) return { config: entry, error: null };

  try {
    switch (vendor) {
      case 'vertex': {
        const accessToken = run('gcloud', ['auth', 'print-access-token']);
        const projectId = (entry?.projectId as string) ?? run('gcloud', ['config', 'get-value', 'project']);
        const location = (entry?.location as string) ?? 'us-central1';
        if (!projectId || projectId === '(unset)') {
          return { config: null, error: 'gcloud project not set — run: gcloud config set project <id>' };
        }
        return { config: { projectId, location, accessToken }, error: null };
      }
      case 'bedrock': {
        // aws configure export-credentials emits the resolved chain as JSON
        const raw = run('aws', ['configure', 'export-credentials', '--format', 'process']);
        const j = JSON.parse(raw);
        const region = (entry?.region as string) ?? run('aws', ['configure', 'get', 'region']) ?? 'us-east-1';
        return {
          config: {
            region,
            accessKeyId: j.AccessKeyId,
            secretAccessKey: j.SecretAccessKey,
            sessionToken: j.SessionToken,
          },
          error: null,
        };
      }
      case 'cloudflare': {
        // wrangler holds the OAuth token; surface accountId from whoami
        const who = run('wrangler', ['whoami']);
        const acct = who.match(/([0-9a-f]{32})/i)?.[1];
        if (!acct) return { config: null, error: 'could not read Cloudflare account id from `wrangler whoami` — set accountId + apiToken in connectors.json' };
        // wrangler does not expose its OAuth token for reuse; require an API token here
        if (!entry?.apiToken) {
          return { config: null, error: 'Cloudflare needs a Workers Scripts:Read API token: anveinspect connectors set cloudflare apiToken <token> (wrangler login alone is not reusable for the API)' };
        }
        return { config: { accountId: (entry.accountId as string) ?? acct, apiToken: entry.apiToken }, error: null };
      }
      default:
        return { config: null, error: `${vendor}: no CLI-auth path — provide explicit config in connectors.json` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { config: null, error: `${vendor}: CLI credential resolution failed (${msg.slice(0, 120)}). Sign in first, or provide explicit config.` };
  }
}
