# fleetdeck (working codename — see docs/naming.md before launch)

Agent fleet control plane: discovery, lineage & inventory for coding agents.
Zero-instrumentation — reads the logs your agents already write.

**Status:** Slice 1 (local collector + dashboard). Design doc & review record:
`~/.gstack/projects/voice-forms/adarshkant-agent-fleet-design-20260713-002813.md`

```
claude hooks ──▶ fleet-emit ──▶ spool ─┐
                                        ├──▶ SQLite ──▶ local dashboard (:4177)
~/.claude/projects JSONL ──▶ scanner ──┘        └──▶ (Slice 2+) outbox ──▶ hosted backend
```

## Quick start

```bash
npm install
npm run scan     # inventory this machine's Claude Code fleet -> fleet-data/fleet.db
npm run dash     # dashboard at http://localhost:4177
npm test
```

## Packages

- `packages/schema` — vendor-neutral types, agent fingerprinting (git-remote-first,
  machine-independent), SQLite DDL. Cadences bind to (agent, machine) pairs.
- `packages/collector` — JSONL scanner (hooks-primary/JSONL-enrichment split;
  cross-file usage dedup by message.id+requestId — the ccusage #913 bug class;
  subagent lineage via `subagents/agent-*.jsonl` + meta.json), scan CLI, store.
- `packages/plugin` — Claude Code plugin: hooks.json (SessionStart/End, Subagent*,
  Stop/StopFailure, PostToolUse) + `fleet-emit` spool writer. Observation-only,
  always exits 0, never blocks the agent.
- `packages/adapters` — (Slice 3, gated) isomorphic platform connectors.
- `dashboard` — approved dark-ops-console design; fleet-pulse headline,
  needs-attention strip, inventory table. Tokens render "unavailable", never 0,
  when JSONL was unparseable.

## Known constraints (from research, 2026-07-13)

- Hooks carry NO token data — JSONL is the sole usage source; parser must degrade
  gracefully (undocumented format, drifts across CC versions).
- `claude -p --bare` skips hook discovery (may become default): fleet cron jobs
  must pass `--settings`/`--plugin-dir` explicitly, and set `FLEETDECK_TRIGGER=cron`.
- SessionEnd is graceful-only: crash detection = heartbeat ledger + PID liveness
  (fleet-emit records claudePid) + transcript reconciliation.
- Claude Code cleans JSONL after ~30 days — scan early, persist everything.
