# Autonomous run — 2026-07-13 (until 09:30)

Goal: enterprise SaaS inventory + lineage platform — insights & holistic views on
what's running, why, agent insights, and control, in a single dashboard.

## Guardrails
- Real agent EXECUTION only on free/local platforms (Claude subagents, Codex,
  Hermes/OpenClaw local). NO continuously-billing cloud deploy loops (Vertex/CF
  stay read-only connector syncs). Vertex Agent Engine already failed runtime
  contract + auto-rolled-back; not retrying unattended.
- Every build cycle: verify (tests + browser) before commit. Never commit red.

## Cycle log

### Cycle 1 (lineage) — DONE
- Ran wave-1 real agents (4 Claude workers + Codex) → fleet 1500→1510 runs, +10 edges
- Built lineage.ts: spawn-tree API (lineageTree/topLineageRoots/lineageSummary),
  subtree token rollup, descendant counts, cycle guard
- Wired: /api/lineage + /api/lineage/tree endpoints, CLI `lineage`, fleet_lineage
  MCP tool (14 tools total), Lineage dashboard view (KPIs + spawns-by-platform +
  expandable spawn trees w/ status dots + tokens)
- Verified live: 1335 edges, 17 roots, widest fan-out voice-forms=557; tree
  expansion shows root 618k subtree tokens w/ general-purpose children
- 62 tests green (5 new lineage tests). Worker findings captured for next cycles:
  agent-detail drilldown (CRITICAL), activity timeline, cost-per-platform,
  busiest-hours, failure-clustering, safe local control (tag/group/snooze/retire).

### Cycle 2 (agent detail + lineage hardening) — DONE
- Wave 2 agents (3 Claude workers + 2 Codex). One worker adversarially probed
  lineage.ts and found REAL bugs — fixed:
  * unguarded JSON.parse in tokensOf → crash on malformed tokens (now returns null)
  * N+1: topLineageRoots/lineageSummary built a full tree per root just to count
    → replaced with load-edges-once adjacency map + BFS (0.47s on 1335 edges)
  * per-node child cap (500) so pathological fan-out can't build unbounded tree
- Built agent-detail drawer: click any agent row (table or top-consumers) → slide-in
  panel with stats (runs/spawns/tokens), cadence + declare prompt, token-trend
  sparkline, run-history timeline with status dots. /api/agent endpoint.
- verified live (voice-forms: 30 runs, 1338 spawns, 5.8M tok, run history). 62 green.

### Cycle 3 (cost + activity analytics) — DONE
- Wave 3 (2 Claude workers). Built pricing.ts (editable ~/.anveinspect/pricing.json,
  default estimates, opus>sonnet>fable~haiku) + analytics.ts (cost by model/vendor/
  agent, busiest hours, failure bursts; honest priced/unpriced/tokenless coverage).
- Wired: /api/analytics, CLI `costs`, fleet_analytics MCP tool (15 tools), Overview
  cost section (KPI + cost-by-model bars + clickable most-expensive-agents + hours).
- verified live: est $9.2k/30d (opus 96%, voice-forms $7.3k), busiest 2am, 0 bursts.
  66 tests green (4 new). Dollars labeled estimates; token counts exact.

### Cycle 4 (activity timeline) — DONE
- Started a 2h continuous background loop (codex probe + scan + check every 12min,
  logging fleet health to ~/.anveinspect/continuous-run.log).
- Built recentActivity() + /api/activity + Activity dashboard view: live
  chronological feed (agent, vendor, trigger, status dot, tokens, rel time),
  click-through to agent detail. Safe token parsing.
- verified live: feed shows the continuous loop's codex probes + Claude subagents
  in real time. 67 tests green (1 new).

### Cycle 5 (control: agent tagging) — DONE
- Built tags.ts: LOCAL agent tags/groups (cohort/tier/owner/retire), write-only
  to fleet db, never touches any platform. agent_tags table (additive migration).
- Wired: listAgents/agentDetail decorated with tags, /api/tag + /api/untag,
  CLI `tag add|remove|list`, fleet_tag MCP tool (16 tools), drawer tag editor
  (add/remove chips) + inline tag chips in agent list.
- verified live: tagged voice-forms #critical #production, chips render in table
  + drawer, add/remove works. 71 tests green (4 new). Cleaned demo tags after.

