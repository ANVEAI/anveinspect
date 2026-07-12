---
description: Ingest/refresh this machine's agent history into the fleet database
---

Run `fleet_scan` (fallback CLI: `npx tsx "${CLAUDE_PLUGIN_ROOT}/../collector/src/cli.ts" scan --json`), then report: agents found, runs, subagent lineage edges, and how many runs have tokens unavailable. Idempotent — safe to re-run anytime.
