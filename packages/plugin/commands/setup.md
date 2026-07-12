---
description: Connect AnveInspect to your agent platforms (plug-and-play onboarding)
---

Onboard the user's fleet. AnveInspect reuses the platform CLIs they've already
signed into — no API keys to paste.

1. Call the `fleet_setup` MCP tool (fallback CLI: `npx tsx "${CLAUDE_PLUGIN_ROOT}/../collector/src/cli.ts" doctor --json`). It detects every platform, reuses gcloud/aws/wrangler/az logins, does a first scan, and reports what's connected.
2. Present the result as a short checklist:
   - **Connected** platforms (ready) — say how many agents each contributed.
   - **One-time signin** needed — for each, show the EXACT `fixCommand` verbatim (e.g. `wrangler login`, `az login`, `gcloud auth login`). Tell the user to run it in their terminal, then ask you to re-run setup.
   - **Not present** platforms — mention briefly, no action needed.
3. Lead with the win: "Your fleet is live: N agents across M platforms." Then the signin list, shortest path first.
4. Offer the two value actions immediately: declare a cadence on any scheduled agent (`/anveinspect:watch`), and — if they run agents unattended — the standing watch (`anveinspect schedule install` + Slack webhook in `~/.anveinspect/notify.json`).
5. Never ask for API keys unless a platform genuinely has no CLI-auth path (only Cloudflare needs a Workers Scripts:Read token; `anveinspect connectors set cloudflare apiToken <token>`).
