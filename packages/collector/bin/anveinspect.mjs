#!/usr/bin/env node
// Thin launcher so `anveinspect <cmd>` works as an installed bin.
// Uses tsx to run the TypeScript CLI directly (no build step for v1).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.ts');
const res = spawnSync('npx', ['tsx', cli, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
