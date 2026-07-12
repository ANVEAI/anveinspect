---
description: AI fleet briefing — what changed, what's risky, what to do
---

Deliver an intelligent fleet briefing. You are the analysis layer; the tools are the facts.

1. Call `fleet_report` (the AI-ready bundle). If data seems stale, `fleet_scan` first.
2. Write the briefing in this order, but only sections that have content:
   - **Headline** — one sentence: the single most important thing right now.
   - **Needs action** — open alerts + unwatched scheduled agents, each with the concrete next step (ack id, or the exact `fleet_declare_cadence` call using the inferred suggestions).
   - **Trend read** — interpret the week-over-week token delta and top-agent shares: what got expensive, what changed, whether it correlates with failures.
   - **Hygiene** — stale agents (frame as "retire or revive?" questions), basename-identity agents worth connecting to git remotes, tokens-unavailable data gaps.
3. Recommendations must be specific and executable, never generic advice. Quote real numbers from the report; never invent any.
4. Inferred cadence suggestions are proposals for the USER — offer to declare them, never declare unasked.
