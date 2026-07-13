<!-- Thanks for contributing! Keep PRs focused; a fix and a refactor are two PRs. -->

## What & why

<!-- What does this change do, and what user-visible effect does it have?
     Describe the outcome, not just the diff. -->

## How it was verified

<!-- Tick what you ran. Every bug fix lands with a regression test. -->

- [ ] `npm run typecheck` is clean
- [ ] `npm test` is green (added/updated tests for this change)
- [ ] If dashboard-observable, verified in a browser
- [ ] Data-honesty preserved (no invented numbers; unavailable ≠ zero)
- [ ] Watchdog stays safe (guarded parses, clamped external numbers, fails safe)
- [ ] Connectors remain read-only / catalog-only; no credentials leave `~/.anveinspect/`

## Notes for reviewers

<!-- Anything non-obvious: trade-offs, follow-ups, screenshots. -->
