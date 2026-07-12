---
description: Declare when an agent is expected to run so missed windows alert
argument-hint: <agent-name> "<expect e.g. daily 03:00>" [grace-minutes]
---

Declare a cadence for the agent the user names (arguments: $ARGUMENTS).

1. If the agent name is ambiguous or missing, list candidates via `fleet_agents` (include_subagents=false) and ask.
2. Parse the user's schedule into the cadence grammar: "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", or "every Nh". Confirm your interpretation in one line before declaring.
3. Call `fleet_declare_cadence` with a grace period matching the user's tolerance (default 60 minutes).
4. Call `fleet_check` immediately and report whether the agent is currently within or already past its window.
