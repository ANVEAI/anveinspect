#!/usr/bin/env node
// Plugin MCP launcher — mirrors packages/collector/bin/anveinspect.mjs.
//  - dev checkout: the TypeScript server exists -> run it via tsx
//  - installed package: only the plain-node bundle ships -> run dist/mcp.mjs
// This is why .mcp.json points here instead of hardcoding a tsx path: the raw
// `src/server.ts` is not in the published tarball, so a hardcoded tsx path would
// break the plugin for anyone who installed AnveInspect from npm.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url)); // packages/plugin/bin
const srcServer = resolve(here, '..', '..', 'mcp', 'src', 'server.ts'); // dev only
const distServer = resolve(here, '..', '..', '..', 'dist', 'mcp.mjs'); // published

const res = existsSync(srcServer)
  ? spawnSync('npx', ['tsx', srcServer], { stdio: 'inherit' })
  : spawnSync(process.execPath, [distServer], { stdio: 'inherit' });
process.exit(res.status ?? 1);
