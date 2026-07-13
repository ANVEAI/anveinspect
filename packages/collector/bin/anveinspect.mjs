#!/usr/bin/env node
// `anveinspect <cmd>` launcher.
//  - installed package: runs the plain-node bundle (dist/cli.mjs) — no tsx needed
//  - dev checkout: runs the TypeScript CLI via tsx
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcCli = join(here, '..', 'src', 'cli.ts'); // present only in the dev checkout
const distCli = resolve(here, '..', '..', '..', 'dist', 'cli.mjs');

const res = existsSync(srcCli)
  ? spawnSync('npx', ['tsx', srcCli, ...process.argv.slice(2)], { stdio: 'inherit' })
  : spawnSync(process.execPath, [distCli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
