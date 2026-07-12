---
name: fleet-ops
description: >-
  Operate the user's AI agent fleet — inventory, health triage, silent-failure
  alerting, and lineage — via anveinspect. Use whenever the user asks about their
  agents' health or activity ("which agents ran today?", "did my cron agent run?",
  "what's burning tokens?", "is anything stale/broken?", "show my agent fleet"),
  wants to be alerted when a scheduled agent misses its window, or asks to
  acknowledge/triage an agent alert. Also use proactively after long automation
  sessions to check nothing silently failed.
---

# Fleet operations

anveinspect inventories every coding agent on this machine (interactive sessions,
scheduled/cron jobs, Task-tool subagents) from Claude Code's own logs — zero
instrumentation — and alerts when a *declared* schedule is missed or token usage
spikes. You are the operator; the MCP tools (`fleet_*`) are your controls.

## Operating loop

1. **Freshness first.** If data could be stale (new session, user just ran agents,
   or `fleet_status` looks empty), call `fleet_scan` — idempotent, ~seconds.
2. **Pulse.** `fleet_status` answers "how is my fleet?" in one call. Lead your
   reply with its pulse line (N agents · N failed · N stale · N open alerts).
3. **Triage.** `fleet_attention` lists everything actionable with reasons and ack
   ids. For any item the user asks about, drill in with `fleet_agent_detail`.
4. **Watch.** When the user says an agent SHOULD run on a schedule ("my autopilot
   posts nightly at 3am"), declare it: `fleet_declare_cadence` with
   `expect: "daily 03:00"` and a sensible grace (default 60m; use the user's
   words to pick). Then `fleet_check` to evaluate immediately.
5. **Resolve.** `fleet_ack` closes an alert the user has seen. Never ack without
   telling the user what you acked.

## Judgment rules

- **Declared cadences are the alerting contract.** Only declare what the user
  states or clearly implies is scheduled. Never guess a cadence into existence —
  a false page costs more trust than a missed insight.
- **Tokens shown as "unavailable" are unknown, not zero.** Say "unavailable
  (transcript unparseable)" — never report 0.
- **Stale ≠ broken.** "Stale" means a previously-active agent (>3 runs) has been
  quiet >7 days. Present it as a question ("did you retire this?"), not a failure.
- **Subagent rows** (trigger `subagent`) are Task-tool children; their tokens are
  real billed usage, already deduplicated against parents. When the user asks
  about top-level agents only, filter with `include_subagents: false`.
- If the fleet database is missing, the fix is always `fleet_scan` — suggest it,
  don't apologize.

## CLI fallback (no MCP available)

All tools mirror the CLI: `npx tsx "${CLAUDE_PLUGIN_ROOT}/../collector/src/cli.ts"
<scan|status|agents|agent <name>|check|cadence declare <agent> "<expect>"|ack <id>>`
— add `--json` for machine-readable output.

## Setup notes for scheduled agents (tell users who run cron jobs)

- Cron/launchd entries should set `ANVEINSPECT_TRIGGER=cron` so runs classify as
  scheduled instead of interactive.
- `claude -p --bare` skips hooks entirely — scheduled invocations must pass
  `--settings` or `--plugin-dir` explicitly or their runs are invisible to hooks
  (the JSONL scan still catches them retroactively).

## Alert delivery & scheduling

- Slack delivery: user adds `{"slackWebhookUrl":"https://hooks.slack.com/..."}` to
  `~/.anveinspect/notify.json`. Delivery is exactly-once per alert; failures retry
  on the next tick and are never silently lost.
- Standing watch: `anveinspect schedule install` writes a launchd job (every 15
  minutes: scan -> check -> deliver), then the USER activates it with
  `launchctl load ~/Library/LaunchAgents/com.anveinspect.tick.plist`. Never
  activate it yourself without the user's explicit go-ahead — it is persistent
  machine configuration. `anveinspect schedule status` shows both halves.

## AI layer (analysis over the fleet)

You ARE the intelligence layer; anveinspect supplies deterministic facts. For any
briefing/summary/analysis request ("how's my fleet?", "fleet report", "what changed
this week?", "what's expensive?"), call `fleet_report` first — one call, the whole
picture, formatted for reasoning — then narrate: headline, needs-action (with exact
ack/declare commands), trend interpretation, hygiene. `fleet_insights` gives the
same analytics as raw structured data when you need exact numbers or charts.
Rules: quote the report's numbers verbatim (never recompute or invent); treat
`provenance: inferred` values as suggestions for the user, not truths; data-quality
notes (tokens unavailable, basename identities) belong in the briefing when they
materially weaken a conclusion. Non-MCP assistants can pull the same bundle from
http://localhost:4177/api/ai (markdown).
