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

### Cycle 9 (relationship intelligence) — DONE (user-requested)
- Research first: subagent JSONLs carry the payload both ways (first user msg =
  parent→child prompt, last assistant msg = child→parent result); meta.json has
  agentType; run rows already have start/end for temporal overlap.
- Data sharing: spawns.prompt_chars/result_chars (additive migration, rescan
  backfills via insertSpawn upsert); scanner extracts both via contentChars().
- agentGraph edges enriched: tokens (child consumption per relationship),
  dataDown/dataUp chars; nodes get activity status (active<24h/idle/stale>7d).
- subagentHealth(): active/idle/stale/total of subagent-triggered agents.
- runTimeline(): Gantt-ready rows (root + BFS descendants, chronological,
  open-ended runs stay null-ended).
- Dashboard Lineage: 2 new KPIs (active/stale subagents), "Data flow per
  relationship" table (spawns/tokens/data↓/data↑/status pill/last active),
  "Activity windows" Gantt w/ root selector + hover detail; node tooltips show status.
- MCP parity: fleet_lineage now returns relationships + subagents and narrates them.
- verified live: voice-forms→workflow-subagent = 1061 spawns / 21.4M tok / 4.2M ch
  down / 2.0M ch up; subagents 2 active / 7 idle / 12 stale of 21; Gantt shows
  main-agent bar vs subagent burst windows. 84 tests green (+5), no console errors.

### Cycle 10 (extensive real-user QA) — DONE (user-requested)
Tested every surface like a new user. 4 real bugs found and FIXED, all with regressions:
- T1 fresh install: doctor on an empty ANVEINSPECT_DB → full fleet (146 agents,
  1683 runs, all 1340 payload edges) from a cold scan. PASS.
- T2 CLI surface: 16/16 commands pass incl. --json (all parse). PASS.
- T3 bad inputs: 5/6 clean actionable errors. BUG 1: `ack <typo-id>` silently
  succeeded → now exits non-zero with guidance (+e2e regression).
- T4 MCP: 16/16 tools pass. BUG 2: fleet_agent_detail used param `name` while
  sibling tools use `agent` — operators guess wrong → standardized on `agent`.
