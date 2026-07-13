---
format: 1920x1080
message: "See every AI agent you run — and get paged when one silently stops"
arc: Hook → Problem → Reveal → Proof (inventory → lineage → insight → paging) → Zero-setup → CTA
audience: developers running AI coding agents (X / HN / r/LocalLLaMA)
mode: autonomous
music: dark pulsing electronic, minimal techno undertone, 118bpm, tension building to a confident resolve — think dev-tool launch film
---

## Video direction

- **palette system** — frame.md is truth: ink-black canvas register throughout (#0a0d12 family), text in the off-white ink, ONE accent = brand green (#3ecf8e) reserved for the payoff word / stat / pulse-dot of each frame; amber and red appear ONLY inside the alert frame (7) as semantic colors. No gradients as decoration; flat planes + 1px hairlines.
- **type system** — display = the pack's massive lowercase 900 register for hero lines; mono = chrome, labels, counters, terminal (tabular-nums on all counting numbers).
- **motion grammar** — this is a SILENT music-driven piece: reveals pace to the 118bpm grid (beat ≈ 0.51s, bar ≈ 2.03s) instead of VO cues; each frame's reveals land on bar lines and spread into the back half — never front-load. Long-tail `power3` settles everywhere; overshoot only on frame 3's wordmark pop. Camera work is rare and single-purpose: one slow push per UI frame, nothing else drifts.
- **rhythm / held frames** — frames 6 (the 80% stat) and 7 (the alert) end in deliberate held reads (≥1.2s of stillness, subtle jitter at most) — the breathers before/after the climax. Frames 1, 2, 8 are percussive; 5 is the long cinematic hold.
- **negative list** — no purple-blue "AI" gradients, no bokeh, no floating decorative shapes, no browser chrome except the rebuilt alert/terminal cards, no lazy breathing loops, no slideshow (front-load-freeze) and no screensaver (everything drifting).

## Frame 1 — Hook: the question you can't answer

- type: hook
- scene: Massive lowercase 900 type on ink-black — "your AI agents ran 1,512 times this month." then the accent word swaps in place on beats — "built? / spent? / broke?"
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/01-hook.html
- blueprint: kinetic-type-beats (Reproduce)
- asset_candidates: none (pure type)
- focal: the swapping word
- roles: none (pure type)
- sfx: deep impact on t=0, soft tick on each word swap

Scene 1 (0.0–1.0s): ink-black ground; "your AI agents ran" lands per-word staggered reveal, upper-center, display 900 lowercase — Centered, ~55% width, single depth layer.
Scene 2 (1.0–2.0s): "1,512 times this month." kinetic beat-slam onto the next line, the number in mono tabular with a fast value-scaled counter finishing at 1,512 on the bar line; number carries size hierarchy 3:1 over the sentence.
Scene 3 (2.0–5.0s): line condenses upward to make room; below it a fixed stem "what did they" holds while the tail token cycles in-place on bar lines — "build?" → "spend?" → "break?" — hard-cut word-swaps, each swap a tick.
Scene 4 (5.0–6.0s): "break?" holds and flips to the accent green; everything else dims 20%; held read, subtle jitter only.

Cold open, no logo. The stat is real (this fleet's 30-day runs). The word-swap IS the motion.

## Frame 2 — Problem: five platforms, zero visibility

- type: pain_point
- scene: Platform names stack in a staggered cascade until crowded, then cut to black and one line — "six platforms. zero visibility."
- duration: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/02-problem.html
- blueprint: grid-card-assemble (Adapt)
- asset_candidates: none (typographic tiles)
- focal: the payoff line
- roles: none (typographic tiles)
- sfx: soft whoosh per cascade wave, sub-drop on the cut to black

Adapt: keep the staggered-cascade signature; tiles are bare mono wordmarks (no card chrome), and the zoom-OUT reveal becomes a hard cut to black — accumulation ends in erasure, not vastness.
Scene 1 (0.0–2.0s): mono tiles cascade in waves onto a loose grid — "claude code" / "codex" / "openclaw" / "hermes" — staggered, each wave a beat; asymmetric spread filling ~70% of the safe area, 2 depth layers (older tiles dim as new arrive).
Scene 2 (2.0–4.0s): density builds — "vertex" / "cloudflare" plus dim ghost duplicates multiply behind (crowding = the argument); slight camera pull-back underneath makes the field feel larger than the frame.
Scene 3 (4.0–4.5s): hard cut to empty ink-black (sub-drop lands here). One full beat of nothing.
Scene 4 (4.5–7.0s): "six platforms." per-word reveal, then "zero visibility." lands on the next bar with "zero" in accent green; Centered, ~50% width; held read.

## Frame 3 — Reveal: AnveInspect

- type: product_intro
- scene: Wordmark assembles center, tagline types under it, then the REAL dashboard slides up and docks, slightly 3D-tilted.
- duration: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/03-reveal.html
- blueprint: logo-assemble-lockup (Reproduce)
- asset_candidates: view-overview.png
- focal: view-overview.png
- roles: view-overview = supporting (docks lower two-thirds) · wordmark = cutout
- sfx: riser into the wordmark pop, soft dock thud when the UI seats

Scene 1 (0.0–1.5s): letters of "anveinspect" cascade into the lockup at center (letter-by-letter staggered assemble), the green pulse-dot blooms alive at the wordmark's left on the settle — Centered, ~40% width; spring-pop settle (the one sanctioned overshoot).
Scene 2 (1.5–3.0s): under it, "every agent. one control plane." type-on with caret in mono; caret blinks twice then parks.
Scene 3 (3.0–5.0s): the REAL dashboard (view-overview.png) slides up from the bottom edge and docks in the lower two-thirds with a gentle 6° rotationX tilt; lockup + tagline scale down and yield the upper third — layered-depth, 3 layers (glow ground / UI card / lockup).
Scene 4 (5.0–7.0s): a faint accent glow blooms behind the docked UI; held read with subtle jitter on the glow only.

First product pixels must be the real UI — credibility beat.

## Frame 4 — Proof 1: the whole fleet, counted

- type: feature_showcase
- scene: Slow push INTO the real overview UI while three hero counters count up — 146 agents · 4 platforms · $9.3k/30d.
- duration: 7s
- transition_in: cut
- status: animated
- src: compositions/frames/04-inventory.html
- blueprint: dataviz-countup (Adapt)
- asset_candidates: view-overview.png
- focal: the three counters
- roles: view-overview = background (full-bleed, dim ~45%)
- sfx: tick per counter landing, low pulse underneath

Adapt: keep the count-up signature + push; the "camera lands on one hero metric" becomes three metrics landing left-to-right on successive bars (an inventory is a set, not a single number).
Scene 1 (0.0–1.5s): view-overview.png full-bleed, dimmed ~45%, slow push-in begins (runs the whole frame); mono label "inventory" wipes in upper-left with a hairline underline.
Scene 2 (1.5–3.5s): first counter "146" value-scaled counts up dead-center-left with unit "agents" in mono under it; second counter "4 platforms" lands one bar later center; both tabular-nums, display-size hierarchy over the dimmed UI.
Scene 3 (3.5–5.5s): third counter "$9.3k" counts up center-right, unit "est. 30-day spend"; its final tick lands with the accent green flash on the "$"; triptych now reads as one row.
Scene 4 (5.5–7.0s): counters hold; sub-line reveals beneath on the last bar — "every agent. every platform. every dollar." — then stillness.

Real numbers from a real fleet — the counters match the UI behind them.

## Frame 5 — Proof 2: the lineage graph (hero shot)

- type: feature_showcase
- scene: The real lineage view fills the frame; slow cinematic push toward the graph hub; callouts spring in sequence.
- duration: 9s
- transition_in: crossfade
- status: animated
- src: compositions/frames/05-lineage.html
- blueprint: device-surface-showcase (Adapt — floating-window push)
- asset_candidates: view-lineage.png
- focal: the relationship graph region of view-lineage.png
- roles: view-lineage = background (full-bleed hero, vignette dims edges ~35%)
- sfx: airy riser across the push, soft pop per callout

Adapt: keep the continuous-push signature; the "screens cycle" becomes callouts cycling over ONE screen (the graph is the flow).
Scene 1 (0.0–2.0s): view-lineage.png full-bleed; zoom-to-target begins toward the graph hub (upper-center region) — slow, single, continuous for the whole frame; vignette darkens edges to focus.
Scene 2 (2.0–4.0s): callout pill 1 springs in beside the hub — "who spawns whom" — mono, hairline connector to the hub node.
Scene 3 (4.0–6.0s): callout 2 lands on the heaviest edge — "1,061× spawns" with the count in accent green; callout 1 dims to 60%.
Scene 4 (6.0–7.5s): callout 3 lower-right — "22 agents · 21 relationships" — as the push settles at ~1.35x.
Scene 5 (7.5–9.0s): callouts hold; the graph reads; stillness (this is the longest held read in the video).

THE shot — nobody else renders an agent org-chart.

## Frame 6 — Proof 3: the insight

- type: benefit_highlight
- scene: Black frame; one stat builds in beats — "80%" → "of your agent runs" → "are agents spawning agents."
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/06-insight.html
- blueprint: kinetic-type-beats (Reproduce)
- asset_candidates: none (pure type)
- focal: the 80% figure
- roles: none (pure type)
- sfx: deep single hit on "80%", soft tick per line

Scene 1 (0.0–1.5s): empty ink-black for half a beat, then "80%" slams in dead-center in accent green, display 900 at maximum scale (value-scaled counter 0→80 compressed into ~0.6s) — Centered, number ≥ 45% of frame height.
Scene 2 (1.5–3.0s): "of your agent runs" per-word reveals beneath in ink white, mono; the 80% yields ~15% scale to make the pair read.
Scene 3 (3.0–4.5s): "are agents spawning agents." lands on the next bar, same register; hierarchy stays 3:1 number-over-text.
Scene 4 (4.5–6.0s): quiet sub-line in dim mono reveals at the bottom-third boundary — "you'd never know without the graph." — held read, subtle jitter only.

The finding that makes people screenshot the video. Real number (1,196 of 1,510 runs).

## Frame 7 — Proof 4: silent-failure paging

- type: feature_showcase
- scene: A rebuilt alert card slides in — "[MISSED WINDOW] nightly-agent missed daily 03:00 — 8h overdue" — with macOS notification chrome; type lands beneath.
- duration: 7s
- transition_in: crossfade
- status: animated
- src: compositions/frames/07-paging.html
- blueprint: titlecard-reveal (Adapt)
- asset_candidates: view-attention.png (reference only; card is rebuilt clean)
- focal: the alert card
- roles: view-attention = supporting (unused on screen; visual reference for the worker) · alert card = cutout
- sfx: notification ding (soft), low tension pad

Adapt: keep the one-clean-card + single-restrained-move signature; the card is a rebuilt macOS notification, and the wipe becomes a top-edge slide-in (how notifications actually arrive).
Scene 1 (0.0–1.5s): ink-black with a faint amber tension glow lower-left; a macOS-style notification card slide-up-crossfades in from the top-right corner — rounded card, app dot, mono title "AnveInspect — MISSED WINDOW", body "nightly-agent missed daily 03:00 — 8h overdue" with "8h overdue" in amber — rule-of-thirds upper-right, card ~38% width.
Scene 2 (1.5–3.5s): the card settles; a red hairline pulses once under the title (the semantic accent, used only here).
Scene 3 (3.5–5.5s): beneath and left, three short lines per-word reveal on successive bars — "your 3am agent didn't run." / "you got paged." / "nobody else noticed." — with "you got paged." in ink-white 900 and the others dim.
Scene 4 (5.5–7.0s): held read; the card's app dot keeps a slow pulse (live SVG internals — the subject doing something), everything else still.

The wedge feature: agents fail silently — AnveInspect is the pager.

## Frame 8 — Zero instrumentation

- type: benefit_highlight
- scene: Three beats of type replacing each other — "no SDK." / "no API keys." / "no code changes." — then a stacked checklist + one line.
- duration: 6s
- transition_in: cut
- status: animated
- src: compositions/frames/08-zeroinstall.html
- blueprint: kinetic-type-beats (Reproduce)
- asset_candidates: none (pure type)
- focal: the checklist payoff
- roles: none (pure type)
- sfx: tick per beat, soft resolve chord into the checklist

Scene 1 (0.0–3.0s): full-screen beats — "no SDK." / "no API keys." / "no code changes." — each slams in alone at center on a bar line (kinetic beat-slam), hard-cut replacing the last; display 900 lowercase, ~60% width.
Scene 2 (3.0–4.5s): the three lines scale-swap into a small stacked checklist left-of-center, each gaining a green check tick (SVG self-draw, staggered).
Scene 3 (4.5–6.0s): right of the stack, "it reads the logs your agents already write." type-on with caret in mono, asymmetric 40/60; held read on the settle.

Kills the adoption objection in six seconds.

## Frame 9 — CTA / brand outro

- type: cta
- scene: Terminal prompt types "npx anveinspect doctor"; return-flash; wordmark settles above; final line holds.
- duration: 6s
- transition_in: crossfade
- status: animated
- src: compositions/frames/09-cta.html
- blueprint: typewriter-reveal (Reproduce)
- asset_candidates: none (terminal chrome rebuilt)
- focal: the typed command
- roles: terminal card = cutout · wordmark = supporting
- sfx: keyboard clicks under the typing, single confident hit on return, low resolve tail

Scene 1 (0.0–1.0s): a minimal terminal card fades up center (dark elevated surface, hairline border, three dim window dots) — Centered, ~55% width; wordmark "anveinspect" + green pulse-dot already parked small above it.
Scene 2 (1.0–3.5s): "$ npx anveinspect doctor" types character-by-character behind a blinking caret (type-on with caret; keyboard clicks); camera-cursor framing stays static — the typing is the motion.
Scene 3 (3.5–4.5s): return-key flash — the card border flashes accent green once, and a mono response line prints instantly: "✓ 146 agents · 4 platforms · fleet ready".
Scene 4 (4.5–6.0s): beneath the card, "see every agent you run." per-word reveals in display 900; the pulse-dot keeps its slow pulse; held read to black.

One command is the CTA — the product's own 30-second promise.
