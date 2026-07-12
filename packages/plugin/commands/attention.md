---
description: Triage — everything in the fleet that needs action, with ack ids
---

1. Call `fleet_check` to evaluate cadences and token spikes right now.
2. Call `fleet_attention` and present each item: alerts first (with ack id), then stale/failed agents with reasons.
3. For each item, offer the concrete next step: acknowledge (`fleet_ack`), inspect (`fleet_agent_detail`), or declare/adjust a cadence.
4. If nothing needs attention, say so in one line — do not pad.
