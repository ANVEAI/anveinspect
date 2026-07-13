---
format: 1920x1080
message: "See every AI agent you run — and get paged when one silently stops"
arc: Hook → Problem → Reveal → Proof (inventory → lineage → insight → paging) → Zero-setup → CTA
audience: developers running AI coding agents (X / HN / r/LocalLLaMA)
mode: autonomous
music: dark pulsing electronic, minimal techno undertone, 118bpm, tension building to a confident resolve — think dev-tool launch film
---

## Video direction

- **palette system** — frame.md is truth: ink-black canvas (#0a0d12), off-white ink (#eef2f7), ONE accent = brand green (#3ecf8e) reserved for each frame's payoff; amber/red ONLY in frame 7 as semantic alert colors. Flat planes, 1px hairlines, no decorative gradients.
- **THE CHROME SYSTEM (every frame carries it — this binds the film):** (a) a mono kicker top-left — "/ 01 — THE QUESTION", "/ 05 — LINEAGE" etc. — that mask-wipes in during the frame's first second; (b) a matching dim frame-number top-right ("01"…"09"); (c) a 2px accent **progress rail** along the very top edge whose fill width equals this frame's position in the film (frame N's rail animates from (N-1)/9 to N/9 across the frame's duration — the film literally loads). All chrome sits in the top 60px, dim (~45%), never competing with content.
- **THE GROUND SYSTEM (every frame):** ink-black base + a faint dot-grid texture (24px pitch, 5–7% opacity, CSS radial-gradient tiling) + one very slow off-center radial glow field (accent-tinted at 4–6%, position varies per frame) + a subtle vignette. Built as layered divs on the background clip — gives every frame 3 depth layers before content arrives. A fine film-grain overlay (SVG feTurbulence tile at low opacity, static — not animated) sits above content.
- **type system** — display = massive lowercase 900 (system-ui stack); mono = chrome/labels/counters (ui-monospace stack), tabular-nums on all counting numbers. Display lines get tight letter-spacing (-0.02em); mono chrome gets wide (+0.14em) uppercase.
- **motion grammar** — SILENT music-driven: reveals on the 118bpm grid (beat 0.5085s, bar 2.034s), spread into the back half, never front-loaded. power3/power4 long-tail settles; overshoot only on frame 3's wordmark. Camera: one purposeful move per frame max. Text entrances layer TWO properties minimum (y+blur, x+opacity, scale+blur) — never bare fades.
- **rhythm / held frames** — 6 and 7 end in ≥1.2s deliberate held reads; 5 is the long cinematic build; 1, 2, 8 are percussive.
- **negative list** — no purple-blue AI gradients, no bokeh, no lazy breathing, no slideshow front-load-freeze, no screensaver drift, no stock-looking rounded-card chrome except the alert/terminal rebuilds.

## Frame 1 — Hook: the question you can't answer

- type: hook
- scene: A colossal dimmed "1,512" ghost numeral anchors the backdrop while the question builds over it; the accent word swaps on beats.
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: none (pure type)
- focal: the swapping word
- roles: none (pure type)
- sfx: deep impact on t=0, soft tick per swap

Adapt: keep the in-place token-swap signature; add a depth backdrop — the stat itself as an oversized ghost numeral (the "wallpaper is the data" move).
Scene 1 (0.0–1.0s): ground system resolves; a COLOSSAL "1,512" in display 900 (≈70% frame height, 6% ink opacity, tabular) scale-settles from 1.06 into the backdrop right-of-center — it stays all frame as the depth layer. Chrome kicker "/ 01 — THE QUESTION" wipes in.
Scene 2 (1.0–2.0s): foreground line 1 "your AI agents ran 1,512 times this month." builds per-word (y+blur rise), upper-center-left, the inline number in accent-tinted mono counting up fast to land ON the bar line — asymmetric 60/40 against the ghost numeral, 3 depth layers.
Scene 3 (2.0–5.0s): line condenses up 12%; stem "what did they" holds while the tail token hard-cut cycles on bar lines — "build?" → "spend?" → "break?" — each swap ticks the ghost numeral's opacity 2% brighter (the data pulses with the question).
Scene 4 (5.0–6.0s): "break?" flips accent green; all else dims 20%; held read, grain only.

## Frame 2 — Problem: six platforms, zero visibility

- type: pain_point
- scene: Platform wordmarks snap onto a strict grid with hairline connector lines trying (and failing) to link them; the lattice overloads, snaps to black, payoff line lands.
- duration: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/02-problem.html
- blueprint: grid-card-assemble (Adapt)
- asset_candidates: none (typographic tiles)
- focal: the payoff line
- roles: none (typographic tiles)
- sfx: whoosh per wave, glitch on overload, sub-drop on the cut

Adapt: keep the staggered-cascade signature; upgrade tiles to bordered mono chips (1px hairline, 2px corner ticks) on an explicit 3×2 grid, and add SVG hairline connectors that DRAW between chips then overload — the failure of connection IS the visual argument.
Scene 1 (0.0–2.0s): six bordered mono chips snap onto a 3×2 grid one per beat (scale+blur snap, staggered) — "claude code / codex / openclaw / hermes / vertex / cloudflare" — centered lattice ~64% width; each chip lands with a corner-tick draw.
Scene 2 (2.0–4.0s): hairline SVG connectors attempt to draw between every chip pair (staggered stroke-dashoffset draws at 40% opacity) — the lattice becomes a tangle; two connectors glitch-flicker (2-frame opacity stutters, deterministic); chips dim as the tangle brightens.
Scene 3 (4.0–4.5s): overload snap — everything cuts to black on the sub-drop. One full beat of nothing (ground system only).
Scene 4 (4.5–7.0s): "six platforms." per-word slam, then "zero visibility." on the next bar — "zero" in accent green with a 1px accent underline that draws left-to-right; Centered ~50%; held read.

## Frame 3 — Reveal: AnveInspect

- type: product_intro
- scene: Wordmark assembles from scattered letters; tagline types; the REAL dashboard rises and docks in perspective with a floor reflection and accent glow.
- duration: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/03-reveal.html
- blueprint: logo-assemble-lockup (Reproduce)
- asset_candidates: view-overview.png
- focal: view-overview.png
- roles: view-overview = supporting (docks lower two-thirds) · wordmark = cutout
- sfx: riser into the pop, soft dock thud

Scene 1 (0.0–1.5s): letters of "anveinspect" fly in from a shallow 3D scatter (per-letter z/rotation variance, deterministic) and lock into the wordmark center; the green pulse-dot blooms at its left on the settle (the film's one sanctioned overshoot). Kicker "/ 03 — THE CONTROL PLANE".
Scene 2 (1.5–3.0s): "every agent. one control plane." types on with a green block caret; caret blinks twice, parks.
Scene 3 (3.0–5.0s): the REAL dashboard (view-overview.png) rises from the bottom edge and docks lower-two-thirds at 7° rotationX inside a perspective wrapper — WITH a faint floor reflection (mirrored copy, -y, 8% opacity, gradient mask) and a 1px accent border glow that traces the card perimeter as it seats; lockup+tagline scale to 0.55 and yield the upper third. 4 depth layers (glow / reflection / UI card / lockup).
Scene 4 (5.0–7.0s): accent glow blooms behind the docked UI and settles; held read, glow jitter only.

## Frame 4 — Proof 1: the whole fleet, counted

- type: feature_showcase
- scene: Slow push into the real UI; three PROPER stat cards land left-to-right — each a bordered panel with a count-up numeral and an accent bar-fill underline.
- duration: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/04-inventory.html
- blueprint: dataviz-countup (Adapt)
- asset_candidates: view-overview.png
- focal: the three stat cards
- roles: view-overview = background (full-bleed, dim ~50%)
- sfx: tick per landing, low pulse

Adapt: count-up signature + push kept; naked numerals upgraded to stat cards — dark elevated panel, 1px hairline, corner ticks, mono label, display numeral, and a 2px accent bar that FILLS under the number as it counts (stat-bars-and-fills rule).
Scene 1 (0.0–1.5s): view-overview.png full-bleed dimmed ~50% behind the ground glow, slow push-in running all frame; kicker "/ 04 — INVENTORY" + hairline underline draw.
Scene 2 (1.5–3.5s): stat card 1 snaps in center-left (y+blur) — "146" counts up, label "AGENTS", accent bar fills 0→100% with the count; card 2 "4 / PLATFORMS" one bar later, same treatment.
Scene 3 (3.5–5.5s): card 3 "$9.3k / EST. 30-DAY SPEND" lands center-right; on its final tick the "$" flashes accent and all three bars pulse once in sync — the row reads as one instrument panel.
Scene 4 (5.5–7.0s): sub-line "every agent. every platform. every dollar." per-word reveals beneath the row; stillness.

## Frame 5 — Proof 2: the living lineage graph (hero)

- type: feature_showcase
- scene: A NATIVE animated network graph builds itself — hub node pulses alive, 12 spoke nodes spring in, edges DRAW with weight, the 1,061× edge counts up — then the real UI screenshot crossfades in beneath as proof it ships.
- duration: 9s
- transition_in: crossfade
- status: animated
- src: compositions/frames/05-lineage.html
- blueprint: constellation-hub (Adapt)
- asset_candidates: view-lineage.png
- focal: the animated graph
- roles: view-lineage = supporting (proof crossfade in the final 2s, dimmed ~70% behind the graph) · graph = cutout
- sfx: soft pop per node, airy riser across the build, deep resolve on the 1,061× land

Adapt: constellation-hub's ring-assemble + center-resolve signature, cast as the product's real lineage graph. Build it as inline SVG: hub node "voice-forms" center; 12 satellite nodes at organic ring positions (workflow-subagent large upper-left, Content Creator right, general-purpose left, SEO Specialist lower-right, Explore, Technical Writer, Growth Hacker, UI Designer, Frontend Developer, Code Reviewer, Senior Developer, Plan — sizes vary by weight); edges are hairlines that DRAW outward (stroke-dashoffset) with width ∝ weight; arrowheads land last.
Scene 1 (0.0–1.5s): ground only; the hub node blooms center (accent ring + green fill pulse, SVG self-draw ring) with mono label "voice-forms"; kicker "/ 05 — LINEAGE".
Scene 2 (1.5–4.0s): satellites spring in around the ring in three staggered waves (scale+blur pops, node size by real run volume); each node's edge draws hub→node as it lands; the heaviest edge (→ workflow-subagent) draws THICK and its "1,061×" mono label counts up beside it, landing in accent green on the bar line.
Scene 3 (4.0–6.0s): a slow zoom-to-target push toward the hub begins; pill callout "who spawns whom" springs beside it; secondary weights fade in on three more edges ("94×", "82×", "39×") at 60% opacity.
Scene 4 (6.0–7.5s): the REAL view-lineage.png crossfades in dimmed BEHIND the animated graph (the drawn graph aligns conceptually over the product's own) — pill "this is a real screen · 22 agents · 21 relationships" rises lower-right.
Scene 5 (7.5–9.0s): held read — the longest in the film; grain and the hub's slow pulse only.

## Frame 6 — Proof 3: the insight

- type: benefit_highlight
- scene: A giant accent ring SWEEPS closed to 80% while the numeral counts up inside it; the two support lines land beside it; held read.
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/06-insight.html
- blueprint: dataviz-countup (Adapt)
- asset_candidates: none (pure type + SVG ring)
- focal: the ring + 80%
- roles: none
- sfx: deep hit on the ring close, soft tick per line

Adapt: count-up-ring signature from dataviz-countup — the ring IS the argument (80% of a circle visibly missing its fifth).
Scene 1 (0.0–1.8s): ground; a 560px SVG progress ring sweeps from 0 to 288° (80%) center-left (stroke-dashoffset, power3, 4px accent stroke over a 1px dim track) while "80%" counts up inside it (display 900, accent green, tabular; number ≈ 30% frame height). Kicker "/ 06 — THE INSIGHT". The missing 72° arc reads as the point.
Scene 2 (1.8–3.2s): right of the ring, "of your agent runs" per-word rises (y+blur), ink white mono, asymmetric 45/55 — sized to fit its column.
Scene 3 (3.2–4.6s): "are agents spawning agents." lands beneath it on the bar (x-snap per word, expo) — sized to fit its column, never touching the ring, never wider than its column.
Scene 4 (4.6–6.0s): dim sub-line "you'd never know without the graph." fades at the column's base; deliberate held read, ring's stroke shimmer only (one finite low-amp pass).

## Frame 7 — Proof 4: silent-failure paging

- type: feature_showcase
- scene: A flatlining EKG hairline runs across the frame; when it flatlines, the macOS alert card slides in and the pager lines land; red pulse once.
- duration: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/07-paging.html
- blueprint: titlecard-reveal (Adapt)
- asset_candidates: none (alert card rebuilt clean)
- focal: the alert card
- roles: alert card = cutout
- sfx: notification ding, low tension pad, single heartbeat thump at the flatline

Adapt: single-restrained-move signature kept (the card's arrival); an EKG metaphor supplies the missing tension — the agent's heartbeat stopping IS the story.
Scene 1 (0.0–2.0s): a 1px dim heartbeat line draws left-to-right across the lower third (SVG path: three healthy pulse peaks, then FLAT — stroke-dashoffset draw timed so the flatline lands on the bar at 2.0s); mono timestamps "03:00 · 03:15 · 03:30" tick past above it at 30% opacity. Kicker "/ 07 — THE PAGER".
Scene 2 (2.0–3.5s): on the flatline beat, the rebuilt macOS notification card slide-up-crossfades from the top-right — green app dot, mono title "AnveInspect — MISSED WINDOW", body "nightly-agent missed daily 03:00 — 8h overdue" ("8h overdue" amber); a red hairline pulses ONCE under its title.
Scene 3 (3.5–5.5s): three pager lines per-word reveal lower-left on successive bars — "your 3am agent didn't run." (dim) / "you got paged." (ink 900, largest) / "nobody else noticed." (dim).
Scene 4 (5.5–7.0s): held read; only the card's app dot pulses slowly (live SVG internals).

## Frame 8 — Zero instrumentation

- type: benefit_highlight
- scene: Three full-screen beats slam and are replaced; they collapse into a checklist while a dim terminal-log column scrolls behind; the one-liner types beside.
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/08-zeroinstall.html
- blueprint: kinetic-type-beats (Adapt)
- asset_candidates: none (pure type)
- focal: the checklist payoff
- roles: none
- sfx: tick per beat, soft resolve chord

Adapt: beat-slam signature kept; add the product's texture — a dim vertical column of mono log lines ("~/.claude/projects/…jsonl", "scan: 1,512 runs", "spawn edge …") scrolling VERY slowly at 8% opacity behind everything (the logs it reads are literally the backdrop).
Scene 1 (0.0–3.0s): full-screen beats — "no SDK." / "no API keys." / "no code changes." — each slams alone at center on a bar (distinct entrances: scale-blur / x-snap / rise-rotate), hard-cut replacing the last; the log column drifts behind.
Scene 2 (3.0–4.5s): scale-swap into a left-of-center checklist; three accent ticks SVG-self-draw staggered; each row brightens as its tick completes.
Scene 3 (4.5–6.0s): right column: "it reads the logs your agents already write." types on with caret; 40/60 split with a 1px divider; held settle.

## Frame 9 — CTA / brand outro

- type: cta
- scene: The progress rail completes to 100%; terminal types the command; return flashes; response prints; the wordmark seals it.
- duration: 6s
- transition_in: crossfade
- status: animated
- src: compositions/frames/09-cta.html
- blueprint: typewriter-reveal (Reproduce)
- asset_candidates: none (terminal rebuilt)
- focal: the typed command
- roles: terminal card = cutout · wordmark = supporting
- sfx: keyboard clicks, confident hit on return, low resolve tail

Scene 1 (0.0–1.0s): terminal card fades up center (elevated surface, hairline border, three window dots, corner ticks); wordmark + pulse-dot parked above; THE PROGRESS RAIL animates its final segment 8/9 → 9/9 across this frame.
Scene 2 (1.0–3.5s): "$ npx anveinspect doctor" types char-by-char behind the block caret (deterministic jitter, word pauses).
Scene 3 (3.5–4.5s): return flash — border pulses accent green; response prints instantly: "✓ 146 agents · 4 platforms · fleet ready".
Scene 4 (4.5–6.0s): "see every agent you run." per-word reveals beneath in display 900 ("every agent" accent); the rail completes and flashes accent once at 5.5s; quiet fade-to-black settle (final frame — the one sanctioned exit).