### Cycle 6 (adversarial hardening pass) — DONE
- Ran a Codex adversarial review of all Cycle 1-5 modules. It found 9 valid issues;
  fixed 8, documented 1 as a known limitation.
- Crash guards (P2): unguarded JSON.parse in listAgents + agentDetail (one corrupt
  token/models blob -> 500) now safeParse/sumTokens -> null/[] fallback. analytics
  new Date(NaN).toISOString() throw (one bad started_at broke /api/analytics) now
  guards NaN before pushing/formatting.
- Missing-table (P2): agent_tags write path CREATE IF NOT EXISTS; read paths return
  empty when the table predates the migration (read-only handle can't create it).
- Cost honesty (P2): mixed known+unknown model runs were reported fully priced with
  the unknown cost silently dropped. costOf now returns partial:true and analytics
  surfaces partiallyPricedRuns. LIVE fleet had 2 such runs — real undercount, now visible.
- Perf/DoS (P2/P3): lineage child query LIMIT 500 in SQL (was slice-after-load);
  recentActivity clamps limit (-1 = no-limit in SQLite); dashboard withDb() closes
  every handle even on throw (was leaking on error); POST body cap 64KB -> 413.
- Known limitation (P3, not fixed): lineage multi-parent DAG edges undercount a
  shared child. Claude/Codex spawns form a tree (one parent per subagent run); the
  seen-set is a correct cycle guard. True multi-parent rendering is a design change
  that risks exponential blowup, not a bug fix.
- verified: typecheck clean, 76 tests green (+5: partial-pricing + 4 hardening
  regressions). All endpoints 200; tag round-trip, 413 body cap, 403 cross-origin
  all confirmed live. README updated with dashboard/insights/control sections.

### Cycle 7 (why-running insight) — DONE
- Closed the goal's explicit "why running" gap. Added whyRunning to computeAnalytics
  (30d runs grouped by trigger_source: interactive/subagent/scheduled/hook), exposed
  on /api/analytics, rendered a "Why running · runs by trigger" card on Overview with
  human-readable labels.
- verified live: 1196 subagent-spawned vs 307 interactive runs — 80% of fleet
  activity is agents spawning agents. Card renders, no console errors, 76 tests green.

### 2-hour continuous test — PASSED
- Ran 04:11 → 06:14 IST, 10 iterations (scan + check every 12 min). Rock stable
  throughout: 146 agents, 1 alert, 8 stale, zero crashes or drift.
- Iterations 4-10 (04:48 on) ran AFTER the Cycle 6/7 code changes landed and stayed
  green — the hardened read paths held up under continuous re-scan on the live fleet.
- Restarted a second window (continuous-run-2.log) to keep validating until the
  user returns ~09:30.

## Session summary (post-compaction cycles)
- Cycle 6 (3a06db0): adversarial hardening — 8 of 9 Codex findings fixed
- Cycle 7 (591907c): "why running" trigger insight (1196 subagent vs 307 interactive)
- 1382abb: partial-pricing count surfaced in CLI
- Final state: 76 tests green, typecheck clean, 16 MCP tools, 6 dashboard views,
  all endpoints 200, 2h continuous test passed. Product covers the full goal:
  what's running / why running / insights / control in one dashboard.

### Cycle 8 (agent relationship graph) — DONE (user-requested)
- agentGraph() in lineage.ts: collapses run-level spawn edges onto agent identities
  (nodes = agents w/ runs/spawnsOut/spawnsIn, edges = who-spawns-whom w/ counts +
  lastSpawnAt). Edge cap 150 w/ honest truncated flag. /api/graph endpoint.
- Dashboard Lineage view: interactive canvas force-directed graph, zero deps.
  Node size = run volume, color = platform (legend), edge width/label = spawn count,
  arrowheads = direction, self-spawn loop arcs. Drag to arrange, hover tooltip
  (runs/spawned/was-spawned), click -> agent drawer. Collision + label-declutter
  passes so 22 labels stay readable; sim stops when the view unmounts.
- verified live: 22 agents / 21 relationships, voice-forms hub (1061x -> workflow-
  subagent), click-through to drawer works, no console errors. 79 tests green (+3).
