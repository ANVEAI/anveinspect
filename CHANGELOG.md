# Changelog

All notable changes to AnveInspect are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Zero-instrumentation collector** — reads `~/.claude/projects` (Claude Code)
  and `~/.codex/sessions` (Codex) transcripts; no SDK, keys, or code changes.
- **Agent inventory** — every agent across Claude Code, Codex, OpenClaw, Hermes,
  and read-only cloud connectors (Bedrock, Vertex, Foundry, Cloudflare), with
  last-run, run count, staleness, and 30-day token totals.
- **Lineage** — spawn-tree explorer plus an **agent-to-agent relationship graph**
  (who spawns whom across all executions, with per-relationship tokens and
  parent→child / child→parent data-sharing volume).
- **Silent-failure alerting** — declare when an agent *should* run
  (`daily HH:MM` · `weekdays HH:MM` · `weekly mon HH:MM` · `every Nh`) and get
  paged when it doesn't; token-spike detection at >3× trailing median; dedup per
  window; Slack delivery with a launchd standing watch.
- **Cost analytics** — estimated 30-day spend by model / agent from an editable
  `~/.anveinspect/pricing.json`; honest priced / partially-priced / unpriced /
  tokenless coverage.
- **"Why running" insight** — runs grouped by trigger (interactive / subagent /
  scheduled / hook).
- **Subagent health** — active / idle / stale buckets and an execution timeline.
- **Local control** — organize the fleet with local tags/groups (never touches a
  platform).
- **16 MCP tools** so Claude can operate the fleet, plus a Claude Code plugin
  (skill + `/anveinspect:*` slash commands + hooks).
- **Dashboard** — a dependency-free single-file SPA on `127.0.0.1:4177` with six
  views; one shared query layer feeds the CLI, MCP, and dashboard identically.

### Security

- Dashboard binds to loopback only; state-changing POSTs are same-origin-checked
  and body-size-capped.
- Connector credentials stay client-side (`~/.anveinspect/connectors.json`, 0600)
  and never enter the fleet database.
- Scanner clamps negative / NaN token counts and fails safe on corrupt, truncated,
  or hostile transcripts (fuzz + scale tested).
- Cadence intervals are bounds-checked (1h–8760h) so a declared watchdog can't be
  silently disabled.

[Unreleased]: https://github.com/ANVEAI/anveinspect/commits/main