- T5 dashboard walkthrough: search (146→1), vendor filter (hermes=63), status
  filter (stale=8), token sort, drawer, tag add/remove round-trip, activity feed,
  attention+ack button, connectors cards, timeline root switch (12 options),
  refresh, /llms.txt. All PASS. BUG 3: unknown /api/* routes returned HTML 200
  → now JSON 404. Path-traversal + XSS-ish params already clean 404s.
- T6 trust: CLI vs dashboard vs MCP report IDENTICAL pulse (146/1/8). PASS.
- T7 live connector sync: openclaw 38 + hermes 63 + vertex 0 (correct) PASS.
  BUG 4 (live-API catch): empty `cloudflare: {}` entry from `connectors init`
  bypassed plug-and-play CLI resolution and called the real CF API with
  accountId=undefined → HTTP 404. Empty configs now fall through to CLI path →
  honest "needs a Workers Scripts:Read token" hint (+deterministic regression).
- Hygiene: real fleet DB untouched (0 leftover tags/cadences); QA ran on an
  isolated scratchpad DB. 86 tests green (+2), typecheck clean.

### Cycle 11 (deep end-to-end sweep) — DONE (user-requested)
Surfaces not covered by Cycle 10, tested for real. 2 more bugs fixed:
- E2E-A zero-history user: CLI 7/7 + all dashboard endpoints 200 on an EMPTY db;
  missing-db guidance is friendly. BUG 5: check/tag/cadence/ack (write paths)
  leaked raw SQLite "cannot open database" -> added openDbRw/openTagsDb with the
  same actionable message everywhere.
- E2E-B hooks pipeline: fleet-emit -> spool -> consumeSpool classification chain
  proven (env override > CI > child-session > tty). BUG 6: fleet-emit hardcoded
  the spool path (untestable + inconsistent with ANVEINSPECT_DB) -> now honors
  ANVEINSPECT_SPOOL. Cleaned the one stray QA event from the real spool.
- E2E-C alerting vs a REAL local webhook: declare cadence -> check detects missed
  window (12h overdue, correct math) -> deliver posts 4 Block Kit payloads ->
  re-deliver sends 0 (exactly-once). PASS.
- E2E-D tick: scan+check+deliver in one command; dedup holds across commands. The
  REAL launchd standing watch is loaded + healthy (exit 0, 15-min ticks). PASS.
- E2E-F packaging: bin entrypoint runs (anveinspect.mjs -> status works), npm run
  build passes, CI workflow (typecheck+tests+MCP handshake) well-formed. PASS.
- E2E-G concurrency: 728 dashboard reads during a live scan, 0 failures (WAL). PASS.
- Setup note for founder (not a bug): the real ~/.anveinspect/notify.json has no
  slackWebhookUrl yet, so the standing watch pages nobody. One line to fix.
86 tests green, typecheck clean, real DB/spool left clean.

### Cycle 12 (installation + bindings + positioning) — DONE (user-requested)
- REAL installability: esbuild bundles (dist/cli.mjs 122KB, dist/mcp.mjs 832KB,
  index.html) run on plain node — no tsx/workspaces at runtime. package.json:
  name=anveinspect, files, prepack, engines>=20, smart bin launcher (dev->tsx,
  installed->bundle). PROVEN with a real npm pack -> install into a scratch
  prefix -> installed bin runs status, serves the dashboard, and the installed
  MCP bundle lists all 16 tools. (Fixed a double-shebang that broke mcp.mjs.)
- Bindings: `anveinspect setup claude|codex|cursor` prints exact registrations
  with THIS install's resolved paths (plugin dir / claude mcp add / config.toml /
  mcp.json). New `anveinspect dash [port]` — dashboard server moved into the
  collector (dashboard/server.ts is now a thin dev shim) so installs get it too.
- Paging out of the box: with no Slack webhook, alerts land in macOS Notification
  Center (osascript, argv-passed — no quoting injection; injectable for tests;
  {"desktopNotifications":false} opts out). The PRODUCTION launchd tick delivered
  the real Explore token-spike alert via Notification Center on its own at 12:40
  IST — the "watch pages nobody" gap is closed with zero config.
- YC positioning (researched: descriptive one-liner, plain language, <80-word
  hero): README hero rewritten ("See every AI agent you run — what it costs, who
  spawned what, and get paged when one silently stops"), honest install block,
  bindings section, macOS pager documented. Dashboard: first-run welcome hero
  (3-step quickstart, verified on an empty db) + sidebar tagline.
- connectors init no longer writes the empty-placeholder cloudflare/vertex trap.
- 91 tests green (+5: 3 desktop-notify incl. failure-retry, 2 setup-bindings).

### Cycle 12 (product promo video) — DONE (user-requested)
- 61s product-motion promo rendered: videos/anveinspect-promo/renders/video.mp4
  (1920x1080 h264 + aac, 20MB, mean -15.9dB / peak -1.9dB).
- Pipeline: HyperFrames /product-launch-video — live-dashboard capture (real UI,
  all views), Broadside preset remixed onto brand tokens (#0a0d12 ink / #3ecf8e
  accent), 9-frame storyboard on a 118bpm grid, 9 parallel frame workers,
  4 verified crossfades, MusicGen BGM (local; muxed post-render after the
  assembler raced the pending track).
- Story: 1,512-runs hook -> six-platforms problem -> wordmark + real UI dock ->
  counted inventory (146/4/$9.3k) -> 9s lineage-graph hero (1,061x callout) ->
  80% agents-spawning-agents stat -> missed-window alert -> no SDK/keys/changes
  -> npx anveinspect doctor CTA. All stats real from this fleet.
- Gate fixes: 5 missing root data-durations (broke transition inject), SFMono
  font tokens in 4 frames, frame-6 line overflow (2270px line on a 1920 canvas).
  Lint/validate/inspect 0 errors; contact sheets eyeballed before render.
- Higgsfield note: its audio tool is speech-only (music model locked to the game
  pipeline), so BGM came from local MusicGen instead.

### Cycle 13 (promo v2 — motion-graphics upgrade) — DONE (user-requested)
- v1 copied to ~/Desktop/anveinspect-promo.mp4; v2 rendered + delivered to
  ~/Desktop/anveinspect-promo-v2.mp4 (61s, 1920x1080, h264+aac, 42MB).
- v2 upgrades: binding chrome system (section kickers + frame numbers + a top-edge
  progress rail filling 1/9 per frame), layered ground system everywhere (dot-grid
  + drifting glow + vignette + film grain), NATIVE animated SVG lineage graph for
  the hero (hub blooms, 12 weighted satellites spring in, edges draw, 1,061x
  counts up; real screenshot crossfades in as proof), ghost "1,512" backdrop
  numeral, connector-lattice overload in the problem frame, floor reflection under
  the docked UI, stat cards w/ synced bar-fills, 80% progress ring, EKG flatline
  into the alert, log-texture backdrop.
- Gate: 2 SFMono lint stragglers fixed; lint/validate/inspect 0 errors; 4
  transitions verified; contact sheet reviewed. Project: videos/anveinspect-promo-v2.

### Cycle 14 (scale + fuzz + corruption + load) — DONE (user-requested)
Adversarial test round beyond functional QA. 3 real bugs found + fixed w/ regressions:
- SCALE: synthetic 10k agents / 100k runs / 60k spawns. Every shared hot query
  under budget: listAgents 212ms, fleetStatus 208ms, analytics 245ms, insights
  305ms, agentGraph 111ms (correctly capped 150 edges, truncated=true), lineage
  30-91ms, timeline/activity/health single-digit ms. All < 3s.
- FUZZ (scanner): garbage/truncated/binary JSONL, null shapes, 200-deep nesting,
  2MB fields, unicode names, corrupt subagent meta.json — scanner never threw,
  kept the one valid session. BUG 7: negative/NaN token counts recorded verbatim
  (would poison cost + spike math) -> nonNegTokens() clamps at ingestion.
- FUZZ (cadence grammar): 18 malformed inputs. BUG 8: "every 0h" parsed to a
  zero interval = a declared watchdog that can NEVER report overdue (silent-failure
  trap); BUG 9: "every 99999999999h" overflowed date math to Invalid Date. Both
  now bounded to 1h..8760h with an actionable error.
- CORRUPT DB: garbage bytes / truncated / empty db files all give clean non-zero
  errors (no stack traces). Polished: corruption keywords now append a "rm + rescan"
  recovery hint (it's a rebuildable cache).
- LOAD: 5000 requests across 5 endpoints, 0 failures; RSS 85MB->54MB after GC
  (no leak); 0 leaked fleet.db handles (withDb holds under sustained load).
- 100 tests green (+3), typecheck clean. Real fleet DB untouched (scratchpad DBs).

### Cycle 15 (OSS professionalization + real-world UX) — DONE (user-requested)
Made the repo a professional open-source project + tested real user journeys.
- OSS scaffolding: CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, .editorconfig,
  .nvmrc, .github issue forms + PR template, README badges + Contributing/Security/
  License footer, package.json author/homepage/bugs.
- Repo hygiene: untracked the two 60MB promo MP4s (marketing artifacts, kept on
  disk + Desktop, gitignored) — heaviest tracked file dropped 40MB → 112KB.
  Expanded .gitignore (video build outputs, editor dirs, logs, coverage).
- REAL-WORLD TESTS: (a) upgrade path — legacy fleet.db (pre-tags, pre-payload-cols)
  migrates on open, keeps all rows, lights up graph+tags, idempotent; new
  tests/migration.test.ts. (b) publish path — bundle builds, bundled CLI + MCP run
  standalone w/o tsx, npm pack ships right files. BUG 10: plugin .mcp.json hardcoded
  tsx→mcp/src/server.ts which isn't in the tarball → added bin/mcp-launch.mjs
  (dist-or-src) so an npm-installed plugin can start its MCP server.
- 103 tests green (+3), typecheck clean. Commit 3bcaddd.
- Git-watcher contention note: the desktop app's git integration + killed procs
  left a stale index.lock; cleared it and committed with explicit paths +
  GIT_OPTIONAL_LOCKS. Bulk `git add -A` hangs on the untracked video trees — use
  explicit paths.

### Cycle 16 (Linux portability + consistency + math/DST goldens) — DONE (user-requested)
- BUG 11 (fixed): `schedule install` wrote a macOS plist on every OS — Linux users
  got a silently-dead watchdog. Now non-darwin prints a ready-to-paste cron line;
  macOS still writes the plist. +e2e regression (process.platform=linux).
- Cross-surface consistency test: one seeded db driven through CLI --json + dashboard
  HTTP + MCP fleet_status, asserting identical pulse field-by-field ("identical
  numbers everywhere" now enforced, not spot-checked). Calibrated: stale = ageDays>7
  AND run_count>3 (intentional — don't nag barely-used agents).
- Cost math goldens: cache-read/creation priced by own rates (sonnet all-classes
  $22.05) + input×0.1/×1.25 fallback; DST fall-back wall-clock test.
- Portability audit: osascript desktop notify gated on darwin (skips on Linux);
  core scanner/queries/dashboard/MCP have no macOS-only assumptions.
- 108 tests green (+5). Commit after this doc.
