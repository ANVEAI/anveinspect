#!/usr/bin/env node
// Bundle the CLI, MCP server, and dashboard into dist/ so the installed package
// runs on plain node — no tsx, no workspace resolution, no build step for users.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'dist'), { recursive: true });

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3'], // native — installed as a real dependency
  logLevel: 'error',
  banner: { js: '#!/usr/bin/env node' },
};

await build({ ...shared, entryPoints: [join(root, 'packages/collector/src/cli.ts')], outfile: join(root, 'dist/cli.mjs') });
await build({ ...shared, entryPoints: [join(root, 'packages/mcp/src/server.ts')], outfile: join(root, 'dist/mcp.mjs') });
copyFileSync(join(root, 'dashboard/index.html'), join(root, 'dist/index.html'));
chmodSync(join(root, 'dist/cli.mjs'), 0o755);
chmodSync(join(root, 'dist/mcp.mjs'), 0o755);
console.log('bundled: dist/cli.mjs, dist/mcp.mjs, dist/index.html');
