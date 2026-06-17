# pi-raft

Workflow enforcement extension for pi agents operating in slock. Intercepts bash
calls, validates raft command sequences against a 5-state workflow machine, and
blocks violations before they reach slock.

## Install

```bash
pi install ./pi-raft
```

## What it does

pi-raft enforces slock workflow discipline at the tool level:

- Blocks file writes before `raft message read` and `raft task claim`
- Blocks chained raft commands (`&&`, `;` in single bash call)
- Scans outgoing messages for credential patterns
- Injects current workflow state into every agent turn
- Persists state across compactions via `pi.appendEntry()`

## Architecture

Two layers:

| Layer | Format | Role |
|-------|--------|------|
| Extension (`extensions/index.ts`) | TypeScript, hooks into pi lifecycle | Runtime enforcement |
| Skill (`skills/pi-raft/SKILL.md`) | Markdown reference | Workflow documentation for the agent |

See [Design Document](docs/design/pi-raft-design.md) for full architecture and state machine.
