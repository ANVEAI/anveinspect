# anveinspect (working codename — see docs/naming.md before launch)

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
npx tsx packages/collector/src/cli.ts scan      # inventory -> ~/.anveinspect/fleet.db
npx tsx packages/collector/src/cli.ts status    # pulse + open alerts
npm run dash                                    # dashboard at http://localhost:4177
npm test                                        # 17 tests
```

## Operated by Claude (the primary interface)

The plugin (`packages/plugin`) makes any Claude Code session the fleet operator:

- **MCP tools** (`.mcp.json` → `@anveinspect/mcp`, stdio): `fleet_status`,
  `fleet_attention`, `fleet_agents`, `fleet_agent_detail`, `fleet_scan`,
  `fleet_declare_cadence`, `fleet_check`, `fleet_ack` — zod-validated,
  structured content, read-only annotations.
- **Skill** `skills/fleet-ops/SKILL.md`: the operating loop (freshness → pulse →
  triage → watch → resolve) + judgment rules (declared cadences are the alerting
  contract; unavailable ≠ zero; stale ≠ broken; never ack silently).
- **Slash commands**: `/anveinspect:status`, `/anveinspect:scan`,
  `/anveinspect:attention`, `/anveinspect:watch <agent> "<expect>"`.
- **Hooks** (`hooks/hooks.json` + `fleet-emit`): live event spool with PID
  recording for crash detection.

Ask Claude "did my nightly agent run?" / "what's burning tokens?" / "watch my
autopilot, it should post daily at 3am" — that's the product.

## Alerting (Slice 2 wedge, local mode)

Cadence grammar: `daily HH:MM` · `weekdays HH:MM` · `weekly mon HH:MM` ·
`every Nh`. Declared-first: inferred cadences never page. Missed-window uses
grace periods; token-spike fires at >3x trailing median (≥5 runs history);
alerts dedup against open ones (no re-fire storms); ack from CLI, MCP, or the
dashboard's Ack button. CLI/MCP/dashboard all read one query layer —
identical numbers everywhere.

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
  must pass `--settings`/`--plugin-dir` explicitly, and set `ANVEINSPECT_TRIGGER=cron`.
- SessionEnd is graceful-only: crash detection = heartbeat ledger + PID liveness
  (fleet-emit records claudePid) + transcript reconciliation.
- Claude Code cleans JSONL after ~30 days — scan early, persist everything.
