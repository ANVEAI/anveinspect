# Contributing to AnveInspect

Thanks for taking the time to contribute. AnveInspect is a local-first observability
tool for AI agent fleets, and it stays useful only if it stays **honest, safe, and
never crashes the watchdog**. Those three rules shape everything below.

## Ground rules

1. **Never break the watchdog.** The collector reads transcripts a user's agents
   already wrote — a single corrupt, truncated, or hostile file must never throw,
   hang, or lose data. Guard every `JSON.parse`, clamp every external number, and
   fail safe. There are fuzz + scale tests that enforce this; keep them green.
2. **Honest data only.** Token counts unavailable ≠ zero. Dollar figures are
   estimates and are labeled as such. Inferred cadences suggest; only *declared*
   ones page. If you can't measure it, say "unavailable" — never invent a number.
3. **Read-only to the outside world.** Cloud connectors are catalog-only,
   least-privilege, and credentials stay client-side in `~/.anveinspect/`. No code
   path may mutate a remote platform or exfiltrate a transcript.

## Getting set up

```bash
git clone https://github.com/ANVEAI/anveinspect.git
cd anveinspect
npm install
npm test          # 100 tests — unit, e2e, fuzz, scale, adapters, dashboard
npm run typecheck # 0 errors expected
npm run dash      # dashboard at http://localhost:4177 (needs a scanned db)
```

Node 20+ is required (`engines` in `package.json`; CI runs on 22).

## Project layout

| Path | What lives there |
|---|---|
| `packages/schema` | Vendor-neutral types + SQLite DDL + fingerprinting |
| `packages/collector` | Scanners, cadence engine, connectors, queries, CLI, dashboard server |
| `packages/adapters` | Isomorphic platform connectors (pure `fetch`, no vendor SDKs) |
| `packages/mcp` | The stdio MCP server (16 `fleet_*` tools) |
| `packages/plugin` | The Claude Code plugin (skill + slash commands + hooks) |
| `dashboard` | Single-file SPA served on loopback |
| `tests` | vitest suites, colocated by concern |

One shared query layer (`packages/collector/src/queries.ts` + `lineage.ts` +
`analytics.ts`) feeds the CLI, MCP, and dashboard so every surface reports the
**same numbers**. If you add a metric, add it once there.

## Making a change

1. Branch from `main`.
2. Write the change **and a test** — every bug fix lands with a regression test,
   every feature with coverage. Prefer real behavior over mocks (the suite drives
   real SQLite, real HTTP, real scanned fixtures).
3. Run `npm run typecheck && npm test` — both must be clean.
4. If your change is observable in the dashboard, verify it in a browser.
5. Open a PR using the template. Describe the user-visible effect, not just the diff.

## Commit style

Conventional, imperative subject lines (`fix: clamp negative token counts`).
Keep commits focused; a bug fix and a refactor are two commits.

## Reporting bugs & security

- Functional bugs → open an issue with the template (include your OS, Node version,
  and what `anveinspect doctor` prints).
- Security issues → **do not** open a public issue; see [SECURITY.md](SECURITY.md).

By contributing you agree your work is licensed under the project's
[MIT License](LICENSE).
