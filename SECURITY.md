# Security Policy

AnveInspect is **local-first by design**: it reads transcripts your agents already
wrote, stores everything in a SQLite file under `~/.anveinspect/`, and serves its
dashboard on loopback only. That design is the first line of defense — but if you
find a way to break it, we want to hear from you.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via GitHub Security Advisories
([Report a vulnerability](https://github.com/ANVEAI/anveinspect/security/advisories/new)),
or email the maintainers. Include:

- a description of the issue and its impact,
- steps to reproduce (a minimal transcript / config / request if relevant),
- the version / commit and your OS + Node version.

We aim to acknowledge within 72 hours and to ship a fix or mitigation for confirmed
issues promptly. We'll credit you in the advisory unless you prefer to stay anonymous.

## Scope — what we treat as a vulnerability

- Any path that lets an **untrusted transcript** crash, hang, or achieve code
  execution in the collector (it is a watchdog; it must survive hostile input).
- Any code path that **mutates a remote platform** — connectors are strictly
  read-only / catalog-only.
- Any path that **exfiltrates** a transcript, credential, or fleet data off-box,
  or writes credentials anywhere but `~/.anveinspect/` (mode 0600).
- Reaching the dashboard's state-changing endpoints **cross-origin** or from
  **off the loopback interface**.
- Leaking secrets into logs, the fleet database, or error messages.

## Hardening already in place

- Dashboard binds to `127.0.0.1` only; state-changing `POST`s require a same-origin
  check and are body-size-capped.
- Connector credentials live client-side in `~/.anveinspect/connectors.json`
  (0600) and never enter the fleet database.
- The scanner guards every parse, clamps external numbers, and fails safe on
  corrupt / truncated / hostile files (enforced by fuzz + scale tests).
- Cadence grammar is bounds-checked so a declared watchdog can't be silently
  disabled by a degenerate interval.

## Supported versions

AnveInspect is pre-1.0; security fixes land on `main` and the latest published
release. Please test against `main` before reporting.
