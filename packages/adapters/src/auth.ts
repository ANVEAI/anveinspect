import { createHash, createHmac, createSign } from 'node:crypto';

/** Explicit request signing — no SDK credential chains (eng review D3 constraint). */

// ---------- AWS SigV4 ----------
export interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

export function sigv4Headers(opts: {
  creds: AwsCreds;
  method: string;
  host: string;
  path: string;
  query?: string;
  body: string;
  region: string;
  service: string;
  now?: Date;
}): Record<string, string> {
  const t = opts.now ?? new Date();
  const amzDate = t.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    host: opts.host,
    'x-amz-date': amzDate,
    'content-type': 'application/json',
  };
  if (opts.creds.sessionToken) headers['x-amz-security-token'] = opts.creds.sessionToken;
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    opts.method,
    opts.path,
    opts.query ?? '',
    canonicalHeaders,
    signedHeaders,
    sha256hex(opts.body),
  ].join('\n');
  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + opts.creds.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, opts.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ---------- Microsoft Entra ID client-credentials ----------
export async function entraToken(
  fetchFn: typeof fetch,
  tenantId: string,
  clientId: string,
  clientSecret: string,
  scope: string,
): Promise<string> {
  const res = await fetchFn(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Entra token request failed (${res.status}): ${json.error_description ?? 'no access_token'}`);
  }
  return json.access_token;
}

// ---------- Google service-account JWT bearer ----------
export interface GcpServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export async function gcpToken(fetchFn: typeof fetch, key: GcpServiceAccountKey, now = new Date()): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  const tokenUri = key.token_uri ?? 'https://oauth2.googleapis.com/token';
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform.read-only',
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key).toString('base64url');
  const res = await fetchFn(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`GCP token exchange failed (${res.status}): ${json.error_description ?? 'no access_token'}`);
  }
  return json.access_token;
}
