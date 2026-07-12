---
description: Fleet pulse — agent counts, open alerts, stale agents
---

Report the user's agent-fleet health.

1. Call the `fleet_status` MCP tool (fallback CLI: `npx tsx "${CLAUDE_PLUGIN_ROOT}/../collector/src/cli.ts" status --json`).
2. Lead with the pulse line exactly as the data states it (N agents · N failed · N stale · N open alerts).
3. List each open alert and stale agent with its plain-language reason.
4. If the database is empty or missing, run `fleet_scan` first, then retry once.
5. Offer next actions only if something needs attention (detail, declare cadence, ack).
